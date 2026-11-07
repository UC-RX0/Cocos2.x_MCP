'use strict';

/**
 * 序列化文档（.fire / .prefab）的**完整性校验** —— 纯逻辑，不碰 fs、不碰 Editor。
 *
 * 为什么单独一层：v0.4.x 之前每个写工具各自 load → 改 → 整文件落盘，
 * 校验散落在各处（有的查外部引用、有的查 PrefabInfo）。批量改的时候
 * 更需要一个"提交前统一体检"的地方：先全量应用，再一次性验证，通过才落盘。
 *
 * 这里只管**引用完整性**（能不能被引擎安全反序列化），不管业务正确性
 * （比如"这个按钮有没有绑事件"）。
 *
 * 依赖注入：ctx 传 { validatePrefab }（lib/prefab.js 的校验器），
 * 因为 lib 模块之间不互相 require。
 */

var ctx = {
    validatePrefab: function () { return []; }
};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

/**
 * 校验一个序列化数组。
 *
 * kind = 'prefab' 时额外走预制体那套（每个节点必须有 PrefabInfo、fileId 唯一…）。
 * kind = 'scene' 时重点查父子互指和 __id__ 范围。
 *
 * 返回 problems[]（空数组 = 通过）。
 */
function validateDocArray(arr, kind) {
    var problems = [];

    if (!Array.isArray(arr)) return ['顶层不是数组（Cocos 序列化格式要求是数组）'];
    if (!arr.length) return ['空数组'];

    // 1) 所有 __id__ 引用必须落在数组范围内
    for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o || typeof o !== 'object') continue;
        (function scan(obj, pathStr) {
            if (obj === null || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                for (var m = 0; m < obj.length; m++) scan(obj[m], pathStr + '[' + m + ']');
                return;
            }
            for (var k in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                var v = obj[k];
                if (v && typeof v === 'object' && typeof v.__id__ === 'number') {
                    if (v.__id__ < 0 || v.__id__ >= arr.length) {
                        problems.push('#' + i + '.' + pathStr + k + ' 指向 __id__=' + v.__id__ +
                            '，超出数组范围（0..' + (arr.length - 1) + '）');
                    }
                    continue;
                }
                scan(v, pathStr + k + '.');
            }
        })(o, '');
    }

    // 2) 父子互指：node._parent 指向的节点必须把 node 列在 _children 里，反之亦然
    for (var j = 0; j < arr.length; j++) {
        var node = arr[j];
        if (!node || node.__type__ !== 'cc.Node') continue;

        var parentId = node._parent && typeof node._parent.__id__ === 'number' ? node._parent.__id__ : null;
        if (parentId === null) continue;   // 根节点 / 场景里的游离节点

        var parent = arr[parentId];
        if (!parent) {
            problems.push('#' + j + '（' + (node._name || '?') + '）的 _parent 指向不存在的 #' + parentId);
            continue;
        }
        var kids = parent._children || [];
        var listed = false;
        for (var a = 0; a < kids.length; a++) {
            if (kids[a] && kids[a].__id__ === j) { listed = true; break; }
        }
        if (!listed) {
            problems.push('#' + j + '（' + (node._name || '?') + '）说自己的父节点是 #' + parentId +
                '（' + (parent._name || parent.__type__ || '?') + '），但对方的 _children 里没有它');
        }
    }

    for (var p = 0; p < arr.length; p++) {
        var pn = arr[p];
        if (!pn || (pn.__type__ !== 'cc.Node' && pn.__type__ !== 'cc.Scene')) continue;
        var kids2 = pn._children || [];
        for (var b = 0; b < kids2.length; b++) {
            var kidId = kids2[b] && kids2[b].__id__;
            var kid = arr[kidId];
            if (!kid) {
                problems.push('#' + p + ' 的 _children[' + b + '] 指向不存在的 #' + kidId);
                continue;
            }
            if (kid.__type__ !== 'cc.Node') {
                problems.push('#' + p + ' 的 _children[' + b + '] 指向 #' + kidId +
                    '（' + kid.__type__ + '），不是 cc.Node');
                continue;
            }
            var backId = kid._parent && typeof kid._parent.__id__ === 'number' ? kid._parent.__id__ : null;
            if (backId !== p) {
                problems.push('#' + p + ' 把 #' + kidId + '（' + (kid._name || '?') +
                    '）当子节点，但它的 _parent 是 #' + backId);
            }
        }
    }

    // 3) 预制体额外规则：每个节点必须有 PrefabInfo、fileId 唯一且根为空串
    if (kind === 'prefab') {
        var prefabProblems = ctx.validatePrefab(arr);
        for (var q = 0; q < prefabProblems.length; q++) {
            if (problems.indexOf(prefabProblems[q]) < 0) problems.push(prefabProblems[q]);
        }
    }

    if (problems.length > 25) {
        problems = problems.slice(0, 25).concat(['…还有 ' + (problems.length - 25) + ' 条']);
    }
    return problems;
}

/** 只比个数/类型，用于"这次操作有没有真的改动" */
function summarize(arr) {
    var nodes = 0, comps = 0;
    for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o) continue;
        if (o.__type__ === 'cc.Node') nodes++;
        else if (o.__type__ !== 'cc.Prefab' && o.__type__ !== 'cc.PrefabInfo' &&
                 o.__type__ !== 'cc.Scene' && o.__type__ !== 'cc.SceneAsset') comps++;
    }
    return { objects: arr.length, nodes: nodes, components: comps };
}

//#region 节点级差异（prefab_diff 的核心）

/**
 * 把序列化数组摊平成节点清单：路径 + 关键属性 + 组件类型列表。
 *
 * 路径用「从根往下拼名字」而不是 _id —— 因为预制体里节点的 _id 全是空串，
 * 只有场景才有稳定 id。名字重名时按出现次序加序号，保证一一对应。
 */
function collectNodes(arr) {
    var root = null;
    for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o || typeof o !== 'object') continue;
        if (o.__type__ === 'cc.Scene' || (o.__type__ === 'cc.Node' && !root)) {
            if (o.__type__ === 'cc.Scene') { root = i; break; }
            if (root === null) root = i;
        }
    }
    if (root === null) {
        for (var k = 0; k < arr.length; k++) {
            if (arr[k] && arr[k].__type__ === 'cc.Prefab' && arr[k].data && typeof arr[k].data.__id__ === 'number') {
                root = arr[k].data.__id__;
                break;
            }
        }
    }
    if (root === null) return { rootId: -1, nodes: [] };

    var out = [];
    var seen = {};

    (function walk(id, parentPath) {
        var n = arr[id];
        if (!n || (n.__type__ !== 'cc.Node' && n.__type__ !== 'cc.Scene')) return;
        var name = n._name || (n.__type__ === 'cc.Scene' ? '(scene)' : '(unnamed)');
        var here = parentPath ? (parentPath + '/' + name) : name;
        if (seen[here] === undefined) seen[here] = 1;
        else { seen[here]++; here = here + '#' + seen[here]; }

        out.push({
            id: id,
            path: here,
            name: name,
            active: n._active !== false,
            opacity: typeof n._opacity === 'number' ? n._opacity : 255,
            size: n._contentSize ? [n._contentSize.width, n._contentSize.height] : null,
            anchor: n._anchorPoint ? [n._anchorPoint.x, n._anchorPoint.y] : null,
            pos: readArr(n._trs, [0, 1, 2]),
            scale: readArr(n._trs, [7, 8, 9]),
            color: n._color ? [n._color.r, n._color.g, n._color.b] : null,
            components: componentTypes(arr, n),
            node: n
        });

        var kids = n._children || [];
        for (var c = 0; c < kids.length; c++) walk(kids[c].__id__, here);
    })(root, '');

    return { rootId: root, nodes: out };
}

function readArr(trs, idxs) {
    var a = trs && Array.isArray(trs.array) ? trs.array : null;
    if (!a) return null;
    return idxs.map(function (i) { return a[i] === undefined ? 0 : a[i]; });
}

/** 组件类型列表（脚本用压缩 uuid 前 8 位表示，稳定且可读） */
function componentTypes(arr, node) {
    var out = [];
    var comps = node._components || [];
    for (var i = 0; i < comps.length; i++) {
        var c = arr[comps[i].__id__];
        if (!c) continue;
        out.push(c.__type__ || '?');
    }
    out.sort();
    return out;
}

function sameArr(a, b, tol) {
    if (a === null || b === null) return a === b;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (Math.abs(a[i] - b[i]) > (tol || 0.001)) return false;
    }
    return true;
}

/**
 * 两份序列化数组的节点级差异。
 *
 * 匹配规则：先按路径；路径对不上的，再按 _id 找（场景里改名的节点会被认出来是「改名」，
 * 而不是「删一个 + 加一个」）。预制体里 _id 全是空串，就只会走路径匹配。
 */
function diffDocs(arrA, arrB) {
    var A = collectNodes(arrA);
    var B = collectNodes(arrB);

    var byPathB = {};
    B.nodes.forEach(function (n) { byPathB[n.path] = n; });

    var matchedB = {};
    var added = [];
    var removed = [];
    var changed = [];
    var renamed = [];

    // 先按路径配对
    A.nodes.forEach(function (a) {
        var b = byPathB[a.path];
        if (b && !matchedB[b.path]) {
            matchedB[b.path] = true;
            compareOne(a, b);
            return;
        }
        // 路径没配上：按 _id 找改名
        if (a.node._id) {
            var hit = null;
            for (var i = 0; i < B.nodes.length; i++) {
                var cand = B.nodes[i];
                if (!matchedB[cand.path] && cand.node._id === a.node._id) { hit = cand; break; }
            }
            if (hit) {
                matchedB[hit.path] = true;
                renamed.push({ from: a.path, to: hit.path, id: a.node._id });
                compareOne(a, hit);
                return;
            }
        }
        removed.push({ path: a.path, name: a.name, components: a.components.length });
    });

    B.nodes.forEach(function (b) {
        if (!matchedB[b.path]) added.push({ path: b.path, name: b.name, components: b.components.length });
    });

    function compareOne(a, b) {
        var fields = {};
        if (a.active !== b.active) fields.active = [a.active, b.active];
        if (a.opacity !== b.opacity) fields.opacity = [a.opacity, b.opacity];
        if (!sameArr(a.pos, b.pos)) fields.pos = [a.pos, b.pos];
        if (!sameArr(a.scale, b.scale)) fields.scale = [a.scale, b.scale];
        if (!sameArr(a.size, b.size)) fields.size = [a.size, b.size];
        if (!sameArr(a.anchor, b.anchor)) fields.anchor = [a.anchor, b.anchor];
        if (!sameArr(a.color, b.color, 0)) fields.color = [a.color, b.color];

        var ca = a.components.join(',');
        var cb = b.components.join(',');
        if (ca !== cb) {
            var onlyA = a.components.filter(function (t) { return b.components.indexOf(t) < 0; });
            var onlyB = b.components.filter(function (t) { return a.components.indexOf(t) < 0; });
            fields.components = { removed: onlyA, added: onlyB };
        }

        if (Object.keys(fields).length) {
            changed.push({ path: b.path, fields: fields });
        }
    }

    return {
        before: { nodes: A.nodes.length },
        after: { nodes: B.nodes.length },
        added: added,
        removed: removed,
        changed: changed,
        renamed: renamed,
        summary: {
            added: added.length,
            removed: removed.length,
            changed: changed.length,
            renamed: renamed.length,
            unchanged: A.nodes.length - changed.length - removed.length
        }
    };
}

//#endregion

module.exports = {
    setContext: setContext,
    validateDocArray: validateDocArray,
    summarize: summarize,
    collectNodes: collectNodes,
    diffDocs: diffDocs
};
