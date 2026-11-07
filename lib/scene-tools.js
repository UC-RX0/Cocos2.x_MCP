'use strict';

/**
 * 场景 / 预制体**写入**工具集 —— 直接改 .fire / .prefab 的 JSON。
 *
 * 这一层完全不经过编辑器进程，是这个 MCP 最可靠的部分：
 *   - 可 diff（git 能看出改了什么）
 *   - 可离线测（不需要编辑器）
 *   - 不依赖编辑器内部 IPC
 *
 * **三条铁律**（都是踩过坑总结的）：
 *   1. **不手搓节点对象** —— 克隆场景里已有的同类对象再改字段。
 *      _trs / _color / _contentSize / _anchorPoint / _objFlags 一律继承引擎值。
 *   2. **写盘保留原文件格式** —— CRLF 项目不能被写成 LF，否则 git diff 全量重写。
 *   3. **删对象必须全局重映射 __id__** —— 先摘掉父节点 _children 里的引用再扫外部引用，
 *      有残留就拒绝，不写半坏场景。
 *
 * 依赖注入：ctx 由 main.js 注入（见 main.js 的 setSceneToolsContext）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 宿主注入的上下文。
 * 全部是函数引用 —— 本模块不在顶层求值，所以注入时机很宽松。
 */
var ctx = {};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

/** 取 ctx 里的函数（少写一堆 ctx. 前缀） */
function c(name) {
    var fn = ctx[name];
    if (!fn) throw new Error('scene-tools 未注入依赖：' + name);
    return fn;
}

/**
 * 可选依赖：没注入就返回 null，不抛。
 *
 * 为什么单独一个：记账（noteFileWrite）这类"锦上添花"的能力，
 * 缺了最多是少了历史比对，绝不能让写入本身失败 —— 而且它是在**写完之后**调的，
 * 这时候抛错会让调用方以为"没写成功"，实际上文件已经改了，最坏的一种错误。
 */
function cOptional(name) {
    return ctx[name] || null;
}

//#region 场景写入（文件级）

/**
 * 直接改 .fire 的 JSON 数组，不经过编辑器进程。
 *
 * 为什么最终走这条路：2.4 的 scene-script 通道实测不通——场景脚本能收到消息并执行
 * （发未注册的方法会立刻回 "message not found"，发注册过的就没声），但返回值三条回传
 * 通道（包 messages / IpcListener / 文件信箱）全部静默。三次重启验证下来结论稳定：
 * 只收不回。而 .fire 是纯 JSON 数组 + __id__ 下标引用，直接改反而可靠、可 diff、
 * 能离线测，也符合这个扩展一贯的"不碰编辑器 IPC"原则。
 *
 * 安全策略：**不手搓节点对象**，而是克隆场景里已有的空节点（零组件零子节点）再改字段。
 * 这样 _objFlags / _trs / _color / _contentSize / _anchorPoint 这些一律继承引擎
 * 自己写出来的正确值，避免拼错字段导致编辑器打不开或静默丢节点。
 */

/**
 * 根定位 —— **薄别名**，实现只有一份（lib/scene-parse.js 的 findRootForEdit）。
 *
 * 这两个名字是历史原因留着的：findSceneRootId 是 .fire 时代的老接口，
 * findRootForEdit 返回 { rootId, kind }。别再往这里加逻辑。
 */
function findRootForEdit(arr) {
    return c('findRootForEdit')(arr);
}

function findSceneRootId(arr) {
    return findRootForEdit(arr).rootId;
}

/** 22 位，和引擎生成的 _id 同格式（base64 去掉补位） */
function newNodeId() {
    return crypto.randomBytes(16).toString('base64').replace(/=+$/, '');
}

/**
 * 生成一条 cc.PrefabInfo。
 *
 * 预制体里每个节点都必须带 _prefab，缺了编辑器能打开但一保存就报错，
 * 或者子节点身份丢失（下次预制体更新对不回去）。根节点的 fileId 必须是空串，
 * 其余节点各自一个唯一 id。
 *
 * asset 字段有两种写法，都见过：
 *   现有项目 prefab：{ "__id__": 0 }        ← 指向文件里的 cc.Prefab
 *   prefab_create_from_node：{ "__uuid__": <prefab uuid> }
 * 同一个文件里**不能混用**，所以这里沿用文件里已有的那种。
 */
function makePrefabInfo(arr, rootId, isRoot) {
    var assetRef = null;
    for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o || o.__type__ !== 'cc.PrefabInfo' || !o.asset) continue;
        if (typeof o.asset.__uuid__ === 'string') { assetRef = { __uuid__: o.asset.__uuid__ }; break; }
        if (typeof o.asset.__id__ === 'number') { assetRef = { __id__: o.asset.__id__ }; break; }
    }
    if (!assetRef) assetRef = { __id__: 0 };

    return {
        __type__: 'cc.PrefabInfo',
        root: { __id__: rootId },
        asset: assetRef,
        fileId: isRoot ? '' : newNodeId(),
        sync: false
    };
}

/** 写盘提示按场景/预制体分开说 —— 说错文件类型会让人去错地方找 */
function saveNote(kind, extra) {
    var isPrefab = kind === 'prefab';
    return '已直接写入 ' + (isPrefab ? '.prefab' : '.fire') + '。编辑器里如果开着这个' +
        (isPrefab ? '预制体' : '场景') + '，请重新打开——' +
        '否则编辑器下次保存会用内存里的旧版本覆盖掉这次改动。' + (extra || '');
}

/**
 * 挑模板节点。优先"零子节点 + 零组件 + 非预制体"的干净节点；
 * 找不到就退而取任意 cc.Node——克隆后会把子节点/组件/预制体清空，
 * 字段集合仍然来自引擎自己写出来的对象，不会漏字段。
 */
function pickNodeTemplate(arr, preferParentId) {
    var order = [];

    if (preferParentId != null && arr[preferParentId]) {
        var kids = arr[preferParentId]._children || [];
        for (var i = 0; i < kids.length; i++) order.push(kids[i].__id__);
    }
    for (var j = 0; j < arr.length; j++) order.push(j);

    var fallback = -1;
    for (var k = 0; k < order.length; k++) {
        var o = arr[order[k]];
        if (!o || o.__type__ !== 'cc.Node') continue;

        var clean = !((o._children || []).length) && !((o._components || []).length) && !o._prefab;
        if (clean) return order[k];
        if (fallback < 0) fallback = order[k];
    }
    return fallback;
}

/** 三个场景写工具共用：定位文件 + 解析 + 找根 */
function loadSceneForEdit(args) {
    var abs = (args && args.path) ? c('safePath')(args.path) : c('currentSceneFile')();
    if (!abs) throw new Error(
        '定位不到当前场景文件（Editor.currentSceneUuid 拿不到对应资源）。' +
        '用 path 参数直接指定 .fire 的路径，比如 {"path":"assets/scene/Game.fire"}。' +
        '也可以先 list_dir 看项目里有哪些 .fire。'
    );
    if (!c('statSafe')(abs)) throw new Error('场景文件不存在：' + abs);

    var arr = c('loadSerialized')(abs);
    var root = findRootForEdit(arr);
    if (root.rootId < 0) {
        throw new Error('这个文件既不是 .fire（没有 cc.Scene 根对象）也不是 .prefab' +
            '（[0] 不是 cc.Prefab 或 data.__id__ 没指向 cc.Node）：' + abs);
    }

    return {
        abs: abs, arr: arr, rootId: root.rootId, kind: root.kind,
        // 打开时把节点 id 抄一份 —— 提交时拿它和"改完之后的 id 集合"比，
        // 就知道这一批操作到底删了哪些节点。editor_sync 靠这个区分
        // "编辑器还显示着我们刚删的节点"（正常，重载就好）和
        // "用户自己在编辑器里加了节点"（重载会丢，要拦住）。
        prevIds: nodeIdList(arr)
    };
}

/**
 * 打开文档（可复用）。
 *
 * 批量模式下 `args.__doc` 是上游已经打开的同一个文档 —— 这样 20 个操作
 * 只解析一次、只落盘一次，而不是 20 次读写 20 次落盘、中途失败留半成品。
 */
function openDocForEdit(args) {
    if (args && args.__doc) return args.__doc;
    return loadSceneForEdit(args);
}

/**
 * 提交一份文档。
 *
 * 非批量：立刻写盘（保留换行风格），把 file/saved/note 补进返回值。
 * 批量（ctx.defer）：只标脏，真正的写盘由 scene_apply 统一做一次。
 *
 * nextArr 用于"删除对象要重建数组"的那两个工具 —— 它们会把 arr 换成重映射后的新数组，
 * 后续操作必须看到新数组，否则 __id__ 全错位。
 */
function commitDoc(ctx, payload, nextArr) {
    if (nextArr) ctx.arr = nextArr;
    if (ctx.defer) {
        ctx.dirty = true;
        payload.deferred = true;
        return payload;
    }
    var rel = saveSceneFile(ctx.abs, ctx.arr, ctx.prevIds);
    payload.file = rel;
    payload.saved = true;

    // 写完了才知道"这一步到底有多大风险"：编辑器正开着它吗？盘上刚被外部改过吗？
    // 这两个信息必须跟着返回值走 —— 光印一句"请重新打开"AI 不知道要不要紧。
    var describe = cOptional('describeEditorState');
    var ed = null;
    if (describe) {
        try { ed = describe(ctx.abs); } catch (e) { ed = null; }
    }

    if (ed) {
        payload.editor = ed;
        if (ed.externalChange) {
            payload.warning = '这个文件在我们上次写入之后被改过（很可能是编辑器保存）。' +
                '本次写入已经把它覆盖 —— 如果上一批改动没了，那是原因。';
        }
        if (ed.openInEditor) {
            payload.note = '已写入 ' + (ctx.kind === 'prefab' ? '.prefab' : '.fire') +
                '，但编辑器正开着它。现在调 editor_sync {action:"reload"} 让它跟上，' +
                '否则你在编辑器里保存时会把这次改动覆盖掉。';
            return payload;
        }
        // 预制体编辑态：判断不了是哪个预制体，但至少要提醒"别在这里保存"
        if (ed.editorInTempScene) {
            payload.note = '已写入 .prefab，但编辑器正处在**预制体编辑态**。' +
                '如果开的就是这个预制体：**别在编辑器里保存**（会覆盖刚写的），' +
                '先调 editor_sync {action:"status", path:"' + rel + '"} 确认是不是它，' +
                '是的话关掉预制体再重开（预制体无法从外部重载）。';
            return payload;
        }
    }

    if (!payload.note) payload.note = saveNote(ctx.kind);
    return payload;
}

/**
 * 把文件里所有节点的 _id 抄一份（预制体里 _id 是空串，所以同时收 path 兜底）。
 * 顺序无关，只用来做集合差。
 */
function nodeIdList(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o || (o.__type__ !== 'cc.Node' && o.__type__ !== 'cc.Scene')) continue;
        if (o._id) out.push(o._id);
    }
    return out;
}

/** 根节点引用：'Scene' / '/' / 'Root' 都认，空值也是根 —— 别让 AI 猜根节点叫什么 */
function isRootRef(ref, kind) {
    if (ref === undefined || ref === null) return true;
    var s = String(ref).trim();
    if (s === '' || s === '/' || s === 'Scene') return true;
    if (kind === 'prefab' && (s === 'Root' || s === 'root')) return true;
    return false;
}

function saveSceneFile(abs, arr, prevIds) {
    c('writeJsonPreserving')(abs, arr);
    var rel = path.relative(c('projectRoot')(), abs).replace(/\\/g, '/');

    // 记账：把"我们写出来的这个版本"的 mtime/size 记下来。
    // 下次写之前比一下，就知道中间有没有人（基本就是编辑器保存）动过它。
    // 顺手记下"这一批删掉了哪些节点 id" —— editor_sync 用它来区分
    // "编辑器还显示着我们刚删的节点"（正常）和"用户自己加了节点"（会丢，要拦）。
    // 记账失败绝不能影响写入本身 —— 顶多以后少了历史比对。
    var note = cOptional('noteFileWrite');
    if (note) {
        var ids = nodeIdList(arr);
        var removed = null;
        if (prevIds && prevIds.length) {
            var after = {};
            for (var i = 0; i < ids.length; i++) after[ids[i]] = 1;
            removed = [];
            for (var j = 0; j < prevIds.length; j++) {
                if (!after[prevIds[j]]) removed.push(prevIds[j]);
            }
        }
        try {
            note(abs, { tool: 'scene_write', ids: ids, removed: removed });
        } catch (e) { /* 忽略 */ }
    }
    return rel;
}

function toolSceneAddNode(args) {
    // from=prefab：把预制体拷成普通节点挂进来（原 prefab_instantiate）。
    // 和"新建空节点"是同一个动作的两种来源，合成一个工具少一次判断。
    if (args && args.from && String(args.from).toLowerCase() === 'prefab') {
        return toolPrefabInstantiate(args);
    }

    var ctx = openDocForEdit(args);
    var abs = ctx.abs;
    var arr = ctx.arr;
    var rootId = ctx.rootId;
    var kind = ctx.kind;

    var parentRef = args.parent || 'Scene';
    var parentId;
    if (isRootRef(parentRef, kind)) {
        parentId = rootId;
    } else {
        var prn2 = c('resolveNode')(arr, rootId, parentRef);
        if (prn2.id === null) {
            if (prn2.how === 'ambiguous') throw new Error('有 ' + prn2.count + ' 个节点叫"' + parentRef + '"，请写完整路径。');
            throw c('nodeNotFoundError')(arr, rootId, parentRef);
        }
        parentId = prn2.id;
    }

    var parent = arr[parentId];
    var name = args.name || 'NewNode';

    var siblings = parent._children || [];
    for (var i = 0; i < siblings.length; i++) {
        var sib = arr[siblings[i].__id__];
        if (sib && sib._name === name) {
            throw new Error('"' + (parent._name || 'Scene') + '" 下已有同名子节点 "' + name + '"。' +
                '换个名字，或者先 scene_remove_node 删掉旧的。' +
                '（要传 allowDuplicate: true 可以允许同名。）');
        }
    }

    var templateId = pickNodeTemplate(arr, parentId);
    if (templateId < 0) {
        throw new Error('文件里一个 cc.Node 都没有，没法取模板。' +
            '新预制体请用 prefab_create 从 spec 生成（它自带节点模板）。');
    }

    var templateName = arr[templateId]._name || ('#' + templateId);

    var node = JSON.parse(JSON.stringify(arr[templateId]));
    node._name = name;
    node._parent = { __id__: parentId };
    node._children = [];
    node._components = [];
    node._prefab = null;
    // 预制体里的节点 _id 一律空串（引擎约定），场景里才要唯一 id
    node._id = kind === 'prefab' ? '' : newNodeId();

    // 模板可能不是"干净"节点（比如场景里找不到空节点时借用了一个带组件的），
    // 所以把这些会影响外观的值统一归位成新建节点的默认值。
    // 字段集合仍然来自模板，不会漏掉引擎需要的字段。
    node._active = true;
    node._opacity = 255;
    node._skewX = 0;
    node._skewY = 0;
    node._color = { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 };
    node._contentSize = { __type__: 'cc.Size', width: 0, height: 0 };
    node._anchorPoint = { __type__: 'cc.Vec2', x: 0.5, y: 0.5 };
    node._eulerAngles = { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 };

    // _trs = [x, y, z, qx, qy, qz, qw, sx, sy, sz]，先归位成单位变换
    if (node._trs && Array.isArray(node._trs.array) && node._trs.array.length >= 10) {
        node._trs.array = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    }

    if (args.position && node._trs && Array.isArray(node._trs.array) && node._trs.array.length >= 3) {
        if (typeof args.position.x === 'number') node._trs.array[0] = args.position.x;
        if (typeof args.position.y === 'number') node._trs.array[1] = args.position.y;
        if (typeof args.position.z === 'number') node._trs.array[2] = args.position.z;
    }

    var newId = arr.length;
    arr.push(node);

    // 预制体里每个节点都必须有 cc.PrefabInfo，否则编辑器一保存就把这个节点
    // 当成"外来节点"处理，fileId 身份丢失。场景里则必须是 null。
    var prefabInfoId = -1;
    if (kind === 'prefab') {
        prefabInfoId = arr.length;
        arr.push(makePrefabInfo(arr, rootId, false));
        node._prefab = { __id__: prefabInfoId };
    }

    if (!Array.isArray(parent._children)) parent._children = [];
    parent._children.push({ __id__: newId });

    return commitDoc(ctx, {
        added: {
            name: name,
            id: newId,
            template: templateName,
            parent: parent._name || (kind === 'prefab' ? 'Root' : 'Scene'),
            parentChildren: parent._children.length,
            prefabInfoId: prefabInfoId >= 0 ? prefabInfoId : null
        },
        kind: kind
    });
}

function toolSceneSetProps(args) {
    if (!args.node) throw new Error('缺少 node（要改的节点路径）');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var rn = c('resolveNode')(arr, ctx.rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw c('nodeNotFoundError')(arr, ctx.rootId, args.node);
    }
    var id = rn.id;

    var node = arr[id];
    if (node.__type__ !== 'cc.Node') throw new Error('目标不是 cc.Node：' + args.node);

    var changed = [];

    if (typeof args.name === 'string' && args.name && args.name !== node._name) {
        // 改名先查同级重名，否则场景里会出现两个同名节点，之后按路径定位就废了
        var parent = node._parent ? arr[node._parent.__id__] : null;
        var sibs = (parent && parent._children) || [];
        for (var i = 0; i < sibs.length; i++) {
            var sib = arr[sibs[i].__id__];
            if (sib && sib !== node && sib._name === args.name) {
                throw new Error('同级已有同名节点 "' + args.name + '"');
            }
        }
        node._name = args.name;
        changed.push('name');
    }

    if (typeof args.active === 'boolean' && args.active !== node._active) {
        node._active = args.active;
        changed.push('active');
    }

    // _trs.array = [x, y, z, qx, qy, qz, qw, sx, sy, sz]
    var trs = node._trs;
    var trsArr = (trs && Array.isArray(trs.array) && trs.array.length >= 10) ? trs.array : null;

    if (args.position) {
        if (!trsArr) throw new Error('这个节点的 _trs 不是预期格式，无法改位置');
        if (typeof args.position.x === 'number') trsArr[0] = args.position.x;
        if (typeof args.position.y === 'number') trsArr[1] = args.position.y;
        if (typeof args.position.z === 'number') trsArr[2] = args.position.z;
        changed.push('position');
    }

    if (args.scale) {
        if (!trsArr) throw new Error('这个节点的 _trs 不是预期格式，无法改缩放');
        if (typeof args.scale.x === 'number') trsArr[7] = args.scale.x;
        if (typeof args.scale.y === 'number') trsArr[8] = args.scale.y;
        changed.push('scale');
    }

    if (typeof args.opacity === 'number') {
        node._opacity = args.opacity;
        changed.push('opacity');
    }

    if (args.size) {
        if (!node._contentSize) node._contentSize = { __type__: 'cc.Size', width: 0, height: 0 };
        if (typeof args.size.width === 'number') node._contentSize.width = args.size.width;
        if (typeof args.size.height === 'number') node._contentSize.height = args.size.height;
        changed.push('size');
    }

    if (args.anchor) {
        if (!node._anchorPoint) node._anchorPoint = { __type__: 'cc.Vec2', x: 0.5, y: 0.5 };
        if (typeof args.anchor.x === 'number') node._anchorPoint.x = args.anchor.x;
        if (typeof args.anchor.y === 'number') node._anchorPoint.y = args.anchor.y;
        changed.push('anchor');
    }

    if (!changed.length) {
        return { changed: [], note: '没有需要改的字段：参数没给，或者值和现状相同' };
    }

    return commitDoc(ctx, {
        node: node._name,
        changed: changed,
        kind: ctx.kind
    });
}

//#region 组件操作（文件级）

/**
 * 把组件类型描述解析成 .fire 里要写的 __type__。
 *
 * 支持四种写法：
 *   cc.Sprite                      内置组件类名
 *   assets/xxx/Foo.ts              脚本路径
 *   完整 uuid / 23 位压缩 uuid      脚本 uuid
 *   Foo                            脚本里的类名（会扫一遍脚本建索引，结果缓存）
 */
function resolveComponentType(typeStr) {
    var t = String(typeStr === undefined || typeStr === null ? '' : typeStr).trim();
    if (!t) throw new Error('缺少 type');

    if (/^cc\.[A-Za-z0-9_]+$/.test(t)) {
        return { type: t, kind: 'builtin', path: null, className: t.slice(3) };
    }

    var idx = c('buildUuidIndex')();

    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(t)) {
        var relFull = idx.byFull[t] || null;
        var infoFull = relFull ? (c('readScriptInfo')(relFull) || {}) : {};
        return { type: c('compressUuid')(t), kind: 'script', path: relFull, className: infoFull.className || null };
    }

    if (t.length === 23 && idx.byShort[t]) {
        var full = idx.byShort[t];
        var relShort = idx.byFull[full] || null;
        var infoShort = relShort ? (c('readScriptInfo')(relShort) || {}) : {};
        return { type: t, kind: 'script', path: relShort, className: infoShort.className || null };
    }

    if (t.indexOf('/') >= 0 || /\.(ts|js)$/i.test(t)) {
        if (!c('statSafe')(c('safePath')(t))) throw new Error('找不到脚本文件：' + t);
        var u = c('pathToUuid')(t);
        if (!u) throw new Error('这个文件查不到 uuid，是不是缺 .meta：' + t);
        var info = c('readScriptInfo')(t) || {};
        return { type: c('compressUuid')(u), kind: 'script', path: t, className: info.className || null };
    }

    var hit = findScriptByClassName(t);
    if (hit) {
        return { type: c('compressUuid')(hit.uuid), kind: 'script', path: hit.path, className: t };
    }

    throw new Error('认不出组件类型 "' + t + '"（可用：cc.XXX / 脚本路径 / uuid / 脚本类名）');
}

var classNameCache = { time: 0, root: null, map: {} };

function findScriptByClassName(name) {
    var root = c('projectRoot')();
    var now = Date.now();

    if (classNameCache.root !== root || (now - classNameCache.time) > UUID_CACHE_MS) {
        var idx = c('buildUuidIndex')();
        var map = {};
        for (var full in idx.byFull) {
            if (!Object.prototype.hasOwnProperty.call(idx.byFull, full)) continue;
            var rel = idx.byFull[full];
            if (!/\.(ts|js)$/i.test(rel)) continue;

            var info = c('readScriptInfo')(rel);
            if (!info) continue;
            if (info.className && !map[info.className]) map[info.className] = { uuid: full, path: rel };
            if (info.ccclassName && !map[info.ccclassName]) map[info.ccclassName] = { uuid: full, path: rel };
        }
        classNameCache = { time: now, root: root, map: map };
    }

    return classNameCache.map[name] || null;
}

/** {asset: "uuid 或 路径"} → {__uuid__: 完整 uuid}；其余值原样写入 */
function resolveAssetUuid(ref) {
    var r = String(ref).trim();
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(r)) return r;

    var idx = c('buildUuidIndex')();
    if (r.length === 23 && idx.byShort[r]) return idx.byShort[r];

    var u = c('pathToUuid')(r);
    if (!u) throw new Error('资源引用解析不出 uuid：' + ref);
    return u;
}

function applyComponentProps(obj, props) {
    if (!props) return [];
    var applied = [];
    for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v && typeof v === 'object' && typeof v.asset === 'string') {
            obj[k] = { __uuid__: resolveAssetUuid(v.asset) };
        } else {
            obj[k] = v;
        }
        applied.push(k);
    }
    return applied;
}

/** 在节点的组件里找目标。typeStr 可以是下标、__type__、cc.XXX、脚本路径、类名 */
function findComponentIndex(arr, node, typeStr) {
    var comps = node._components || [];
    var s = String(typeStr === undefined || typeStr === null ? '' : typeStr).trim();
    if (!s) throw new Error('缺少 type');

    if (/^\d+$/.test(s)) {
        var i0 = parseInt(s, 10);
        if (i0 < 0 || i0 >= comps.length) throw new Error('组件下标越界：' + s + '（该节点共 ' + comps.length + ' 个组件）');
        return comps[i0].__id__;
    }

    // 先按 __type__ 直接比，再退回类型解析
    var want = [s];
    try {
        want.push(resolveComponentType(s).type);
    } catch (e) {
        // 解析不出来就只按字面量比
    }
    try {
        want.push(c('compressUuid')(s));
    } catch (e2) {
        // s 不是 uuid，忽略
    }

    for (var i = 0; i < comps.length; i++) {
        var o = arr[comps[i].__id__];
        if (!o) continue;
        for (var w = 0; w < want.length; w++) {
            if (o.__type__ === want[w]) return comps[i].__id__;
        }
    }
    throw new Error('节点上没有这个组件：' + s);
}

function toolSceneAddComponent(args) {
    if (!args.node) throw new Error('缺少 node（挂到哪个节点）');
    if (!args.type) throw new Error('缺少 type（组件类型）');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var rn = c('resolveNode')(arr, ctx.rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw c('nodeNotFoundError')(arr, ctx.rootId, args.node);
    }
    var nodeId = rn.id;

    var node = arr[nodeId];
    if (node.__type__ !== 'cc.Node') throw new Error('目标不是 cc.Node：' + args.node);

    var resolved = resolveComponentType(args.type);

    // 同一个节点不允许挂两个同类型组件（cc.Widget 之类也一样）
    var exist = node._components || [];
    for (var i = 0; i < exist.length; i++) {
        var existing = arr[exist[i].__id__];
        if (existing && existing.__type__ === resolved.type) {
            throw new Error('节点上已经有同类型组件了：' + resolved.type +
                (resolved.className ? '（' + resolved.className + '）' : ''));
        }
    }

    // 优先克隆场景里已有的同类组件：字段最全，不用猜 @property 默认值
    var from = 'minimal';
    var obj = null;
    for (var j = 0; j < arr.length; j++) {
        var cand = arr[j];
        if (!cand || cand.__type__ !== resolved.type) continue;
        if (cand.__type__ === 'cc.Node' || cand.__type__ === 'cc.Scene') continue;
        obj = JSON.parse(JSON.stringify(cand));
        from = 'clone#' + j + (arr[cand.node && cand.node.__id__] ? '（' + (arr[cand.node.__id__]._name || '?') + '）' : '');
        break;
    }

    if (!obj) {
        // 最小对象：缺的字段交给引擎反序列化时按类默认值补齐
        obj = {
            __type__: resolved.type,
            _name: '',
            _objFlags: 0,
            node: { __id__: nodeId },
            _enabled: true
        };
    }

    obj.node = { __id__: nodeId };
    obj._enabled = args.enabled === false ? false : true;
    obj._objFlags = 0;
    if (obj._name === undefined) obj._name = '';
    // 组件在预制体里同样不带 _id（和节点一个规矩）
    if (ctx.kind === 'prefab') obj._id = '';

    var applied = applyComponentProps(obj, args.props);

    var newId = arr.length;
    arr.push(obj);

    if (!Array.isArray(node._components)) node._components = [];
    node._components.push({ __id__: newId });

    // 自检分两步：
    //   1) 先查内存 —— 批量模式下只有内存（文件还没写）
    //   2) 落盘后再读回来确认 —— 这一步才真的验证"文件里的组件挂对了"
    var memOk = ctx.arr[newId] && ctx.arr[newId].node && ctx.arr[newId].node.__id__ === nodeId;
    if (!memOk) {
        throw new Error('组件没有挂到节点上（内存自检失败），请把这条报给维护者');
    }

    var out = commitDoc(ctx, {
        added: {
            component: resolved.type,
            className: resolved.className,
            kind: resolved.kind,
            id: newId,
            from: from,
            props: applied
        },
        node: node._name || args.node,
        kind: ctx.kind
    });

    if (!ctx.defer) {
        var check = c('loadSerialized')(ctx.abs);
        var attached = check[newId] && check[newId].node && check[newId].node.__id__ === nodeId;
        if (!attached) {
            throw new Error('写入后自检失败：文件里的组件没有正确挂到节点上，请检查 ' +
                (ctx.kind === 'prefab' ? '.prefab' : '.fire'));
        }
    }
    return out;
}

function toolSceneRemoveComponent(args) {
    if (!args.node) throw new Error('缺少 node');
    if (!args.type) throw new Error('缺少 type');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var rn = c('resolveNode')(arr, ctx.rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw c('nodeNotFoundError')(arr, ctx.rootId, args.node);
    }
    var nodeId = rn.id;

    var node = arr[nodeId];
    var compId = findComponentIndex(arr, node, args.type);
    var comp = arr[compId];

    var deleteSet = {};
    deleteSet[compId] = true;

    // 先从 node._components 摘掉，否则它自己会被算成"外部引用"
    var comps = node._components || [];
    for (var i = 0; i < comps.length; i++) {
        if (comps[i] && comps[i].__id__ === compId) { comps.splice(i, 1); break; }
    }

    // 组件可能被别的地方引用（比如 Button.target 指向它），有就拒绝
    var hits = [];
    for (var j = 0; j < arr.length; j++) {
        if (deleteSet[j]) continue;
        scanRefs(arr[j], deleteSet, j, hits);
    }
    if (hits.length) {
        var detail = hits.slice(0, 5).map(function (h) {
            var o = arr[h.owner];
            return '#' + h.owner + '（' + ((o && o.__type__) || '?') + '）';
        }).join('，');
        throw new Error('拒绝删除：还有 ' + hits.length + ' 处引用指向这个组件（' + detail +
            (hits.length > 5 ? ' 等' : '') + '），先解除这些引用');
    }

    var newArr = [];
    var map = {};
    for (var m = 0; m < arr.length; m++) {
        if (deleteSet[m]) continue;
        map[m] = newArr.length;
        newArr.push(arr[m]);
    }
    for (var r = 0; r < newArr.length; r++) rewriteRefs(newArr[r], map);

    return commitDoc(ctx, {
        removed: comp.__type__,
        componentId: compId,
        node: node._name || args.node,
        objectsBefore: arr.length,
        objectsAfter: newArr.length,
        kind: ctx.kind
    }, newArr);
}

function toolSceneSetComponentProps(args) {
    if (!args.node) throw new Error('缺少 node');
    if (!args.type) throw new Error('缺少 type');
    if (!args.props || typeof args.props !== 'object') throw new Error('缺少 props（要改的字段对象）');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var rn = c('resolveNode')(arr, ctx.rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw c('nodeNotFoundError')(arr, ctx.rootId, args.node);
    }
    var nodeId = rn.id;

    var node = arr[nodeId];
    var compId = findComponentIndex(arr, node, args.type);
    var comp = arr[compId];

    var applied = applyComponentProps(comp, args.props);
    if (!applied.length) return { changed: [], note: 'props 是空的，什么都没改' };

    return commitDoc(ctx, {
        component: comp.__type__,
        node: node._name || args.node,
        changed: applied,
        kind: ctx.kind
    });
}

//#endregion

//#region 预制体

/**
 * 把预制体拷进场景，变成普通节点。
 *
 * 为什么默认不保留预制体关联（cc.PrefabInfo）：带关联的实例改任何一个字段，
 * 下次预制体更新就会被回滚，AI 想自由改场景反而是阻碍。需要"活实例"是少数场景，
 * 以后可以加 asInstance 开关。
 *
 * 拷贝时做三件事：
 *   1. 从预制体根节点出发收集可达对象（cc.Prefab 自身和 cc.PrefabInfo 不拷）
 *   2. 建 旧下标 → 新下标 映射，重写所有内部 __id__ 引用
 *   3. 所有节点重新生成 _id，根节点的 _parent 指向场景里的父节点
 */
function toolPrefabInstantiate(args) {
    if (!args.prefab) throw new Error('缺少 prefab（预制体路径）');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var prefabAbs = c('safePath')(args.prefab);
    if (!c('statSafe')(prefabAbs)) throw new Error('找不到预制体：' + args.prefab);

    var pf = c('loadSerialized')(prefabAbs);
    if (!pf.length || !pf[0] || pf[0].__type__ !== 'cc.Prefab') {
        throw new Error('不是 cc.Prefab 文件：' + args.prefab);
    }

    var rootIdx = pf[0].data && pf[0].data.__id__;
    if (typeof rootIdx !== 'number' || !pf[rootIdx] || pf[rootIdx].__type__ !== 'cc.Node') {
        throw new Error('预制体里找不到根节点（data.__id__ 没指向 cc.Node）');
    }

    var parentRef = args.parent || 'Scene';
    var parentId;
    if (isRootRef(parentRef, ctx.kind)) {
        parentId = ctx.rootId;
    } else {
        var prn = c('resolveNode')(arr, ctx.rootId, parentRef);
        if (prn.id === null) {
            if (prn.how === 'ambiguous') throw new Error('有 ' + prn.count + ' 个节点叫"' + parentRef + '"，请写完整路径。');
            throw c('nodeNotFoundError')(arr, ctx.rootId, parentRef);
        }
        parentId = prn.id;
    }
    var parent = arr[parentId];

    var name = args.name || pf[rootIdx]._name || 'Prefab';

    var siblings = parent._children || [];
    for (var i = 0; i < siblings.length; i++) {
        var sib = arr[siblings[i].__id__];
        if (sib && sib._name === name) {
            throw new Error('"' + (parent._name || 'Scene') + '" 下已有同名子节点 "' + name + '"。' +
                '换个名字，或者先 scene_remove_node 删掉旧的。' +
                '（要传 allowDuplicate: true 可以允许同名。）');
        }
    }

    // 1) 收集可达对象，跳过 cc.PrefabInfo
    var order = [];
    var seen = {};

    (function collect(id) {
        if (seen[id]) return;
        var o = pf[id];
        if (!o) return;
        seen[id] = true;
        if (o.__type__ === 'cc.PrefabInfo') return;

        order.push(id);

        var kids = o._children || [];
        for (var a = 0; a < kids.length; a++) collect(kids[a].__id__);

        var comps = o._components || [];
        for (var b = 0; b < comps.length; b++) collect(comps[b].__id__);
    })(rootIdx);

    if (!order.length) throw new Error('预制体里没有可拷贝的对象');

    // 2) 建映射并深拷贝
    var map = {};
    var clones = [];
    for (var k = 0; k < order.length; k++) {
        map[order[k]] = arr.length + k;
        clones.push(JSON.parse(JSON.stringify(pf[order[k]])));
    }

    // 先把预制体关联摘掉，免得下面的通用重写碰到 PrefabInfo
    for (var ci = 0; ci < clones.length; ci++) {
        if (clones[ci].__type__ === 'cc.Node') clones[ci]._prefab = null;
    }

    // 3) 重写内部引用
    (function rewrite(obj) {
        if (obj === null || typeof obj !== 'object') return;

        if (Array.isArray(obj)) {
            for (var m = 0; m < obj.length; m++) rewrite(obj[m]);
            return;
        }

        if (typeof obj.__id__ === 'number') {
            var old = obj.__id__;
            if (map[old] === undefined) {
                var t = pf[old];
                throw new Error('预制体里有指向自身外部的引用 #' + old +
                    '（' + ((t && t.__type__) || '未知') + '），拷进场景后会悬空，已放弃');
            }
            obj.__id__ = map[old];
            return;
        }

        for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) rewrite(obj[key]);
        }
    })(clones);

    // 4) 挂到父节点、重新生成 _id
    for (var n = 0; n < clones.length; n++) {
        if (clones[n].__type__ === 'cc.Node') {
            clones[n]._id = ctx.kind === 'prefab' ? '' : newNodeId();
        }
        if (clones[n].__type__ !== 'cc.Node' && ctx.kind === 'prefab') clones[n]._id = '';
    }

    var rootClone = clones[map[rootIdx] - arr.length];
    rootClone._name = name;
    rootClone._parent = { __id__: parentId };

    for (var q = 0; q < clones.length; q++) arr.push(clones[q]);

    // 拷进**预制体**时还得给每个新节点补 PrefabInfo —— 预制体里没有 _prefab
    // 的节点是非法结构，编辑器一保存就会把它当外来对象处理
    var infoAdded = 0;
    if (ctx.kind === 'prefab') {
        for (var n2 = 0; n2 < clones.length; n2++) {
            if (clones[n2].__type__ !== 'cc.Node') continue;
            var infoId = arr.length;
            arr.push(makePrefabInfo(arr, ctx.rootId, false));
            clones[n2]._prefab = { __id__: infoId };
            infoAdded++;
        }
    }

    if (!Array.isArray(parent._children)) parent._children = [];
    parent._children.push({ __id__: map[rootIdx] });

    return commitDoc(ctx, {
        instantiated: {
            prefab: path.relative(c('projectRoot')(), prefabAbs).replace(/\\/g, '/'),
            rootId: map[rootIdx],
            name: name,
            parent: parent._name || (ctx.kind === 'prefab' ? 'Root' : 'Scene'),
            objects: clones.length,
            nodes: clones.filter(function (o) { return o.__type__ === 'cc.Node'; }).length,
            prefabInfoAdded: infoAdded
        },
        kind: ctx.kind,
        note: '拷成的是普通节点，不带预制体关联。' + saveNote(ctx.kind)
    });
}

//#endregion

/** 收集要被一起删掉的对象：节点本身 + 组件 + 所有子孙 + 各自的组件 + 预制体信息 */
function collectDeletionSet(arr, id, set) {
    if (set[id]) return;
    var o = arr[id];
    if (!o) return;
    set[id] = true;

    var comps = o._components || [];
    for (var ci = 0; ci < comps.length; ci++) collectDeletionSet(arr, comps[ci].__id__, set);

    var kids = o._children || [];
    for (var k = 0; k < kids.length; k++) collectDeletionSet(arr, kids[k].__id__, set);

    if (o._prefab && typeof o._prefab.__id__ === 'number') {
        collectDeletionSet(arr, o._prefab.__id__, set);
    }
}

/** 扫出所有指向 deleteSet 的 __id__ 引用（owner 是引用方下标） */
function scanRefs(obj, deleteSet, owner, hits) {
    if (obj === null || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) scanRefs(obj[i], deleteSet, owner, hits);
        return;
    }

    if (typeof obj.__id__ === 'number') {
        if (deleteSet[obj.__id__]) hits.push({ owner: owner, id: obj.__id__ });
        return;
    }

    for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) scanRefs(obj[k], deleteSet, owner, hits);
    }
}

function rewriteRefs(obj, map) {
    if (obj === null || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) rewriteRefs(obj[i], map);
        return;
    }

    if (typeof obj.__id__ === 'number') {
        var n = map[obj.__id__];
        if (n === undefined) {
            throw new Error('内部错误：重映射时引用了已被删除的对象 #' + obj.__id__);
        }
        obj.__id__ = n;
        return;
    }

    for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) rewriteRefs(obj[k], map);
    }
}

function toolSceneRemoveNode(args) {
    if (!args.node) throw new Error('缺少 node（要删的节点路径）');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var rn = c('resolveNode')(arr, ctx.rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw c('nodeNotFoundError')(arr, ctx.rootId, args.node);
    }
    var id = rn.id;
    if (id === ctx.rootId) {
        throw new Error('不能删除' + (ctx.kind === 'prefab' ? '预制体根节点' : '场景根节点'));
    }

    var node = arr[id];
    if (node.__type__ !== 'cc.Node') throw new Error('目标不是 cc.Node：' + args.node);
    if (!node._parent || typeof node._parent.__id__ !== 'number') {
        throw new Error('这个节点没有父节点引用，不敢删');
    }

    var parentId = node._parent.__id__;
    var parent = arr[parentId];

    var deleteSet = {};
    collectDeletionSet(arr, id, deleteSet);

    // 先摘掉父节点 _children 里的那条引用，否则它自己就会被算成"外部引用"
    var kids = (parent && parent._children) || [];
    for (var i = 0; i < kids.length; i++) {
        if (kids[i] && kids[i].__id__ === id) {
            kids.splice(i, 1);
            break;
        }
    }

    // 安全阀：只要还有别的对象引用被删子树，直接拒绝。
    // 硬删会留下悬空引用，比"删不掉"恶劣得多。反正没写文件，arr 已经脏了也无所谓。
    var hits = [];
    for (var j = 0; j < arr.length; j++) {
        if (deleteSet[j]) continue;
        scanRefs(arr[j], deleteSet, j, hits);
    }
    if (hits.length) {
        var detail = hits.slice(0, 5).map(function (h) {
            var o = arr[h.owner];
            return '#' + h.owner + '（' + ((o && o.__type__) || '?') + '）→ #' + h.id;
        }).join('，');
        throw new Error(
            '拒绝删除：还有 ' + hits.length + ' 处外部引用指向这棵子树（' + detail +
            (hits.length > 5 ? ' 等' : '') + '）。硬删会留下悬空引用，请先在编辑器里解除这些引用。'
        );
    }

    var newArr = [];
    var map = {};
    for (var m = 0; m < arr.length; m++) {
        if (deleteSet[m]) continue;
        map[m] = newArr.length;
        newArr.push(arr[m]);
    }
    for (var r = 0; r < newArr.length; r++) rewriteRefs(newArr[r], map);

    return commitDoc(ctx, {
        removed: node._name,
        deletedObjects: Object.keys(deleteSet).length,
        objectsBefore: arr.length,
        objectsAfter: newArr.length,
        kind: ctx.kind
    }, newArr);
}


//#region 批量操作（scene_apply 的引擎）

/**
 * op 名 → 实现。
 *
 * 归一化规则：去掉 `_` `-` 空格、转小写。所以 addNode / add_node / ADD_NODE 都能用。
 * 只认 `op` 字段，不认 `type` —— 组件操作里的 `type` 是组件类型，撞了会很难查。
 */
function opImpls() {
    return {
        addnode: toolSceneAddNode,
        setprops: toolSceneSetProps,
        removenode: toolSceneRemoveNode,
        movenode: function (a) { return c('moveNode')(a); },
        addcomponent: toolSceneAddComponent,
        removecomponent: toolSceneRemoveComponent,
        setcomponentprops: toolSceneSetComponentProps,
        addprefab: function (a) { return toolPrefabInstantiate(a); }
    };
}

/**
 * 在**同一个文档**上依次应用多个操作，不落盘。
 *
 * 这是"批量改 20 个节点"的关键：解析一次、改在内存里、最后统一提交。
 * 任何一步抛错就整批放弃 —— 文件一个字节都没动，不会留半成品。
 *
 * 调用方（main.js 的 toolSceneApply）负责：写盘、刷新资源、dry-run 时只回报。
 */
function applyOps(ctx, ops) {
    if (!Array.isArray(ops) || !ops.length) {
        throw new Error('ops 必须是非空数组。每个操作长这样：' +
            '{"op":"setProps","node":"panel/title","position":{"x":0,"y":500}}');
    }

    var table = opImpls();
    var before = c('summarizeDoc')(ctx.arr);
    var results = [];

    ctx.defer = true;
    for (var i = 0; i < ops.length; i++) {
        var op = ops[i] || {};
        var raw = op.op;
        if (!raw) {
            throw new Error('第 ' + (i + 1) + ' 个操作缺少 op 字段。可用：' +
                Object.keys(table).join(' / ') + '（下划线、大小写都行）');
        }
        var key = String(raw).replace(/[_\s-]/g, '').toLowerCase();
        var fn = table[key];
        if (!fn) {
            throw new Error('第 ' + (i + 1) + ' 个操作的 op 不认识："' + raw + '"。可用：' +
                Object.keys(table).join(' / '));
        }

        var a = {};
        for (var k in op) {
            if (Object.prototype.hasOwnProperty.call(op, k) && k !== 'op') a[k] = op[k];
        }
        a.__doc = ctx;

        var r;
        try {
            r = fn(a);
        } catch (e) {
            throw new Error('第 ' + (i + 1) + ' 个操作（' + raw + '）失败，整批放弃、文件未改：' +
                (e && e.message ? e.message : e));
        }
        results.push({ index: i, op: String(raw), result: r });
    }

    return {
        before: before,
        after: c('summarizeDoc')(ctx.arr),
        results: results,
        problems: c('validateDoc')(ctx.arr, ctx.kind)
    };
}

//#endregion

module.exports = {
    setContext: setContext,
    findSceneRootId: findSceneRootId,
    findRootForEdit: findRootForEdit,
    isRootRef: isRootRef,
    newNodeId: newNodeId,
    makePrefabInfo: makePrefabInfo,
    saveNote: saveNote,
    pickNodeTemplate: pickNodeTemplate,
    loadSceneForEdit: loadSceneForEdit,
    openDocForEdit: openDocForEdit,
    commitDoc: commitDoc,
    applyOps: applyOps,
    saveSceneFile: saveSceneFile,
    toolSceneAddNode: toolSceneAddNode,
    toolSceneSetProps: toolSceneSetProps,
    resolveComponentType: resolveComponentType,
    findScriptByClassName: findScriptByClassName,
    resolveAssetUuid: resolveAssetUuid,
    applyComponentProps: applyComponentProps,
    findComponentIndex: findComponentIndex,
    toolSceneAddComponent: toolSceneAddComponent,
    toolSceneRemoveComponent: toolSceneRemoveComponent,
    toolSceneSetComponentProps: toolSceneSetComponentProps,
    toolPrefabInstantiate: toolPrefabInstantiate,
    collectDeletionSet: collectDeletionSet,
    scanRefs: scanRefs,
    rewriteRefs: rewriteRefs,
    toolSceneRemoveNode: toolSceneRemoveNode
};
