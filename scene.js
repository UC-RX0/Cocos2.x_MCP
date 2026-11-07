'use strict';

/**
 * cocos-mcp-2x 场景脚本 —— 跑在场景窗口（渲染进程）里，可以直接用 cc，也能 require。
 *
 * 注册：package.json 的 "scene-script": "scene.js"。**只在编辑器启动时加载**，
 * 改了这个文件必须重启编辑器，热重载不覆盖场景进程。
 *
 * 调用（主进程侧）：Editor.Ipc.sendToPanel('scene', 'cocos-mcp-2x:<method>', payload, cb)
 *
 * 回传：2.4 的场景脚本只收不回——消息会送到、方法会执行，但返回值不会被 reply 回来。
 * 所以这里用文件信箱：主进程在 payload 里塞 __id 和 __res（结果文件的绝对路径），
 * 执行完把 { __scene, ok, data|error } 写进 __res，主进程轮询取回。
 *
 * 注意：写 scene.js 时不要用 ?. / ?? / Array.flat —— 场景进程跑的是编辑器内置的旧 Node。
 */

/**
 * 场景进程的文件系统能力不保证有。node-binder 用的是 'fire-fs' 而不是 'fs'，
 * 说明渲染进程里 'fs' 不一定能直接 require。两个都试，拿不到也不致命——
 * 回传还有 sendToMain 这条主通道。
 */
var fsModule = null;
try {
    var names = ['fire-fs', 'fs'];
    for (var i = 0; i < names.length; i++) {
        try {
            var m = require(names[i]);
            if (m && typeof m.writeFileSync === 'function') {
                fsModule = m;
                break;
            }
        } catch (e) {
            // 换下一个
        }
    }
} catch (e2) {
    fsModule = null;
}

var httpModule = null;
try {
    httpModule = require('http');
} catch (e3) {
    httpModule = null;
}

var MARK = '__scene';

/**
 * 回传结果，四条路依次尝试（前一条成功也继续试，提高送达率）：
 *   1. HTTP POST 回主进程的 /scene-result —— 最可靠，只要渲染进程能 require('http')
 *   2. Editor.Ipc.sendToMain —— 常规通道，实测可能被路由丢掉
 *   3. 文件信箱（payload.__res）
 *   4. Editor.log —— 全断了至少别静默
 */
function report(payload, envelope, evt) {
    if (payload && payload.__id) envelope.__id = payload.__id;

    var delivered = false;

    // 0) evt 回传 —— 2.4 场景脚本处理器第一个参数就是引擎注入的事件对象，
    //    它通常带 reply/send 能力。这是官方通道，优先级最高。
    if (evt && typeof evt === 'object') {
        try {
            var evtKeys = Object.keys(evt);
            // 记下 evt 上有什么，诊断用
            envelope.__evtKeys = evtKeys;
            if (typeof evt.reply === 'function') {
                evt.reply(envelope);
                delivered = true;
            } else if (typeof evt.send === 'function') {
                evt.send(envelope);
                delivered = true;
            } else if (typeof evt.returnValue !== 'undefined') {
                evt.returnValue = envelope;
                delivered = true;
            } else if (typeof evt.sender !== 'undefined' && evt.sender &&
                       typeof evt.sender.send === 'function') {
                evt.sender.send(envelope);
                delivered = true;
            }
        } catch (e) {
            envelope.__evtError = String(e.message || e).slice(0, 120);
        }
    }

    // 1) HTTP
    if (!delivered && httpModule && payload && payload.__port) {
        try {
            var body = JSON.stringify(envelope);
            var req = httpModule.request({
                host: '127.0.0.1',
                port: payload.__port,
                path: '/scene-result',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': typeof Buffer !== 'undefined' ? Buffer.byteLength(body) : body.length
                }
            }, function (res) {
                try { res.resume(); } catch (e) { /* 忽略 */ }
            });
            req.on('error', function () { /* 由后面的通道兜底 */ });
            req.write(body);
            req.end();
            delivered = true;
        } catch (e) {
            // 落到下一条
        }
    }

    // 2) IPC：两种形式都试 —— 带包名前缀的，和短名的
    try {
        if (typeof Editor !== 'undefined' && Editor.Ipc &&
            typeof Editor.Ipc.sendToMain === 'function') {
            Editor.Ipc.sendToMain('cocos-mcp-2x:scene-result', envelope);
            delivered = true;
        }
    } catch (e) {
        // 落到下一条
    }
    if (!delivered) {
        try {
            if (typeof Editor !== 'undefined' && Editor.Ipc &&
                typeof Editor.Ipc.sendToMain === 'function') {
                Editor.Ipc.sendToMain('scene-result', envelope);
                delivered = true;
            }
        } catch (e) {
            // 落到下一条
        }
    }

    // 3) 文件信箱
    if (fsModule && payload && payload.__res) {
        try {
            fsModule.writeFileSync(payload.__res, JSON.stringify(envelope), 'utf8');
            delivered = true;
        } catch (e) {
            // 忽略
        }
    }

    // 4) 兜底日志
    if (!delivered) {
        try {
            Editor.log('[cocos-mcp-2x] 回传全断，结果如下：' + JSON.stringify(envelope).slice(0, 400));
        } catch (e) {
            // 真的没辙了
        }
    }
}

/**
 * 处理器包装。
 *
 * 关键：2.4 的场景脚本处理器签名是 **(evt, payload)** —— 第一个参数是引擎注入的事件对象，
 * 真正的业务参数在第二个。参照引擎自带的 node-binder：
 *
 *     function update_nodes(evt, uuid) { ... }
 *     scene.update_nodes = update_nodes;
 *
 * 所以这里不能只接第一个参数 —— 那样业务参数会被当成 evt 丢掉。
 * 同时保留兼容：万一某些版本只传一个参数，就按"第一个是 payload"处理。
 */
function wrap(fn) {
    return function (a, b) {
        // 两个参数都有 → (evt, payload)；只有一个 → (payload)
        var evt = a;
        var payload = (b === undefined) ? (a || {}) : (b || {});

        var env;
        try {
            env = { __scene: 1, ok: true, data: fn(payload || {}, evt) };
        } catch (e) {
            env = { __scene: 1, ok: false, error: (e && e.message) ? e.message : String(e) };
            try { Editor.error('[cocos-mcp-2x] ' + env.error); } catch (e2) { /* 忽略 */ }
        }
        report(payload, env, evt);
        return env;
    };
}

function sceneRoot() {
    return cc.director.getScene();
}

/** 节点 → "Canvas/bottomUI"，不含 Scene 根 */
function pathOf(node) {
    var parts = [];
    var root = sceneRoot();
    var cur = node;
    while (cur && cur !== root) {
        if (cur.name) parts.unshift(cur.name);
        cur = cur.parent;
    }
    return parts.join('/');
}

/** "Canvas/bottomUI" → node。首段 Scene 可省，和 query_scene_tree 的口径保持一致 */
function findByPath(root, pathStr) {
    if (!pathStr || pathStr === '/' || pathStr === 'Scene') return root;

    var segs = String(pathStr).split('/');
    if (segs[0] === 'Scene') segs.shift();

    var cur = root;
    for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        if (!seg) continue;

        var next = null;
        for (var j = 0; j < cur.children.length; j++) {
            if (cur.children[j].name === seg) { next = cur.children[j]; break; }
        }
        if (!next) {
            throw new Error('找不到节点 "' + pathStr + '"：第 ' + (i + 1) + ' 段 "' + seg +
                '" 在 "' + (cur.name || 'Scene') + '" 下不存在');
        }
        cur = next;
    }
    return cur;
}

/**
 * 环境探针 —— 一次性测出场景进程到底有什么能力。
 *
 * 为什么需要：2.4 的场景脚本通道"只收不回"，四种回传机制（HTTP / 文件信箱 /
 * sendToMain / 日志）实测全灭。但到底是哪一环断了，一直没查清 ——
 * 可能是场景进程里根本没有 require、或者 Editor.Message 不存在。
 * 这个探针把答案带出来。
 *
 * 结果同时走多条通道，不管哪条通都能拿到。
 */
exports.probe = wrap(function (args, evt) {
    var out = {};
    var port = (args && args.__port) || 0;

    try { out.processType = process.type; } catch (e) { out.processType = 'ERR'; }
    try { out.hasRequire = typeof require; } catch (e) { out.hasRequire = 'ERR'; }
    try { out.hasWindow = typeof window; } catch (e) { out.hasWindow = 'ERR'; }
    try { out.hasDocument = typeof document; } catch (e) { out.hasDocument = 'ERR'; }

    // evt 是什么？这是最关键的信息
    out.evt = {
        type: typeof evt,
        keys: (evt && typeof evt === 'object') ? Object.keys(evt) : null,
        ctor: (evt && evt.constructor) ? evt.constructor.name : null
    };
    if (evt && typeof evt === 'object') {
        var proto = Object.getOwnPropertyNames(Object.getPrototypeOf(evt) || {});
        out.evt.protoKeys = proto;
        out.evt.methods = [];
        for (var p = 0; p < proto.length; p++) {
            var k = proto[p];
            if (k === 'constructor') continue;
            try { out.evt.methods.push(k + ':' + typeof evt[k]); } catch (e) { /* 忽略 */ }
        }
    }

    // 模块可用性
    var mods = ['http', 'https', 'fs', 'fire-fs', 'child_process', 'net', 'electron', 'cc'];
    out.modules = {};
    for (var i = 0; i < mods.length; i++) {
        try {
            var m = require(mods[i]);
            out.modules[mods[i]] = m ? 'ok' : 'null';
        } catch (e) {
            out.modules[mods[i]] = 'ERR:' + String(e.message || e).slice(0, 60);
        }
    }

    // Editor 对象上有什么
    try {
        out.editor = {
            hasMessage: typeof Editor.Message,
            hasIpc: typeof Editor.Ipc,
            hasIpcListener: typeof Editor.IpcListener,
            hasScene: typeof Editor.Scene,
            hasPackage: typeof Editor.Package,
            messageKeys: Editor.Message ? Object.keys(Editor.Message).sort() : null,
            ipcKeys: Editor.Ipc ? Object.keys(Editor.Ipc).sort() : null
        };
    } catch (e) {
        out.editor = { err: String(e.message || e).slice(0, 80) };
    }

    // 能不能发 IPC 给主进程
    out.sendToMainTry = [];
    try {
        if (Editor.Ipc && typeof Editor.Ipc.sendToMain === 'function') {
            Editor.Ipc.sendToMain('cocos-mcp-2x:probe', { __probe: 1, at: Date.now() });
            out.sendToMainTry.push('called');
        } else {
            out.sendToMainTry.push('no-sendToMain');
        }
    } catch (e) {
        out.sendToMainTry.push('throw:' + String(e.message || e).slice(0, 80));
    }

    // 文件信箱能不能写
    out.fileWrite = null;
    if (fsModule && args && args.__probeMarker) {
        try {
            fsModule.writeFileSync(args.__probeMarker, JSON.stringify(out), 'utf8');
            out.fileWrite = 'written';
        } catch (e) {
            out.fileWrite = 'ERR:' + String(e.message || e).slice(0, 80);
        }
    } else {
        out.fileWrite = fsModule ? 'no-marker-path' : 'no-fsModule';
    }

    // 也用 fire-fs 的另一条路试一次（有些版本只有它能写）
    if (out.fileWrite !== 'written' && args && args.__probePosix) {
        try {
            var fireFs = require('fire-fs');
            fireFs.writeFileSync(args.__probePosix, JSON.stringify(out), 'utf8');
            out.fileWritePosix = 'written';
        } catch (e) {
            out.fileWritePosix = 'ERR:' + String(e.message || e).slice(0, 80);
        }
    }

    return out;
});

/**
 * 新建空节点挂到父节点下。
 * payload: { parent?: string, name?: string, allowDuplicate?: boolean }
 */
exports.addNode = wrap(function (args) {
    var root = sceneRoot();
    if (!root) throw new Error('场景还没加载');

    var parent = findByPath(root, args.parent);
    var name = args.name || 'NewNode';

    if (!args.allowDuplicate) {
        for (var i = 0; i < parent.children.length; i++) {
            if (parent.children[i].name === name) {
                throw new Error('"' + (parent.name || 'Scene') + '" 下已有同名子节点 "' + name + '"');
            }
        }
    }

    var node = new cc.Node(name);
    parent.addChild(node);

    return {
        name: node.name,
        path: pathOf(node),
        uuid: node.uuid,
        parentPath: pathOf(parent),
        parentChildren: parent.children.length
    };
});

/**
 * 改节点属性。只支持白名单字段，不做通用反射赋值——
 * 通用赋值太容易把节点的内部状态改坏。
 * payload: { node: string, name?, active?, position?: {x,y,z}, scale?: {x,y}, opacity? }
 */
exports.setNodeProps = wrap(function (args) {
    var root = sceneRoot();
    if (!root) throw new Error('场景还没加载');

    var node = findByPath(root, args.node);
    var changed = [];

    if (typeof args.name === 'string' && args.name && args.name !== node.name) {
        node.name = args.name;
        changed.push('name');
    }
    if (typeof args.active === 'boolean' && args.active !== node.active) {
        node.active = args.active;
        changed.push('active');
    }
    if (args.position) {
        var px = args.position.x;
        var py = args.position.y;
        var pz = args.position.z;
        node.setPosition(
            typeof px === 'number' ? px : node.x,
            typeof py === 'number' ? py : node.y,
            typeof pz === 'number' ? pz : node.z
        );
        changed.push('position');
    }
    if (args.scale) {
        var sx = args.scale.x;
        var sy = args.scale.y;
        node.setScale(
            typeof sx === 'number' ? sx : node.scaleX,
            typeof sy === 'number' ? sy : node.scaleY
        );
        changed.push('scale');
    }
    if (typeof args.opacity === 'number') {
        node.opacity = args.opacity;
        changed.push('opacity');
    }

    return {
        path: pathOf(node),
        changed: changed,
        active: node.active,
        position: { x: node.x, y: node.y, z: node.z },
        scale: { x: node.scaleX, y: node.scaleY }
    };
});

/** 删节点。不允许删场景根。 */
exports.removeNode = wrap(function (args) {
    var root = sceneRoot();
    if (!root) throw new Error('场景还没加载');

    var node = findByPath(root, args.node);
    if (node === root) throw new Error('不能删除场景根节点');

    var p = pathOf(node);
    if (node.parent) node.parent.removeChild(node);
    node.destroy();

    return { removed: p };
});

/** 健康检查：确认场景进程里这个脚本真的加载了，以及回传通道哪条可用 */
exports.ping = wrap(function () {
    var root = sceneRoot();
    var hasIpc = false;
    try {
        hasIpc = typeof Editor !== 'undefined' && !!Editor.Ipc &&
            typeof Editor.Ipc.sendToMain === 'function';
    } catch (e) { /* 忽略 */ }

    return {
        sceneName: root ? root.name : null,
        childCount: root ? root.children.length : 0,
        ccAvailable: typeof cc !== 'undefined',
        fsModule: fsModule ? 'ok' : 'none',
        editorIpc: hasIpc
    };
});

//#region 运行时

/**
 * 运行时读取。
 *
 * 这是 3.8.7 那套 MCP 的核心能力，2.x 之前一直以为做不到 ——
 * 其实只是处理器签名写错了（payload 在第二个参数）。
 *
 * 读的是**编辑器里正在编辑的场景**（cc.director.getScene()），
 * 也就是模拟器/预览里跑的那份。注意：这读的是编辑态场景的运行时状态，
 * 不是浏览器里那个 web 构建的运行状态 —— 浏览器那条路是另一个进程。
 */

/**
 * 归一化类名。
 *
 * 2.4 的 cc.js.getClassName 返回的是 "cc_Canvas" 这种下划线格式，
 * 而 3.x 是 "cc.Canvas"。统一转成点号格式，AI 不用记两套。
 * 自定义脚本类名保持原样（比如 "AppStart"）。
 */
function normClassName(comp) {
    var n = null;
    try {
        n = (typeof cc !== 'undefined' && cc.js && cc.js.getClassName)
            ? cc.js.getClassName(comp)
            : (comp.constructor ? comp.constructor.name : null);
    } catch (e) {
        n = comp.constructor ? comp.constructor.name : null;
    }
    if (!n) return '?';
    if (n.indexOf('cc_') === 0) return 'cc.' + n.slice(3);
    return n;
}

/**
 * 取节点的组件列表。
 *
 * 2.4 的坑：`node.components` 这个公开属性读不到东西（undefined），
 * 得用 `node._components` 或 `node.getComponents(cc.Component)`。
 * 两个都试，取到有内容的那份。
 */
function compsOf(node) {
    try {
        if (node._components && node._components.length) return node._components;
    } catch (e) { /* 忽略 */ }
    try {
        if (typeof cc !== 'undefined' && cc.Component && node.getComponents) {
            var l = node.getComponents(cc.Component);
            if (l && l.length) return l;
        }
    } catch (e) { /* 忽略 */ }
    try {
        if (node.components && node.components.length) return node.components;
    } catch (e) { /* 忽略 */ }
    return [];
}

/**
 * 取节点的缩放。
 *
 * 2.4 的坑：`node.scale` 是**数字**（等于 scaleX），不是 Vec3 —— 和 3.x 不同。
 * `getScale()` 在 2.4 也返回数字。所以统一读 scaleX/scaleY/scaleZ。
 */
function scaleOf(node) {
    var out = { x: 1, y: 1, z: 1 };
    try {
        if (typeof node.scale === 'number') {
            // 2.4：scale 是数字，补上另两个分量
            out.x = node.scale;
            out.y = (typeof node.scaleY === 'number') ? node.scaleY : node.scale;
            out.z = (typeof node.scaleZ === 'number') ? node.scaleZ : node.scale;
            return out;
        }
        if (node.scale && typeof node.scale === 'object') {
            out.x = node.scale.x; out.y = node.scale.y; out.z = node.scale.z;
            return out;
        }
    } catch (e) { /* 忽略 */ }
    try {
        if (typeof node.scaleX === 'number') out.x = node.scaleX;
        if (typeof node.scaleY === 'number') out.y = node.scaleY;
        if (typeof node.scaleZ === 'number') out.z = node.scaleZ;
    } catch (e) { /* 忽略 */ }
    return out;
}

/**
 * 取节点的位置。2.4 的 position 是 Vec3，但保险起见也兼容分量写法。
 */
function posOf(node) {
    var out = { x: 0, y: 0, z: 0 };
    try {
        if (node.position && typeof node.position === 'object') {
            out.x = node.position.x; out.y = node.position.y; out.z = node.position.z;
            return out;
        }
    } catch (e) { /* 忽略 */ }
    try {
        if (typeof node.x === 'number') out.x = node.x;
        if (typeof node.y === 'number') out.y = node.y;
    } catch (e) { /* 忽略 */ }
    return out;
}
function isCcType(v, typeName) {
    try {
        if (typeof cc === 'undefined' || !cc || !cc[typeName]) return false;
        return v instanceof cc[typeName];
    } catch (e) {
        return false;
    }
}

/** 取组件上某个 @property 的当前值（运行时才有意义） */
function readProp(comp, name) {
    try {
        var v = comp[name];
        if (v === null || v === undefined) return null;
        var t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean') return v;

        if (isCcType(v, 'Node')) return { __node: v.name, __path: pathOf(v) };
        if (isCcType(v, 'Vec3')) return { x: v.x, y: v.y, z: v.z };
        if (isCcType(v, 'Vec2')) return { x: v.x, y: v.y };
        if (isCcType(v, 'Color')) return { r: v.r, g: v.g, b: v.b, a: v.a };
        if (isCcType(v, 'Quat')) return { x: v.x, y: v.y, z: v.z, w: v.w };
        if (isCcType(v, 'Size')) return { width: v.width, height: v.height };

        // 资源引用：给 uuid 和名字，AI 才能知道挂的是哪张图
        if (isCcType(v, 'Asset')) {
            var asset = { __asset: v.name || v.constructor.name };
            if (v._uuid) asset.uuid = v._uuid;
            if (v.nativeUrl) asset.nativeUrl = v.nativeUrl;
            return asset;
        }
        // Prefab 引用
        if (isCcType(v, 'Prefab')) {
            var pf = { __prefab: v.name || 'prefab' };
            if (v._uuid) pf.uuid = v._uuid;
            return pf;
        }
        // 组件引用
        if (isCcType(v, 'Component')) {
            return { __component: normClassName(v) };
        }

        if (v instanceof Array) {
            var arr = [];
            for (var i = 0; i < Math.min(v.length, 50); i++) {
                var it = v[i];
                if (isCcType(it, 'Node')) arr.push({ __node: it.name, __path: pathOf(it) });
                else if (it && typeof it === 'object') {
                    // 数组里通常是节点数组或组件数组，读一层公开字段
                    var sub = readPlain(it);
                    arr.push(sub);
                } else arr.push(it);
            }
            return arr;
        }

        if (t === 'object') {
            var ctor = v.constructor ? v.constructor.name : null;
            var plain = readPlain(v);
            if (ctor && plain.__type === undefined) plain.__type = ctor;
            return plain;
        }
        return v;
    } catch (e) {
        return null;
    }
}

/** 读一个普通对象的公开字段（限深度，防循环引用） */
function readPlain(obj, depth) {
    var d = depth || 0;
    if (!obj || typeof obj !== 'object' || d > 2) return null;
    var out = {};
    try {
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length && i < 20; i++) {
            var k = keys[i];
            if (k.charAt(0) === '_') continue;
            var v = obj[k];
            var t = typeof v;
            if (t === 'number' || t === 'string' || t === 'boolean') out[k] = v;
            else if (v === null) out[k] = null;
            else if (t === 'object' && d < 2) {
                var sub = readPlain(v, d + 1);
                if (sub) out[k] = sub;
            }
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 组件的公开属性名（排除下划线开头的内部字段） */
function propNames(comp) {
    var out = [];
    // cc 的组件原型上有不少方法（destroy / removeFromParent / emit ...），
    // 读了没意义还可能触发副作用，直接排除。
    var SKIP = {
        destroy: 1, removeFromParent: 1, addChild: 1, removeChild: 1,
        emit: 1, schedule: 1, unschedule: 1, setSiblingIndex: 1,
        getComponent: 1, getComponents: 1, getComponentInChildren: 1,
        hasEventListener: 1, isEqual: 1, copyProperties: 1,
        toString: 1, valueOf: 1, constructor: 1
    };
    try {
        var cur = comp;
        var depth = 0;
        while (cur && cur !== Object.prototype && depth < 4) {
            var names = Object.getOwnPropertyNames(cur);
            for (var i = 0; i < names.length; i++) {
                var n = names[i];
                if (n.charAt(0) === '_') continue;
                if (n === 'constructor') continue;
                if (SKIP[n]) continue;
                if (out.indexOf(n) >= 0) continue;
                out.push(n);
            }
            cur = Object.getPrototypeOf(cur);
            depth++;
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/**
 * 在场景进程里执行一段代码，读回返回值。
 *
 * 和 runtime_eval 的区别：runtime_eval 只求值一个表达式；
 * 这个能跑多语句（比如遍历、声明临时变量），但**不接收外部参数**，
 * 也不能 await。返回值必须是可序列化的。
 *
 * payload: { code: string }
 */
exports.sceneEval = wrap(function (args) {
    if (!args.code) throw new Error('缺少 code');
    var code = String(args.code);

    var fn;
    try {
        /* jshint evil:true */
        fn = new Function('cc', 'window', code);
    } catch (e) {
        throw new Error('代码语法错误：' + e.message);
    }

    var ret = fn(typeof cc !== 'undefined' ? cc : undefined,
        typeof window !== 'undefined' ? window : undefined);

    return {
        code: code.slice(0, 200),
        value: jsonSafe(ret, 0)
    };
});

/** 把任意值转成可 JSON 序列化的结构（比 readProp 宽松，深度更大） */
function jsonSafe(v, depth) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'number' || t === 'string' || t === 'boolean') return v;
    if (depth > 4) return null;
    if (v instanceof Array) {
        var arr = [];
        for (var i = 0; i < Math.min(v.length, 200); i++) {
            var it = jsonSafe(v[i], depth + 1);
            arr.push(it === undefined ? null : it);
        }
        return arr;
    }
    if (t === 'object') {
        var out = {};
        try {
            var keys = Object.keys(v);
            for (var k = 0; k < keys.length && k < 80; k++) {
                var key = keys[k];
                var val = jsonSafe(v[key], depth + 1);
                if (val !== undefined) out[key] = val;
            }
        } catch (e) {
            return { __type: v.constructor ? v.constructor.name : 'Object' };
        }
        return out;
    }
    return null;
}

/**
 * 读运行时状态。
 * payload: {
 *   node?: string,          // 只读这个节点（省略读整棵树）
 *   maxDepth?: number,      // 树深度，默认 3
 *   maxNodes?: number,      // 最多读多少节点，默认 200
 *   props?: string[],       // 只读这些属性；不给就读所有公开属性
 *   includeComponents?: boolean,  // 默认 true
 *   onlyNonDefault?: boolean     // 只报告"和默认值不同"的属性（脚本改过的痕迹）
 * }
 */
exports.runtimeRead = wrap(function (args) {
    var root = sceneRoot();
    if (!root) throw new Error('场景还没加载（cc.director.getScene() 返回空）');

    var maxDepth = (typeof args.maxDepth === 'number') ? args.maxDepth : 3;
    var maxNodes = (typeof args.maxNodes === 'number') ? args.maxNodes : 200;
    var includeComponents = args.includeComponents !== false;
    var onlyProps = (args.props && args.props.length) ? args.props : null;
    var onlyNonDefault = args.onlyNonDefault === true;

    var counter = 0;
    var truncated = false;

    /** 拿组件的默认实例值（cc 在编辑器里会缓存 class 的默认属性） */
    function defaultValueOf(comp, name) {
        try {
            // cc 的编辑器环境会给每个组件挂一个"编辑器属性"对象，值就是默认值
            var ed = comp._editorProps || comp.__editorProps;
            if (ed && ed[name] && typeof ed[name] === 'object' && 'default' in ed[name]) {
                var d = ed[name].default;
                if (d === undefined || d === null) return undefined;
                if (typeof d === 'object' && d.__type__ !== undefined) return undefined;
                return d;
            }
        } catch (e) { /* 忽略 */ }
        return undefined;
    }

    function sameValue(a, b) {
        if (a === b) return true;
        if (a === null || b === null || a === undefined || b === undefined) return false;
        if (typeof a === 'object' && typeof b === 'object') {
            try {
                var ka = Object.keys(a), kb = Object.keys(b);
                if (ka.length !== kb.length) return false;
                for (var i = 0; i < ka.length; i++) {
                    if (!sameValue(a[ka[i]], b[ka[i]])) return false;
                }
                return true;
            } catch (e) { return false; }
        }
        return false;
    }

    function readNode(node, depth) {
        if (counter >= maxNodes) { truncated = true; return null; }
        counter++;

        var out = {
            name: node.name,
            path: pathOf(node),
            active: node.active,
            position: posOf(node),
            scale: scaleOf(node),
            children: []
        };

        if (includeComponents) {
            out.components = [];
            var comps = compsOf(node);
            for (var i = 0; i < comps.length; i++) {
                var comp = comps[i];
                var cName = normClassName(comp);
                var co = { type: cName };
                var names = onlyProps || propNames(comp);
                var vals = {};
                var got = 0;
                for (var j = 0; j < names.length && got < 40; j++) {
                    var pn = names[j];
                    var v = readProp(comp, pn);
                    if (v === null || v === undefined) continue;

                    if (onlyNonDefault) {
                        var dv = defaultValueOf(comp, pn);
                        if (dv !== undefined && sameValue(v, dv)) continue;
                    }

                    vals[pn] = v;
                    got++;
                }
                co.props = vals;
                out.components.push(co);
            }
        }

        if (depth < maxDepth) {
            var kids = node.children || [];
            for (var k = 0; k < kids.length; k++) {
                var sub = readNode(kids[k], depth + 1);
                if (sub) out.children.push(sub);
                else { truncated = true; break; }
            }
        } else if ((node.children || []).length) {
            truncated = true;
        }
        return out;
    }

    var target = root;
    if (args.node) {
        target = findByPath(root, args.node);
        if (!target) throw new Error('找不到节点 ' + args.node);
    }

    var result = readNode(target, 0);
    result.sceneName = root.name;
    result.totalRead = counter;
    result.truncated = truncated;

    // 顺带报一下 director 状态
    try {
        result.director = {
            running: !!(cc.director && cc.director.getPaused ? false : true),
            scene: root.name,
            frame: cc.director.getTotalFrames ? cc.director.getTotalFrames() : null,
            deltaTime: cc.director.getDeltaTime ? cc.director.getDeltaTime() : null
        };
    } catch (e) { /* 忽略 */ }

    return result;
});

/**
 * 执行一段表达式，读回结果。用于查任意运行时状态。
 * payload: { expr: string }   // 形如 "cc.director.getScene().name"
 */
exports.runtimeEval = wrap(function (args) {
    if (!args.expr) throw new Error('缺少 expr');
    var expr = String(args.expr);

    // 用 `return (expr)` 包一层 —— 语法上就必须是单个表达式，
    // 所以不需要粗暴地拦 ; { }（那会把 .map(function(){...}) 这类
    // 完全合法的表达式也挡掉）。
    //
    // 也不需要额外拦赋值：赋值表达式（a = 1）本身也是合法表达式，
    // 之前用正则拦它反而误伤了 IIFE 里的局部变量声明（var out = []）。
    // 真要跑多语句代码，用 scene_eval（那边不限制）。

    var fn;
    try {
        /* jshint evil:true */
        fn = new Function('cc', 'return (' + expr + ');');
    } catch (e) {
        throw new Error('表达式语法错误：' + e.message);
    }

    var raw = fn(typeof cc !== 'undefined' ? cc : undefined);
    return { expr: expr, value: readProp({ v: raw }, 'v') };
});

/**
 * 捕获运行时 console 输出。
 *
 * 场景进程的 console.log 平时只进编辑器控制台，AI 看不到。
 * 这里劫持 console，把最近的输出存进环形缓冲，AI 可以随时拉取。
 *
 * 劫持只在场景进程里做（这是它自己的 console），不影响编辑器主进程。
 */
var consoleCapture = {
    installed: false,
    buf: [],
    max: 200,
    orig: null
};

function installConsoleCapture() {
    if (consoleCapture.installed) return;
    try {
        var c = typeof console !== 'undefined' ? console : null;
        if (!c || !c.log) return;

        var origLog = c.log;
        var origWarn = c.warn;
        var origError = c.error;
        consoleCapture.orig = { log: origLog, warn: origWarn, error: origError };

        function push(level, args) {
            var parts = [];
            for (var i = 0; i < args.length; i++) {
                var a = args[i];
                var t = typeof a;
                if (t === 'string') parts.push(a);
                else if (t === 'number' || t === 'boolean') parts.push(String(a));
                else {
                    try { parts.push(JSON.stringify(a)); } catch (e) { parts.push('[object]'); }
                }
            }
            consoleCapture.buf.push({
                level: level,
                text: parts.join(' '),
                at: Date.now()
            });
            if (consoleCapture.buf.length > consoleCapture.max) {
                consoleCapture.buf.shift();
            }
        }

        c.log = function () { push('log', arguments); origLog.apply(c, arguments); };
        c.warn = function () { push('warn', arguments); origWarn.apply(c, arguments); };
        c.error = function () { push('error', arguments); origError.apply(c, arguments); };
        consoleCapture.installed = true;
    } catch (e) {
        // 装不上就算了，不影响别的功能
    }
}

installConsoleCapture();

/**
 * 读捕获到的 console 输出。
 * payload: { since?: number, limit?: number, level?: string }
 */
exports.runtimeConsole = wrap(function (args) {
    var since = (typeof args.since === 'number') ? args.since : 0;
    var limit = (typeof args.limit === 'number') ? args.limit : 50;
    var level = args.level ? String(args.level) : null;

    var out = [];
    for (var i = 0; i < consoleCapture.buf.length; i++) {
        var e = consoleCapture.buf[i];
        if (e.at < since) continue;
        if (level && e.level !== level) continue;
        out.push(e);
    }
    if (out.length > limit) out = out.slice(out.length - limit);

    return {
        captured: consoleCapture.buf.length,
        installed: consoleCapture.installed,
        entries: out,
        latestAt: consoleCapture.buf.length ? consoleCapture.buf[consoleCapture.buf.length - 1].at : null
    };
});

/**
 * 调用场景脚本里的方法（给高级用户用）。
 * payload: { method: string, args?: object }
 */
exports.runtimeCall = wrap(function (args) {
    if (!args.method) throw new Error('缺少 method');
    var target = exports[args.method];
    if (typeof target !== 'function') {
        throw new Error('没有这个方法：' + args.method);
    }
    return target(args.args || {});
});

//#endregion

