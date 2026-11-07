'use strict';

/**
 * .fire / .prefab 序列化文件的**只读**解析层。
 *
 * Cocos 的序列化格式：一维数组 + __id__ 下标引用。
 * 场景根一般在 0 或 1 号位（cc.SceneAsset.scene / cc.Prefab.data）。
 *
 * 这里只读不写。写盘在 main.js 的场景写入区，
 * 因为写要处理 __id__ 重映射和换行保持，涉及上下文更多。
 *
 * 依赖注入：ctx 传入 { readScriptInfo }（脚本类名反解要读源码）。
 */

const fs = require('fs');
const path = require('path');

/** 宿主注入的上下文 */
var ctx = {
    readScriptInfo: function () { return null; }
};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

function loadSerialized(absPath) {
    var raw = fs.readFileSync(absPath, 'utf8');
    var arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('不是 Cocos 序列化格式（顶层不是数组）');
    return arr;
}

/**
 * 定位「根对象」—— **全项目唯一一份实现**。
 *
 * .fire 的根是 cc.Scene；.prefab 没有 cc.Scene，根靠 `[0].cc.Prefab.data.__id__`。
 * 历史上这段逻辑有三份（这里的 findRootIndex、scene-tools 的 findSceneRootId、
 * 以及为支持预制体新加的 findRootForEdit），改一处忘两处是迟早的事 ——
 * 现在只剩这一个函数，另外两个是薄别名。
 *
 * 返回 { rootId, kind }：kind = 'scene' | 'prefab' | null
 */
function findRootForEdit(arr) {
    if (!Array.isArray(arr)) return { rootId: -1, kind: null };

    // 场景：根是 cc.Scene 对象本身（SceneAsset.scene 指向它）
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].__type__ === 'cc.Scene') return { rootId: i, kind: 'scene' };
    }
    for (var a = 0; a < arr.length; a++) {
        var sa = arr[a];
        if (sa && sa.__type__ === 'cc.SceneAsset' && sa.scene && typeof sa.scene.__id__ === 'number') {
            if (arr[sa.scene.__id__] && arr[sa.scene.__id__].__type__ === 'cc.Scene') {
                return { rootId: sa.scene.__id__, kind: 'scene' };
            }
        }
    }

    // 预制体：[0] 是 cc.Prefab，data.__id__ 指向根节点
    var head = arr[0];
    if (head && head.__type__ === 'cc.Prefab' && head.data && typeof head.data.__id__ === 'number') {
        var rid = head.data.__id__;
        if (arr[rid] && arr[rid].__type__ === 'cc.Node') return { rootId: rid, kind: 'prefab' };
    }

    // 兜底：没有头但数组里有游离节点（手拼的文件）
    for (var j = 0; j < arr.length; j++) {
        if (arr[j] && arr[j].__type__ === 'cc.Node' && !arr[j]._parent) return { rootId: j, kind: 'prefab' };
    }
    return { rootId: -1, kind: null };
}

/** 只要下标的老接口 —— 薄别名，不要再往里加逻辑 */
function findRootIndex(arr) {
    var r = findRootForEdit(arr);
    return r.rootId < 0 ? 0 : r.rootId;
}

/** 从 _trs 里取位置（格式是 [x,y,z, qx,qy,qz,qw, sx,sy,sz]） */
function readTRS(obj) {
    if (!obj || !obj._trs || !obj._trs.array) return null;
    var a = obj._trs.array;
    return { x: a[0], y: a[1], z: a[2] };
}

/**
 * 读节点的缩放。
 *
 * Cocos 的 _trs 是 **10 个元素**：
 *   [x, y, z, qx, qy, qz, qw, scaleX, scaleY, scaleZ]
 * （之前这里写的是 a.length < 11，永远不成立 → 缩放和旋转一直是 null）
 */
function readScaleTRS(obj) {
    if (!obj || !obj._trs || !obj._trs.array) return null;
    var a = obj._trs.array;
    if (a.length < 10) return null;
    return { x: a[7], y: a[8], z: a[9] };
}

function readRotationTRS(obj) {
    if (!obj || !obj._trs || !obj._trs.array) return null;
    var a = obj._trs.array;
    if (a.length < 10) return null;
    // 四元数转欧拉角没必要做，直接给 z 轴角度近似够 AI 判断
    var qz = a[5], qw = a[6];
    var angle = 2 * Math.atan2(qz, qw) * 180 / Math.PI;
    return Math.round(angle * 1000) / 1000;
}

/** 组件类型 → 脚本信息（压缩 uuid 反解） */
function describeComponentType(typeStr, idx) {
    var t = String(typeStr);
    if (t.indexOf('cc.') === 0) {
        return { isScript: false, script: null, className: null };
    }
    var fullUuid = idx.byShort[t] || null;
    var rel = fullUuid ? idx.byFull[fullUuid] : null;
    var info = rel ? ctx.readScriptInfo(rel) : null;
    return {
        isScript: true,
        uuid: fullUuid,
        script: rel,
        className: info ? info.className : null,
        resolved: !!rel
    };
}

/**
 * 给定图片路径，找它的 sprite-frame uuid。
 * 找不到就返回 null（让调用方知道得手工查）。
 */
function findSpriteFrameUuidFor(idx, assetRel) {
    if (!idx || !assetRel) return null;
    // 在索引里找同一个路径下、类型是 sprite-frame 的那个
    var candidates = [];
    for (var u in idx.byFull) {
        if (!Object.prototype.hasOwnProperty.call(idx.byFull, u)) continue;
        if (idx.byFull[u] !== assetRel) continue;
        if (idx.byKind && idx.byKind[u] === 'sprite-frame') candidates.push(u);
    }
    return candidates.length ? candidates[0] : null;
}

/** 递归展开节点树 */
function expandNode(arr, id, depth, maxDepth, idx) {
    if (depth > maxDepth) return { truncated: true };
    var obj = arr[id];
    if (!obj) return null;

    var node = {
        id: id,
        type: obj.__type__,
        // cc.Scene 本身没有 _name，用类型兜底，否则 AI 看到的是 undefined
        name: obj._name || (obj.__type__ === 'cc.Scene' ? 'Scene' : ''),
        active: obj._active,
        position: readTRS(obj),
        components: [],
        children: []
    };

    if (obj._contentSize) {
        node.size = { width: obj._contentSize.width, height: obj._contentSize.height };
    }

    var comps = obj._components || [];
    for (var i = 0; i < comps.length; i++) {
        var cid = comps[i] && comps[i].__id__;
        var comp = arr[cid];
        if (!comp) continue;
        // 自定义脚本组件的 __type__ 是压缩后的 uuid，不是类名。
        // v0.2 起自动反解成 assets 下的真实路径和类名。
        var desc = describeComponentType(comp.__type__, idx);
        var item = {
            id: cid,
            type: comp.__type__,
            isScript: desc.isScript,
            enabled: comp._enabled !== false
        };
        if (desc.isScript) {
            item.uuid = desc.uuid || null;
            item.script = desc.script || null;
            item.className = desc.className || null;
            if (!desc.resolved) {
                item.note = '该 uuid 不在 assets 的 .meta 索引里，可能是已删除的脚本或内置组件';
            }
        }
        // Sprite 组件：直接报出用的哪张图（AI 改图标时最需要这个）
        if (comp.__type__ === 'cc.Sprite' && comp._spriteFrame && comp._spriteFrame.__uuid__) {
            var sfu = comp._spriteFrame.__uuid__;
            var sfPath = idx.byFull[sfu] || null;
            item.spriteFrame = {
                uuid: sfu,
                path: sfPath,
                file: sfPath ? path.basename(sfPath) : null,
                resourceType: idx.byKind ? (idx.byKind[sfu] || null) : null
            };
            if (!sfPath) {
                item.spriteFrame.problem =
                    '这个 uuid 在 assets 的 .meta 索引里找不到 —— ' +
                    '资源可能被删了但 prefab 还在引用它。';
            } else if (idx.byKind && idx.byKind[sfu] !== 'sprite-frame') {
                item.spriteFrame.problem =
                    '这个 uuid 不是 sprite-frame（是 ' + idx.byKind[sfu] + '），' +
                    '渲染时会报 textureLoaded is not a function。' +
                    '正确做法：resolve_sprite_frame 查 sprite-frame 的 uuid';
                item.spriteFrame.suggestedUuid = findSpriteFrameUuidFor(idx, sfPath);
            }
        }
        node.components.push(item);
    }

    var kids = obj._children || [];
    for (var k = 0; k < kids.length; k++) {
        var kid = kids[k] && kids[k].__id__;
        var child = expandNode(arr, kid, depth + 1, maxDepth, idx);
        if (child) node.children.push(child);
    }

    return node;
}

function countNodes(node) {
    var n = 1;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
        if (!kids[i].truncated) n += countNodes(kids[i]);
    }
    return n;
}

/**
 * 按路径 / 下标 / 名字找节点。
 * 路径分隔用 /，允许带不带 "Scene" 根前缀。
 */
function findNode(arr, rootId, ref) {
    var s = String(ref === undefined || ref === null ? '' : ref).trim();
    if (!s) return null;

    // 纯数字当下标
    if (/^\d+$/.test(s)) {
        var id = parseInt(s, 10);
        if (arr[id] && (arr[id].__type__ === 'cc.Node' || arr[id].__type__ === 'cc.Scene')) return id;
    }

    var parts = s.split('/').filter(function (p) { return p.length > 0; });
    var rootObj = arr[rootId];
    if (parts.length && parts[0] === 'Scene' && rootObj && rootObj.__type__ === 'cc.Scene') {
        parts.shift();
    }

    // 根节点自己的名字也当路径前缀。
    // 预制体里根叫什么完全由用户定（CircleView / Panel / ...），层级面板上看到的就是
    // `CircleView/panel/item1`，照着写是最自然的写法 —— 早先只认 'Scene'，
    // 于是 `CircleView/xxx` 会去根的子节点里找一个叫 CircleView 的，永远找不到。
    if (parts.length > 1 && rootObj && rootObj._name && parts[0] === rootObj._name) {
        parts.shift();
    }

    // 根别名：预制体里根节点叫什么由用户定，让 AI 猜名字不现实。
    // 'Root' / 'Scene' 都当根处理 —— 但只在根下**没有**同名子节点时才生效，
    // 免得遮住一个真的叫 Root 的子节点。
    if (parts.length === 1) {
        var alias = parts[0];
        if (alias === 'Root' || alias === 'Scene') {
            var aliasShadowed = false;
            var rootKids = (rootObj && rootObj._children) || [];
            for (var q = 0; q < rootKids.length; q++) {
                var akid = arr[rootKids[q] && rootKids[q].__id__];
                if (akid && akid._name === alias) { aliasShadowed = true; break; }
            }
            if (!aliasShadowed) return rootId;
        }
    }

    if (parts.length === 0) return rootId;

    var cur = rootId;
    for (var i = 0; i < parts.length; i++) {
        var want = parts[i];
        var obj = arr[cur];
        if (!obj) return null;
        var kids = obj._children || [];
        var next = -1;
        for (var k = 0; k < kids.length; k++) {
            var kidId = kids[k] && kids[k].__id__;
            var kid = arr[kidId];
            if (kid && kid._name === want) { next = kidId; break; }
        }
        if (next < 0) return null;
        cur = next;
    }
    return cur;

}

/** 全树里按名字找，名字唯一才有意义 */
function findNodeByName(arr, rootId, name) {
    var hits = [];
    (function walk(id) {
        var o = arr[id];
        if (!o) return;
        if (o._name === name) hits.push(id);
        var kids = o._children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i] && kids[i].__id__);
    })(rootId);
    return hits.length === 1 ? hits[0] : (hits.length > 1 ? -hits.length : -1);
}

/**
 * 统一的节点查找：先按路径找，找不到再按名字找。
 *
 * 为什么要有这层：read_scene_node 早就支持"按名字找"，
 * 但 scene_* 那批工具只认完整路径 —— 同一个 MCP 里两套规则，
 * 用的人得记住哪个工具是哪套。这里统一成一套。
 *
 * 返回 { id, how } 或 { id: null, how, candidates }
 *   how: 'path' | 'name' | 'ambiguous' | 'notfound'
 */
function resolveNode(arr, rootId, ref) {
    var byPath = findNode(arr, rootId, ref);
    if (byPath !== null && byPath !== undefined && byPath >= 0) {
        return { id: byPath, how: 'path' };
    }
    var byName = findNodeByName(arr, rootId, String(ref));
    if (byName >= 0) {
        return { id: byName, how: 'name' };
    }
    if (byName < -1) {
        // findNodeByName 用负数表示"有多个同名"
        return { id: null, how: 'ambiguous', count: -byName };
    }
    return { id: null, how: 'notfound' };
}

/**
 * 节点找不到时，统一给出「为什么 + 怎么办」的错误。
 */
function nodeNotFoundError(arr, rootId, ref) {
    // 把场景里现有的节点名列出来，调用者一看就知道该怎么写
    var names = [];
    (function walk(id, depth) {
        if (depth > 3 || names.length > 30) return;
        var o = arr[id];
        if (!o) return;
        names.push(o._name || '(无名)');
        var kids = o._children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i] && kids[i].__id__, depth + 1);
    })(rootId);

    return new Error(
        '找不到节点：' + ref +
        '。节点可以用完整路径（如 "Canvas/topUI/btnKey"），也可以只写名字（同名多个时会报错）。' +
        '当前场景里的节点：' + (names.length ? names.join(', ') : '(空)') +
        '。先跑 query_scene_tree 看结构。'
    );
}

var PROP_SKIP = {
    node: 1, _objFlags: 1, _id: 1, _name: 1, _prefab: 1,
    __scriptAsset: 1, _enabled: 1, _scene: 1
};

/** 把序列化对象里的 __id__ / __uuid__ 引用翻译成人能看的东西 */
function dumpProps(arr, obj, depth, idx) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (depth < 0) return '[...]';
    if (Array.isArray(obj)) {
        var outA = [];
        for (var i = 0; i < obj.length; i++) outA.push(dumpProps(arr, obj[i], depth - 1, idx));
        return outA;
    }
    if (typeof obj.__id__ === 'number') {
        var t = arr[obj.__id__];
        return {
            __id__: obj.__id__,
            __type__: t && t.__type__,
            __name__: (t && t._name) || ''
        };
    }
    if (typeof obj.__uuid__ === 'string') {
        var p = idx.byFull[obj.__uuid__] || null;
        var kind = idx.byKind ? idx.byKind[obj.__uuid__] : null;
        return {
            __uuid__: obj.__uuid__,
            __path__: p,
            __type__: kind,          // sprite-frame / asset / sub-resource
            __missing__: !p
        };
    }
    var out = {};
    for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (PROP_SKIP[k]) continue;
        out[k] = dumpProps(arr, obj[k], depth - 1, idx);
    }
    return out;
}

//#endregion

module.exports = {
    setContext: setContext,
    loadSerialized: loadSerialized,
    findRootForEdit: findRootForEdit,
    findRootIndex: findRootIndex,
    readTRS: readTRS,
    readScaleTRS: readScaleTRS,
    readRotationTRS: readRotationTRS,
    describeComponentType: describeComponentType,
    findSpriteFrameUuidFor: findSpriteFrameUuidFor,
    expandNode: expandNode,
    countNodes: countNodes,
    findNode: findNode,
    findNodeByName: findNodeByName,
    resolveNode: resolveNode,
    nodeNotFoundError: nodeNotFoundError,
    dumpProps: dumpProps,
    PROP_SKIP: PROP_SKIP
};
