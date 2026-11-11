'use strict';

/**
 * 预制体装配 / 结构校验 / 布局自检 —— **纯逻辑层**，不碰 Editor、不碰 fs。
 *
 * 三件事都围绕同一个事实：`.prefab` 是一维数组 + `__id__` 下标引用。
 * 手写这玩意儿极易造出悬空引用、缺 `_prefab`、fileId 重复 ——
 * 而编辑器导入时**不报错**，要到运行时才显形。所以这里把约定固化成代码：
 *
 *   1. `[0]` 必须是 cc.Prefab，`data.__id__` 指向根 cc.Node
 *   2. 每个 cc.Node 都有 `_prefab` 指向自己的 cc.PrefabInfo
 *   3. PrefabInfo.fileId：根节点是空串，其余 22 位且唯一
 *   4. 节点的 `_id` 在预制体里一律空串
 *   5. 所有 `__id__` 都必须在数组范围内
 *
 * 依赖注入：main.js 传 { newNodeId }（生成 22 位 fileId）。
 */

var ctx = {
    newNodeId: function () { throw new Error('prefab 模块未初始化：请先调用 setContext()'); }
};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

//#region 模板

/**
 * 挑模板对象。
 *
 * 「不手搓节点对象」这条铁律同样适用于新建预制体：节点字段集必须来自
 * 引擎自己写出来的对象（`_objFlags` / `_trs` 的 ctor / `_is3DNode` …
 * 少一个都可能让编辑器行为怪怪的）。
 *
 * arrays 是项目里已有 .fire / .prefab 的解析结果，按优先级排好序传进来。
 */
function pickTemplates(arrays) {
    var out = { node: null, byType: {}, sources: [] };
    var fallbackNode = null;

    for (var a = 0; a < arrays.length; a++) {
        var arr = arrays[a];
        if (!Array.isArray(arr)) continue;
        var used = false;

        for (var i = 0; i < arr.length; i++) {
            var o = arr[i];
            if (!o || typeof o !== 'object' || typeof o.__type__ !== 'string') continue;

            if (o.__type__ === 'cc.Node') {
                if (!o._trs) continue;
                var clean = !(o._children || []).length && !(o._components || []).length && !o._prefab;
                if (clean && !out.node) { out.node = o; used = true; }
                else if (!fallbackNode) { fallbackNode = o; used = true; }
                continue;
            }

            // 只收组件级模板：Prefab / PrefabInfo / Scene / SceneAsset 都不能当组件用
            if (o.__type__.indexOf('cc.') !== 0) continue;
            if (o.__type__ === 'cc.Prefab' || o.__type__ === 'cc.PrefabInfo') continue;
            if (o.__type__ === 'cc.Scene' || o.__type__ === 'cc.SceneAsset') continue;
            if (!out.byType[o.__type__]) { out.byType[o.__type__] = o; used = true; }
        }
        if (used) out.sources.push(a);
    }

    if (!out.node && fallbackNode) out.node = fallbackNode;
    return out;
}

/** 节点兜底模板：项目里连一个场景、一个预制体都没有时才会用到 */
function fallbackNodeTemplate() {
    return {
        __type__: 'cc.Node',
        _name: '',
        _objFlags: 0,
        _parent: null,
        _children: [],
        _active: true,
        _components: [],
        _prefab: null,
        _opacity: 255,
        _color: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 },
        _contentSize: { __type__: 'cc.Size', width: 0, height: 0 },
        _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 },
        _trs: { __type__: 'TypedArray', ctor: 'Float64Array', array: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] },
        _eulerAngles: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
        _skewX: 0,
        _skewY: 0,
        _is3DNode: false,
        _groupIndex: 0,
        groupIndex: 0,
        _id: ''
    };
}

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * 把对象里的 `{__id__}` 引用全部清成 null（node 字段除外，那个由调用方设）。
 *
 * 为什么必须清：组件模板是从**别人的节点**上克隆来的，
 * `cc.Button._target`、`cc.Widget._target`、`cc.ScrollView.content` 这些
 * 都指向模板来源节点。原样搬到新节点上就是悬空/错指引用，运行时报错还很难查。
 */
function stripIdRefs(obj, keepKey) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) obj[i] = stripIdRefs(obj[i], null);
        return obj;
    }
    for (var k in obj) {
        if (!has(obj, k)) continue;
        if (k === keepKey) continue;
        var v = obj[k];
        if (v && typeof v === 'object' && typeof v.__id__ === 'number') { obj[k] = null; continue; }
        obj[k] = stripIdRefs(v, null);
    }
    return obj;
}

//#endregion

//#region 装配

/** 从 spec 建一个组件对象（克隆模板 → 清掉跨节点引用 → 兜底最小对象） */
function makeComponent(type, templates, warnings) {
    var tpl = templates.byType[type];
    var obj;

    if (tpl) {
        obj = stripIdRefs(clone(tpl), 'node');
        obj.__type__ = type;
    } else {
        warnings.push('项目里没有 ' + type + ' 的现成组件可克隆，按最小字段写——' +
            '缺的字段由引擎反序列化时补默认值；想更稳就先在编辑器里手动加一个同类组件');
        obj = { __type__: type, _name: '', _objFlags: 0, node: null, _enabled: true };
    }

    obj._name = '';
    obj._objFlags = 0;
    obj._enabled = true;
    obj.node = null;
    obj._id = '';

    // 这几个字段从模板继承会让人莫名其妙：
    //   Widget 的 _alignFlags=45（四边拉伸）会让新节点直接铺满父容器
    //   Sprite 的 _spriteFrame 会指向模板来源的那张图
    //   Label 的 _string 会带出模板里的文案
    if (type === 'cc.Widget') obj._alignFlags = 0;
    if (type === 'cc.Sprite') obj._spriteFrame = null;
    if (type === 'cc.Label') obj._string = '';

    return obj;
}

/**
 * 按 spec 生成预制体对象数组。
 *
 * spec：
 *   { name, size:[w,h], pos:[x,y], scale:[sx,sy], active, opacity, color:[r,g,b],
 *     anchor?:[x,y], sprite?:'路径', spriteType?:'simple'|'sliced', label?:'文字',
 *     components?:[{type:'cc.Xxx', props:{}}|{type:'script', path:'a.ts', props:{}}],
 *     children:[...] }
 *
 * opts：
 *   uuid          预制体 uuid（写进 PrefabInfo.asset / meta）
 *   templates     pickTemplates() 的返回值
 *   spriteUuid    function(relPath) → sprite-frame uuid
 *   assetUuid     function(relPath) → 完整 uuid
 *   scriptType    function(relPath) → { type, className }
 *   script        可选，根节点挂的脚本路径（等价于 components[0] = {type:'script'}）
 *   mask          可选，给根节点加 cc.Mask
 */
function buildFromSpec(spec, opts) {
    if (!spec || typeof spec !== 'object') throw new Error('root 必须是节点 spec 对象（{name, size, sprite, children...}）');

    var templates = opts.templates || { byType: {} };
    var warnings = [];
    var arr = [];
    var nodeList = [];
    var pending = [];

    // [0] cc.Prefab —— 根节点必然是 1 号，先占位
    arr.push({
        __type__: 'cc.Prefab',
        _name: '',
        _objFlags: 0,
        _native: '',
        data: { __id__: 1 },
        optimizationPolicy: 0,
        asyncLoadAssets: false,
        readonly: false
    });

    function attach(nodeId, nodeObj, compObj) {
        compObj.node = { __id__: nodeId };
        var cid = arr.length;
        arr.push(compObj);
        nodeObj._components.push({ __id__: cid });
        return cid;
    }

    function buildNode(nodeSpec, parentId, parentPath) {
        if (!nodeSpec || typeof nodeSpec !== 'object') {
            throw new Error('children 里有一项不是对象：' + JSON.stringify(nodeSpec));
        }

        var id = arr.length;
        var srcNode = templates.node || fallbackNodeTemplate();
        var node = clone(srcNode);

        node.__type__ = 'cc.Node';
        node._name = String(nodeSpec.name || ('Node' + id));
        node._parent = parentId === null ? null : { __id__: parentId };
        node._children = [];
        node._components = [];
        node._prefab = null;
        node._id = '';

        // 视觉字段归位成新建节点的默认值，避免继承模板来源节点的外观
        node._active = nodeSpec.active === false ? false : true;
        node._opacity = typeof nodeSpec.opacity === 'number' ? nodeSpec.opacity : 255;
        node._skewX = 0;
        node._skewY = 0;
        node._color = { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 };
        if (Array.isArray(nodeSpec.color) && nodeSpec.color.length >= 3) {
            node._color.r = nodeSpec.color[0];
            node._color.g = nodeSpec.color[1];
            node._color.b = nodeSpec.color[2];
        }

        var w = 0, h = 0;
        if (Array.isArray(nodeSpec.size) && nodeSpec.size.length >= 2) {
            w = nodeSpec.size[0];
            h = nodeSpec.size[1];
        }
        node._contentSize = { __type__: 'cc.Size', width: w, height: h };
        node._anchorPoint = { __type__: 'cc.Vec2', x: 0.5, y: 0.5 };
        if (Array.isArray(nodeSpec.anchor) && nodeSpec.anchor.length >= 2) {
            node._anchorPoint.x = nodeSpec.anchor[0];
            node._anchorPoint.y = nodeSpec.anchor[1];
        }
        node._eulerAngles = { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 };

        // _trs = [x, y, z, qx, qy, qz, qw, sx, sy, sz]
        if (node._trs && Array.isArray(node._trs.array) && node._trs.array.length >= 10) {
            node._trs.array = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
        }
        var pos = Array.isArray(nodeSpec.pos) ? nodeSpec.pos : [0, 0];
        if (node._trs && Array.isArray(node._trs.array) && node._trs.array.length >= 2) {
            node._trs.array[0] = typeof pos[0] === 'number' ? pos[0] : 0;
            node._trs.array[1] = typeof pos[1] === 'number' ? pos[1] : 0;
        }
        if (Array.isArray(nodeSpec.scale) && node._trs && Array.isArray(node._trs.array)) {
            if (typeof nodeSpec.scale[0] === 'number') node._trs.array[7] = nodeSpec.scale[0];
            if (typeof nodeSpec.scale[1] === 'number') node._trs.array[8] = nodeSpec.scale[1];
        }

        arr.push(node);
        var nodePath = parentPath ? (parentPath + '/' + node._name) : node._name;
        nodeList.push({ path: nodePath, id: id, name: node._name, isRoot: parentId === null });

        // 组件：sprite / label 是简写，components 是完整写法
        if (nodeSpec.sprite) {
            var sp = makeComponent('cc.Sprite', templates, warnings);
            sp._spriteFrame = { __uuid__: opts.spriteUuid(String(nodeSpec.sprite)) };
            if (nodeSpec.spriteType === 'sliced') sp._type = 1;
            // 给了尺寸就按 CUSTOM 走，否则图一导入尺寸就被贴回原图大小
            if (w > 0 && h > 0) sp._sizeMode = 0;
            attach(id, node, sp);
        }

        if (nodeSpec.label !== undefined && nodeSpec.label !== null) {
            var lb = makeComponent('cc.Label', templates, warnings);
            lb._string = String(nodeSpec.label);
            attach(id, node, lb);
        }

        var comps = Array.isArray(nodeSpec.components) ? nodeSpec.components : [];
        for (var ci = 0; ci < comps.length; ci++) {
            var cs = comps[ci];
            if (!cs || !cs.type) throw new Error('节点 "' + node._name + '" 的 components[' + ci + '] 缺少 type');

            var compObj, label;
            if (cs.type === 'script') {
                if (!cs.path) throw new Error('节点 "' + node._name + '" 的脚本组件缺少 path（如 assets/scripts/Foo.ts）');
                var info = opts.scriptType(String(cs.path));
                compObj = { __type__: info.type, _name: '', _objFlags: 0, node: null, _enabled: true, _id: '' };
                label = info.className || cs.path;
                if (info.className) compObj.__scriptClass = info.className;
            } else {
                compObj = makeComponent(String(cs.type), templates, warnings);
                label = cs.type;
            }
            var cid = attach(id, node, compObj);
            if (cs.props) pending.push({ obj: compObj, props: cs.props, nodePath: nodePath, nodeId: id, label: label, cid: cid });
        }

        var kids = Array.isArray(nodeSpec.children) ? nodeSpec.children : [];
        for (var k = 0; k < kids.length; k++) {
            var kidId = buildNode(kids[k], id, nodePath);
            node._children.push({ __id__: kidId });
        }

        return id;
    }

    var rootId = buildNode(spec, null, '');

    // spec 顶层的 script / mask 是根节点的简写
    var rootNode = arr[rootId];
    if (opts.script) {
        var rinfo = opts.scriptType(String(opts.script));
        var rcomp = { __type__: rinfo.type, _name: '', _objFlags: 0, node: null, _enabled: true, _id: '' };
        if (rinfo.className) rcomp.__scriptClass = rinfo.className;
        attach(rootId, rootNode, rcomp);
    }
    if (opts.mask) {
        attach(rootId, rootNode, makeComponent('cc.Mask', templates, warnings));
    }

    arr[0].data = { __id__: rootId };

    // 节点路径 / 名字 → id，props 里的 {node:'...'} 要用
    var byPath = {};
    var byName = {};
    for (var n = 0; n < nodeList.length; n++) {
        byPath[nodeList[n].path] = nodeList[n].id;
        var nm = nodeList[n].name;
        byName[nm] = byName[nm] === undefined ? nodeList[n].id : -1; // -1 表示重名
    }

    function lookupNode(ref, ownerId) {
        var s = String(ref).trim();
        if (!s || s === 'self' || s === '.') return ownerId;
        if (byPath[s] !== undefined) return byPath[s];
        var stripped = s.replace(/^\/+/, '').replace(/^Root\//, '');
        if (byPath[stripped] !== undefined) return byPath[stripped];
        if (byName[s] !== undefined && byName[s] >= 0) return byName[s];
        if (byName[s] === -1) throw new Error('节点引用 "' + s + '" 有重名，请写完整路径（根节点算起，如 "panel/title"）');
        throw new Error('节点引用 "' + s + '" 找不到。可用的节点：' +
            nodeList.map(function (x) { return x.path; }).slice(0, 20).join('、'));
    }

    // props 要等整棵树建完才能解析节点引用，所以统一放到这里
    for (var p = 0; p < pending.length; p++) {
        applyProps(pending[p].obj, pending[p].props, pending[p], lookupNode, opts);
    }

    // PrefabInfo 放最后，节点顺序与 nodeList 一致
    for (var q = 0; q < nodeList.length; q++) {
        var infoId = arr.length;
        arr.push({
            __type__: 'cc.PrefabInfo',
            root: { __id__: rootId },
            asset: { __uuid__: opts.uuid },
            fileId: nodeList[q].isRoot ? '' : ctx.newNodeId(),
            sync: false
        });
        arr[nodeList[q].id]._prefab = { __id__: infoId };
    }

    return {
        arr: arr,
        rootId: rootId,
        nodeCount: nodeList.length,
        nodes: nodeList.map(function (x) { return { path: x.path, id: x.id }; }),
        warnings: warnings
    };
}

/** 把一个值翻译成序列化字段：{node:'路径'} / {asset:'路径'} / {spriteFrame:'图片路径'} */
function applyProps(obj, props, owner, lookupNode, opts) {
    for (var k in props) {
        if (!has(props, k)) continue;
        var v = props[k];

        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (typeof v.node === 'string') { obj[k] = { __id__: lookupNode(v.node, owner.nodeId) }; continue; }
            if (typeof v.asset === 'string') { obj[k] = { __uuid__: opts.assetUuid(v.asset) }; continue; }
            if (typeof v.spriteFrame === 'string') { obj[k] = { __uuid__: opts.spriteUuid(v.spriteFrame) }; continue; }
            obj[k] = clone(v);
            continue;
        }

        obj[k] = v;
    }
}

//#endregion

//#region 校验

/**
 * 校验一个预制体数组的结构合法性。
 * 返回 problems[]（空数组 = 通过）。错误要指到具体下标，否则没法修。
 */
function validatePrefabArray(arr, label) {
    var problems = [];
    var who = label || 'prefab';

    if (!Array.isArray(arr)) return ['顶层不是数组（Cocos 序列化格式要求是数组）'];
    if (!arr.length) return ['空数组'];

    var head = arr[0];
    if (!head || head.__type__ !== 'cc.Prefab') {
        problems.push('[0] 不是 cc.Prefab（实际：' + ((head && head.__type__) || '空') + '）');
    }

    var rootId = head && head.data && head.data.__id__;
    if (typeof rootId !== 'number') {
        problems.push('[0].data.__id__ 不是数字 —— 预制体必须指向根节点');
        rootId = -1;
    } else if (!arr[rootId] || arr[rootId].__type__ !== 'cc.Node') {
        problems.push('[0].data.__id__ = ' + rootId + '，但那个位置不是 cc.Node');
        rootId = -1;
    }

    // 所有 __id__ 引用必须在范围内 + 不能指向自己所在的数组外
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
                if (!has(obj, k)) continue;
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

    // 节点：必须有 _prefab，且指向 PrefabInfo
    var fileIds = {};
    for (var j = 0; j < arr.length; j++) {
        var node = arr[j];
        if (!node || node.__type__ !== 'cc.Node') continue;

        if (!node._prefab || typeof node._prefab.__id__ !== 'number') {
            problems.push('#' + j + '（' + (node._name || '?') + '）没有 _prefab —— 预制体里每个节点都必须带 cc.PrefabInfo');
            continue;
        }
        var info = arr[node._prefab.__id__];
        if (!info || info.__type__ !== 'cc.PrefabInfo') {
            problems.push('#' + j + ' 的 _prefab 指向 #' + node._prefab.__id__ + '，但那里不是 cc.PrefabInfo');
            continue;
        }
        if (typeof info.fileId !== 'string') {
            problems.push('#' + node._prefab.__id__ + ' 的 fileId 不是字符串');
        } else if (fileIds[info.fileId]) {
            problems.push('fileId 重复："' + info.fileId + '" 同时出现在 #' + fileIds[info.fileId] + ' 和 #' + node._prefab.__id__);
        } else {
            fileIds[info.fileId] = node._prefab.__id__;
        }
        if (j === rootId && info.fileId !== '') {
            problems.push('根节点的 fileId 必须是空串，实际是 "' + info.fileId + '"');
        }
        if (j !== rootId && info.fileId === '') {
            problems.push('#' + j + '（' + (node._name || '?') + '）不是根节点，fileId 不能是空串');
        }
    }

    // 组件：**从节点的 _components 出发查**，而不是"扫所有对象要求有 node"。
    //
    // 为什么这么改：cc.ClickEvent / cc.AnimationClip 这类是**普通 CCClass**，
    // 不是 Component，它们根本没有 node 字段（ClickEvent 挂在 Button.clickEvents 里）。
    // 早先按"非 Node 就必须有 node"扫，会把它们全判成坏结构 —— 真实项目里
    // 有大量 Button 带 clickEvents，这条误报会直接把 write_file 拦死。
    for (var n = 0; n < arr.length; n++) {
        var host = arr[n];
        if (!host || host.__type__ !== 'cc.Node') continue;
        var comps = host._components || [];
        for (var ci = 0; ci < comps.length; ci++) {
            var cid = comps[ci] && comps[ci].__id__;
            var comp = arr[cid];
            if (!comp) {
                problems.push('#' + n + '（' + (host._name || '?') + '）的 _components[' + ci +
                    '] 指向不存在的 #' + cid);
                continue;
            }
            if (!comp.node || typeof comp.node.__id__ !== 'number') {
                problems.push('#' + cid + '（' + (comp.__type__ || '?') + '）在 #' + n +
                    '（' + (host._name || '?') + '）的 _components 里，但没有 node 回指');
                continue;
            }
            if (comp.node.__id__ !== n) {
                problems.push('#' + cid + '（' + (comp.__type__ || '?') + '）的 node 指向 #' +
                    comp.node.__id__ + '，但它被列在 #' + n + ' 的 _components 里');
            }
        }
    }

    // 只留前 20 条，多了反而看不清
    if (problems.length > 20) {
        problems = problems.slice(0, 20).concat(['…还有 ' + (problems.length - 20) + ' 条，先修上面这些']);
    }
    void who;
    return problems;
}

function assertPrefabArray(arr, label) {
    var problems = validatePrefabArray(arr, label);
    if (problems.length) {
        throw new Error((label || '预制体') + '结构不合法，已拒绝写入：\n  - ' + problems.join('\n  - '));
    }
}

/**
 * 覆盖已有预制体时保住节点身份。
 *
 * fileId 是预制体更新时"这个节点还是原来那个节点"的唯一凭据。
 * 整文件重写如果每次随机生成，已有场景里引用了其中某个节点的实例
 * 就再也对不回原节点了。所以按 **父路径 + 名字** 匹配旧文件，沿用旧 fileId。
 *
 * 返回复用条数。根节点的 fileId 恒为空串，不参与匹配。
 */
function stabilizeFileIds(newArr, oldArr) {
    var oldKeys = indexNodeKeys(oldArr);
    if (!oldKeys) return 0;

    var newKeys = indexNodeKeys(newArr);
    if (!newKeys) return 0;

    var reused = 0;
    for (var i = 0; i < newKeys.list.length; i++) {
        var item = newKeys.list[i];
        if (!item.node._prefab || typeof item.node._prefab.__id__ !== 'number') continue;
        var info = newArr[item.node._prefab.__id__];
        if (!info || info.__type__ !== 'cc.PrefabInfo') continue;
        if (item.isRoot) { info.fileId = ''; continue; }

        var old = oldKeys.map[item.key];
        if (old && typeof old === 'string' && old !== '' && info.fileId !== old) {
            info.fileId = old;
            reused++;
        }
    }
    return reused;
}

/** 建 父路径+名字 → fileId 的索引（只对合法预制体有效） */
function indexNodeKeys(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    var head = arr[0];
    if (!head || head.__type__ !== 'cc.Prefab') return null;
    var rootId = head.data && head.data.__id__;
    if (typeof rootId !== 'number' || !arr[rootId]) return null;

    var map = {};
    var list = [];

    (function walk(id, parentPath) {
        var node = arr[id];
        if (!node || node.__type__ !== 'cc.Node') return;
        var key = parentPath + '\u0000' + (node._name || '');
        var fileId = null;
        if (node._prefab && typeof node._prefab.__id__ === 'number') {
            var info = arr[node._prefab.__id__];
            if (info && info.__type__ === 'cc.PrefabInfo') fileId = info.fileId;
        }
        if (map[key] === undefined) map[key] = fileId;
        list.push({ node: node, key: key, isRoot: parentPath === '' });

        var path = parentPath ? parentPath + '/' + (node._name || '') : (node._name || '');
        var kids = node._children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i].__id__, path);
    })(rootId, '');

    return { map: map, list: list };
}

//#endregion

//#region 布局自检

var PAINTED_TYPES = { 'cc.Sprite': 1, 'cc.Label': 1, 'cc.RichText': 1, 'cc.Graphics': 1, 'cc.Mask': 1 };

function isPainted(arr, node) {
    var comps = node._components || [];
    for (var i = 0; i < comps.length; i++) {
        var o = arr[comps[i].__id__];
        if (o && PAINTED_TYPES[o.__type__]) return true;
    }
    return false;
}

function nodeBox(worldX, worldY, node, scaleX, scaleY) {
    var size = node._contentSize || { width: 0, height: 0 };
    var anchor = node._anchorPoint || { x: 0.5, y: 0.5 };
    var w = (size.width || 0) * scaleX;
    var h = (size.height || 0) * scaleY;
    return {
        x: worldX - anchor.x * w,
        y: worldY - anchor.y * h,
        w: w,
        h: h,
        cx: worldX + (0.5 - anchor.x) * w,
        cy: worldY + (0.5 - anchor.y) * h
    };
}

function overlapArea(a, b) {
    var l = Math.max(a.x, b.x);
    var r = Math.min(a.x + a.w, b.x + b.w);
    var t = Math.max(a.y, b.y);
    var bt = Math.min(a.y + a.h, b.y + b.h);
    if (r <= l || bt <= t) return 0;
    return (r - l) * (bt - t);
}

function contains(outer, inner, tol) {
    var t = tol || 1;
    return inner.x >= outer.x - t && inner.y >= outer.y - t &&
        inner.x + inner.w <= outer.x + outer.w + t &&
        inner.y + inner.h <= outer.y + outer.h + t;
}

/**
 * 纯几何布局自检 —— 不需要编辑器、不需要截图。
 *
 * 坐标算法（Cocos 2.x）：子节点的 position 相对**父节点的锚点**，
 * 所以 world(child) = world(parent) + pos * parentScale。
 * 旋转不参与计算（UI 极少旋转，真要转的话这个检查只能说"仅供参考"）。
 *
 * opts: { canvas:[w,h] | null, tolerance:number }
 */
function layoutCheck(arr, rootId, opts) {
    opts = opts || {};
    var tol = typeof opts.tolerance === 'number' ? opts.tolerance : 1;

    var root = arr[rootId];
    if (!root) throw new Error('根对象不存在：#' + rootId);

    // 画布参照物：预制体用根节点；场景用里面那个 Canvas 节点
    var refId = findCanvasRef(arr, rootId);
    var refNode = arr[refId] || root;
    var refSize = refNode._contentSize || {};

    var cw = opts.canvas && opts.canvas[0] ? opts.canvas[0] : (refSize.width || 750);
    var ch = opts.canvas && opts.canvas[1] ? opts.canvas[1] : (refSize.height || 1334);
    var refWorld = worldOf(arr, refId);
    var canvasBox = {
        x: refWorld.x - cw / 2,
        y: refWorld.y - ch / 2,
        w: cw,
        h: ch
    };

    var outOfBounds = [];
    var overlaps = [];
    var outsideParent = [];
    var inactiveHidden = [];
    var nodeCount = 0;
    var paintedCount = 0;

    function walk(id, parentWorld, parentPath, ancestorActive, parentBox) {
        var node = arr[id];
        if (!node || node.__type__ !== 'cc.Node') return;
        nodeCount++;

        var world = childWorld(parentWorld, node);
        var name = node._name || ('#' + id);
        var path = parentPath ? (parentPath + '/' + name) : name;
        var active = ancestorActive && node._active !== false;

        if (node._active === false) {
            inactiveHidden.push({ node: path, id: id, note: 'active=false；兄弟节点仍会占位（按钮双态切换是常见用法）' });
        }

        var box = nodeBox(world.x, world.y, node, world.sx, world.sy);
        var painted = isPainted(arr, node);
        if (painted) paintedCount++;

        if (painted && active && box.w > 0 && box.h > 0) {
            if (!contains(canvasBox, box, tol)) {
                outOfBounds.push({
                    node: path, id: id, box: roundBox(box),
                    over: roundBox(outerOverflow(canvasBox, box)),
                    note: '超出画布'
                });
            }
            if (parentBox && parentBox.w > 0 && parentBox.h > 0 && !contains(parentBox, box, tol)) {
                outsideParent.push({
                    node: path, id: id, box: roundBox(box), parent: roundBox(parentBox),
                    over: roundBox(outerOverflow(parentBox, box))
                });
            }
        }

        // 同级重叠：只比"会画东西"的节点，容器之间重叠是正常结构
        var kids = (node._children || []).map(function (r) { return r.__id__; });
        var paintedKids = [];
        for (var i = 0; i < kids.length; i++) {
            var kid = arr[kids[i]];
            if (!kid || kid.__type__ !== 'cc.Node') continue;
            if (!active || kid._active === false) continue;
            if (!isPainted(arr, kid)) continue;
            var kw = childWorld(world, kid);
            var kbox = nodeBox(kw.x, kw.y, kid, kw.sx, kw.sy);
            if (kbox.w <= 0 || kbox.h <= 0) continue;
            paintedKids.push({ path: path + '/' + (kid._name || '?'), box: kbox });
        }
        for (var a = 0; a < paintedKids.length; a++) {
            for (var b = a + 1; b < paintedKids.length; b++) {
                var area = overlapArea(paintedKids[a].box, paintedKids[b].box);
                if (area <= tol * tol) continue;
                var smaller = Math.min(paintedKids[a].box.w * paintedKids[a].box.h, paintedKids[b].box.w * paintedKids[b].box.h);
                var ratio = smaller > 0 ? area / smaller : 0;
                overlaps.push({
                    a: paintedKids[a].path,
                    b: paintedKids[b].path,
                    area: Math.round(area),
                    ratio: Math.round(ratio * 1000) / 1000,
                    note: ratio > 0.9 ? '基本完全重叠（常是层叠背景，确认是否本意）' : '部分重叠'
                });
            }
        }

        for (var k = 0; k < kids.length; k++) {
            walk(kids[k], world, path, active, box);
        }
    }

    if (root.__type__ === 'cc.Node') {
        walk(rootId, null, '', true, null);
    } else {
        // 场景根是 cc.Scene（不是 Node），从它的子节点开始算
        var topKids = (root._children || []).map(function (r) { return r.__id__; });
        for (var t = 0; t < topKids.length; t++) walk(topKids[t], null, '', true, null);
    }

    // 重叠按比例从小到大排：0.3 那种"压了一角"更像事故，1.0 基本是背景层叠，
    // 排前面让调用方先看该看的
    overlaps.sort(function (a, b) { return (a.ratio || 0) - (b.ratio || 0); });

    var summary = '节点 ' + nodeCount + ' 个（有画面元素 ' + paintedCount + ' 个）：' +
        '越出画布 ' + outOfBounds.length + '，同级重叠 ' + overlaps.length +
        '，超出父容器 ' + outsideParent.length + '，隐藏节点 ' + inactiveHidden.length;

    return {
        canvas: roundBox(canvasBox),
        canvasRefNode: refId === rootId ? (refNode._name || '根节点') : (refNode._name || 'Canvas'),
        nodeCount: nodeCount,
        painted: paintedCount,
        outOfBounds: outOfBounds,
        overlaps: overlaps,
        outsideParent: outsideParent,
        inactiveHidden: inactiveHidden,
        summary: summary
    };
}

/** 本地变换叠加到父世界坐标 */
function childWorld(parentWorld, node) {
    var t = node && node._trs && Array.isArray(node._trs.array) ? node._trs.array : null;
    var px = 0, py = 0, sx = 1, sy = 1;
    if (t && t.length >= 10) {
        px = t[0] || 0;
        py = t[1] || 0;
        sx = t[7] === undefined ? 1 : t[7];
        sy = t[8] === undefined ? 1 : t[8];
    }
    if (!parentWorld) return { x: px, y: py, sx: sx, sy: sy };
    return {
        x: parentWorld.x + px * parentWorld.sx,
        y: parentWorld.y + py * parentWorld.sy,
        sx: parentWorld.sx * sx,
        sy: parentWorld.sy * sy
    };
}

/** 顺着 _parent 一路往上算世界坐标 */
function worldOf(arr, id) {
    var chain = [];
    var cur = arr[id];
    var guard = 0;
    while (cur && cur.__type__ === 'cc.Node' && guard++ < 200) {
        chain.push(cur);
        var pid = cur._parent && typeof cur._parent.__id__ === 'number' ? cur._parent.__id__ : null;
        cur = pid === null ? null : arr[pid];
    }

    var x = 0, y = 0, sx = 1, sy = 1;
    for (var i = chain.length - 1; i >= 0; i--) {
        var w = childWorld({ x: x, y: y, sx: sx, sy: sy }, chain[i]);
        x = w.x; y = w.y; sx = w.sx; sy = w.sy;
    }
    return { x: x, y: y, sx: sx, sy: sy };
}

/** 画布参照：预制体根节点 / 场景里第一个有尺寸的 Canvas（没有就叫这个名字的节点时退到第一个有尺寸的子节点） */
function findCanvasRef(arr, rootId) {
    var root = arr[rootId];
    if (root && root.__type__ === 'cc.Node' && root._contentSize && root._contentSize.width) return rootId;

    var found = -1;
    var firstSized = -1;   // 名字不叫 Canvas 但有尺寸的节点：布局检查照样能当参照
    (function search(id, depth) {
        if (found >= 0 || depth > 6) return;
        var node = arr[id];
        if (!node) return;
        var kids = node._children || [];
        for (var i = 0; i < kids.length; i++) {
            if (found >= 0) return;
            var kid = arr[kids[i].__id__];
            if (!kid) continue;
            var hasSize = !!(kid._contentSize && kid._contentSize.width);
            if (hasSize && firstSized < 0) firstSized = kids[i].__id__;
            if (kid._name === 'Canvas' && hasSize) { found = kids[i].__id__; return; }
            search(kids[i].__id__, depth + 1);
        }
    })(rootId, 0);

    if (found >= 0) return found;
    if (firstSized >= 0) return firstSized;
    return rootId;
}

function roundBox(b) {
    if (!b) return null;
    return {
        x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.w), h: Math.round(b.h)
    };
}

/** 内层超出外层的量（每边各自算，0 表示没超） */
function outerOverflow(outer, inner) {
    var left = Math.max(0, outer.x - inner.x);
    var bottom = Math.max(0, outer.y - inner.y);
    var right = Math.max(0, (inner.x + inner.w) - (outer.x + outer.w));
    var top = Math.max(0, (inner.y + inner.h) - (outer.y + outer.h));
    return { x: -left, y: -bottom, w: left + right, h: bottom + top };
}

//#endregion

module.exports = {
    setContext: setContext,
    pickTemplates: pickTemplates,
    fallbackNodeTemplate: fallbackNodeTemplate,
    buildFromSpec: buildFromSpec,
    validatePrefabArray: validatePrefabArray,
    assertPrefabArray: assertPrefabArray,
    stabilizeFileIds: stabilizeFileIds,
    layoutCheck: layoutCheck
};
