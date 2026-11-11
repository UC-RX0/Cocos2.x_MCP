/*
 * cocos-mcp-2x Web 预览桥接脚本（浏览器侧）
 * ---------------------------------------------------------------------------
 * 注入到 Cocos Creator 2.4 的预览页（/ 路由，走 __quick_compile__.js 即时编译，
 * 不需要 build）。
 *
 * 它在页面里做三件事：
 *   1. 捕获 console / 未捕获异常，带时间戳上报
 *   2. 定期上报运行时状态（场景树、组件属性、帧数）
 *   3. 轮询取指令并执行（点击节点、求值、读状态…），执行结果回报
 *
 * 通信走 HTTP（XHR），只用 127.0.0.1 的 MCP 端口 —— 不依赖 socket.io，
 * 因为 socket.io 的服务端在引擎内部，我们没有它的客户端协议实现。
 *
 * 注意：这是浏览器环境的脚本，必须兼容老浏览器 —— 用 var、不能用 ??.、?.、Array.flat。
 */
(function () {
    'use strict';

    // 测试时想看游戏自己的 console：URL 加 ?mcp=off 就完全不装桥。
    // 不劫持 console、不轮询、不发任何请求，控制台一条 MCP 相关信息都不会有。
    // 和 build 产物注入脚本（inject-runtime.js）的 ?mcp=off 约定保持一致。
    try {
        if (/(?:^|[?&])mcp=off(?:&|$)/.test(window.location.search || '')) return;
    } catch (e) { /* 忽略 */ }

    var CFG = window.__MCP_BRIDGE_CONFIG__ || {};
    var PORT = CFG.port || 0;
    var INTERVAL = CFG.interval || 1500;
    var CMD_POLL = CFG.cmdPollInterval || 400;
    var MAX_LOG = CFG.maxLog || 300;

    if (!PORT) return;
    if (window.__MCP_BRIDGE_INSTALLED__) return;
    window.__MCP_BRIDGE_INSTALLED__ = true;

    var logs = [];
    var logSeq = 0;
    var lastLogAt = 0;
    var logDropped = 0;
    var lastReport = null;
    var lastSentLogIdx = 0;
    var cmdBusy = false;
    var cmdBusyAt = 0;          // 本次轮询的发起时间，用来给 cmdBusy 兜底解卡
    var cmdCursor = -1;         // 已处理到的指令序号；-1 = 刚加载，先跟服务端对齐位点，不重放历史
    // 每次页面加载生成一个新 id：服务端靠它识别"换页了"，
    // 把上一页没执行完的指令判死（bye 请求在 unload 时经常发不出去）
    var PAGE_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    var stopped = false;

    // ---------------------------------------------------------------- 工具

    function now() { return Date.now(); }

    function clip(text, max) {
        var s = String(text == null ? '' : text);
        var limit = max || 2000;
        return s.length > limit ? s.slice(0, limit) + '…[截断]' : s;
    }

    function stringifyArg(a) {
        if (typeof a === 'string') return a;
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return '[object]'; }
        }
        return String(a);
    }

    // ---------------------------------------------------------------- 通信

    function xhr(method, path, body, cb) {
        var url = 'http://127.0.0.1:' + PORT + path;
        var x;
        try {
            x = new XMLHttpRequest();
        } catch (e) {
            cb(new Error('XMLHttpRequest 不可用'));
            return;
        }
        try {
            x.open(method, url, true);
            // 只在上报（POST）时带一个「简单请求」允许的 Content-Type。
            // 以前连 GET 轮询都设 application/json，每次都触发 OPTIONS 预检；
            // 现在 GET 是纯简单请求，POST 用 text/plain 也是简单请求
            // （服务端按 JSON.parse 解析 body，不认 Content-Type），
            // 既省掉预检往返，也不会在控制台留下网络噪音。
            if (body !== null && body !== undefined) {
                x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
            }
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                if (x.status >= 200 && x.status < 300) {
                    var parsed = null;
                    try { parsed = JSON.parse(x.responseText || '{}'); } catch (e) { parsed = null; }
                    cb(null, parsed);
                } else {
                    cb(new Error('HTTP ' + x.status));
                }
            };
            x.onerror = function () { cb(new Error('网络错误')); };
            x.send(body === null || body === undefined ? null : JSON.stringify(body));
        } catch (e) {
            cb(e);
        }
    }

    // ---------------------------------------------------------------- 日志

    function pushLog(level, args) {
        // 限流：游戏里 console.log 可能非常频繁，
        // 每条都做一次字符串拼接 + JSON 会拖慢主线程。
        //
        // 但 **error 永远不丢** —— 限流是为了挡噪声，
        // 而错误正是最该被收上来的东西。
        // （之前限流把 console.error 挤掉了，
        //   结果「钥匙不足」的报错收不到 —— 限流不能牺牲错误。）
        var now2 = Date.now();
        var isError = level === 'error';
        if (!isError && now2 - lastLogAt < 50) {
            // 50ms 内的日志只计数，不逐条存
            logDropped++;
            return;
        }
        lastLogAt = now2;
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(stringifyArg(args[i]));
        if (logDropped && !isError) {
            parts.push('(' + logDropped + ' 条日志被合并)');
            logDropped = 0;
        } else if (logDropped && isError) {
            // error 之前积压的合并计数也要记上，但不能把 error 自己变成合并条目
            logDropped = 0;
        }
        logs.push({
            seq: ++logSeq,
            level: level,
            text: clip(parts.join(' ')),
            at: now2
        });
        if (logs.length > MAX_LOG) logs.shift();
    }

    function installConsoleCapture() {
        var c = (typeof console !== 'undefined') ? console : null;
        if (!c || !c.log) return;
        var wc = (window.console && window.console !== c) ? window.console : null;

        function wrap(target, level, orig) {
            target[level] = function () {
                try { pushLog(level, arguments); } catch (e) { /* 忽略 */ }
                if (orig) {
                    try { orig.apply(target, arguments); } catch (e) { /* 忽略 */ }
                }
            };
        }

        var levels = ['log', 'warn', 'error', 'info', 'debug'];
        for (var i = 0; i < levels.length; i++) {
            var lv = levels[i];
            wrap(c, lv, c[lv]);
            if (wc && wc !== c) wrap(wc, lv, wc[lv]);
        }

        window.addEventListener('error', function (e) {
            pushLog('error', [
                '[uncaught] ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || '')
            ]);
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e && e.reason;
            pushLog('error', ['[unhandled rejection] ' + (r && r.message ? r.message : String(r))]);
        });
    }

    // ---------------------------------------------------------------- 运行时状态

    function ccRef() {
        if (window.cc) return window.cc;
        if (typeof cc !== 'undefined') return cc;
        return null;
    }

    function nodeName(n) { return n && n.name ? n.name : '?'; }

    // cc.Scene 根节点没有 active 属性，直接读会让引擎打
    // 「"active" is not defined in the Scene, it is only defined in normal nodes.」
    // 上报每 1.5s 跑一次，这条警告就会持续刷屏，盖住游戏自己的日志。
    function safeActive(node, ccm) {
        try {
            if (!node) return true;
            var sc = ccm && ccm.director ? ccm.director.getScene() : null;
            if (node === sc || node._isScene) return true;
            return node.active !== false;
        } catch (e) { return true; }
    }

    function compsOf(node, ccm) {
        var comps = null;
        try {
            if (node._components && node._components.length) comps = node._components;
            else if (node.getComponents && ccm && ccm.Component) {
                comps = node.getComponents(ccm.Component);
            }
        } catch (e) { comps = null; }
        return comps || [];
    }

    function classNameOf(c, ccm) {
        try {
            if (ccm && ccm.js && ccm.js.getClassName) {
                var n = ccm.js.getClassName(c);
                // 2.4 返回 cc_Canvas 这种带下划线的，转成 cc.Canvas 更好认
                if (n && n.indexOf('cc_') === 0) return 'cc.' + n.slice(3);
                return n;
            }
        } catch (e) { /* 忽略 */ }
        return c && c.constructor ? c.constructor.name : '?';
    }

    function propValue(v, ccm) {
        if (v === null || v === undefined) return null;
        var t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean') return v;
        if (t !== 'object') return null;
        try {
            if (ccm && ccm.Node && v instanceof ccm.Node) {
                return { __node: nodeName(v) };
            }
            if (ccm && ccm.Vec3 && v instanceof ccm.Vec3) {
                return { x: v.x, y: v.y, z: v.z };
            }
            if (ccm && ccm.Color && v instanceof ccm.Color) {
                return { r: v.r, g: v.g, b: v.b, a: v.a };
            }
        } catch (e) { /* 忽略 */ }
        if (v instanceof Array) {
            var arr = [];
            for (var i = 0; i < Math.min(v.length, 20); i++) arr.push(propValue(v[i], ccm));
            return arr;
        }
        var ctor = v.constructor ? v.constructor.name : null;
        if (ctor) return { __type: ctor };
        return null;
    }

    /**
     * 读组件的属性列表。
     *
     * 只读**自有可枚举**属性 —— 用 getOwnPropertyNames 会把原型上的 getter
     * 也拿进来（cc.Component.prototype 上有一堆），读它们会触发引擎内部计算，
     * 慢的能拖死主线程。
     * 属性名以 _ 开头的跳过（那是引擎内部字段）。
     */
    function readCompProps(comp, ccm, limit) {
        var out = {};
        var names;
        try {
            names = Object.keys(comp);
        } catch (e) {
            return out;
        }
        var got = 0;
        var max = limit || 40;
        for (var i = 0; i < names.length && got < max; i++) {
            var n = names[i];
            if (n.charAt(0) === '_') continue;
            if (n === 'constructor') continue;
            var val;
            try { val = propValue(comp[n], ccm); } catch (e) { continue; }
            if (val !== null && val !== undefined) {
                out[n] = val;
                got++;
            }
        }
        return out;
    }

    /**
     * 读场景树 —— **只读结构，不读组件属性**。
     *
     * 为什么这么保守：组件属性里有不少 getter，读它们会触发引擎内部计算
     * （有些很慢、有些会抛）。每 1.5 秒把所有节点的每个属性都读一遍，
     * 足以把主线程拖死 —— 表现是页面整个卡住，连 1+1 都执行不了。
     *
     * 属性按需读：用 read 指令指定节点才读那一个节点的属性。
     */
    function readTree(ccm, maxDepth, maxNodes) {
        var scene = null;
        try { scene = ccm.director.getScene(); } catch (e) { return null; }
        if (!scene) return null;

        var count = 0;
        var truncated = false;

        function walk(node, depth) {
            if (count >= maxNodes) { truncated = true; return null; }
            count++;
            var out = {
                name: nodeName(node),
                active: safeActive(node, ccm),
                position: { x: node.position.x, y: node.position.y, z: node.position.z },
                scale: { x: node.scaleX, y: node.scaleY, z: node.scaleZ },
                components: [],
                children: []
            };
            // 只记组件类型，不碰它的属性
            var comps = compsOf(node, ccm);
            for (var i = 0; i < comps.length; i++) {
                out.components.push({ type: classNameOf(comps[i], ccm) });
            }
            if (depth < maxDepth) {
                var kids = node.children || [];
                for (var k = 0; k < kids.length; k++) {
                    var sub = walk(kids[k], depth + 1);
                    if (sub) out.children.push(sub);
                    else { truncated = true; break; }
                }
            }
            return out;
        }

        var tree = walk(scene, 0);
        if (tree) {
            tree.truncated = truncated;
            tree.totalRead = count;
        }
        return tree;
    }

    function buildReport() {
        var ccm = ccRef();
        // 只传**新增**的日志 —— 每次都传全部 60 条会把主线程和网络都拖慢
        var newLogs = logs.slice(lastSentLogIdx);
        lastSentLogIdx = logs.length;

        var rep = {
            bridge: 1,
            project: CFG.project || null,
            pageId: PAGE_ID,
            at: now(),
            url: window.location.href,
            frame: 0,
            fps: 0,
            scene: null,
            tree: null,
            logs: newLogs,
            logTotal: logSeq
        };
        if (!ccm || !ccm.director) return rep;
        try { rep.frame = ccm.director.getTotalFrames(); } catch (e) { /* 忽略 */ }
        try { rep.fps = Math.round(ccm.director.getFPS()); } catch (e) { /* 忽略 */ }
        try {
            var scene = ccm.director.getScene();
            rep.scene = scene ? scene.name : null;
            rep.tree = readTree(ccm, CFG.maxDepth || 3, CFG.maxNodes || 120);
        } catch (e) {
            rep.sceneError = String(e.message || e);
        }
        return rep;
    }

    function report() {
        if (stopped) return;
        var rep = buildReport();
        lastReport = rep;
        xhr('POST', '/bridge/report', rep, function () { /* 失败就等下一轮 */ });
    }

    // ---------------------------------------------------------------- 指令执行

    /**
     * 按路径找节点。
     *
     * 路径是从**场景根**算起的（和 MCP 侧的 scene_* 工具一个规矩）。
     * 找不到就退回「按名字在整棵树里搜」——
     * 因为真实层级常常不好猜（UI 挂在别的容器下），
     * 而按名字找几乎总能命中，够用。
     */
    function findNodeByPath(ccm, path, index, wantComp) {
        var scene = null;
        try { scene = ccm.director.getScene(); } catch (e) { return null; }
        if (!scene) return null;

        var wantIndex = (typeof index === 'number') ? index : 0;
        var parts = String(path).split('/').filter(function (p) { return p; });
        if (!parts.length) return scene;

        // 1) 按路径逐层找
        var cur = scene;
        for (var i = 0; i < parts.length; i++) {
            var found = null;
            var kids = cur.children || [];
            for (var j = 0; j < kids.length; j++) {
                if (kids[j].name === parts[i]) { found = kids[j]; break; }
            }
            if (!found) { cur = null; break; }
            cur = found;
        }
        if (cur) return cur;

        // 2) 路径不对 → 按最后一段的名字全树搜
        //    同名可能有多个（不同关卡的 bottle、多个 BallItem），
        //    所以收集全部再按 index 取。
        //    wantComp 非空时，优先返回**带那个组件**的那个 ——
        //    比如场景里有模板 bottle（无 Button）和真 bottle（有 Button）。
        var target = parts[parts.length - 1];
        var hits = [];
        var want = wantComp ? String(wantComp) : null;
        var search = function (n) {
            if (!n) return;
            if (n.name === target) hits.push(n);
            var kids = n.children || [];
            for (var k = 0; k < kids.length; k++) { search(kids[k]); }
        };
        search(scene);
        if (!hits.length) return null;
        if (want) {
            var matched = hits.filter(function (n) {
                var cs = n._components || [];
                for (var i = 0; i < cs.length; i++) {
                    if (cc.js.getClassName(cs[i]).indexOf(want) >= 0) return true;
                }
                return false;
            });
            if (matched.length) hits = matched;
        }
        return hits[wantIndex] || hits[0];
    }

    function evalExpr(expr, ccm) {
        var fn;
        try {
            /* jshint evil:true */
            fn = new Function('cc', 'window', 'return (' + expr + ');');
        } catch (e) {
            return { error: '表达式语法错误：' + e.message };
        }
        var raw;
        try {
            raw = fn(ccm, window);
        } catch (e) {
            return { error: '求值失败：' + (e.message || e) };
        }
        return { value: propValue(raw, ccm) };
    }

    /**
     * 执行一条指令。
     * cmd: { id, action, ... }
     * 返回 { ok: true, result: ... } 或 { ok: false, error: ... }
     */
    function runCommand(cmd) {
        var ccm = ccRef();
        var action = String(cmd.action || '');

        if (action === 'ping') {
            return { ok: true, result: { pong: true, at: now() } };
        }

        if (action === 'eval') {
            if (!ccm) return { ok: false, error: 'cc 引擎还没加载好' };
            var r = evalExpr(String(cmd.expr || ''), ccm);
            if (r.error) return { ok: false, error: r.error };
            return { ok: true, result: r.value };
        }

        if (action === 'read') {
            if (!ccm) return { ok: false, error: 'cc 引擎还没加载好' };
            var node = findNodeByPath(ccm, cmd.path);
            if (!node) return { ok: false, error: '找不到节点：' + cmd.path };
            var out = {
                name: node.name,
                active: safeActive(node, ccm),
                position: { x: node.position.x, y: node.position.y, z: node.position.z },
                components: []
            };
            var comps = compsOf(node, ccm);
            for (var i = 0; i < comps.length; i++) {
                var co = { type: classNameOf(comps[i], ccm), props: readCompProps(comps[i], ccm, 40) };
                out.components.push(co);
            }
            return { ok: true, result: out };
        }

        if (action === 'click') {
            // 在节点上调用它的点击处理方法（ Cocos 触摸事件不会真的派发到 DOM，
            // 所以直接找组件上的 onXxx / handleClick 之类的方法来触发）
            if (!ccm) return { ok: false, error: 'cc 引擎还没加载好' };
            var target = findNodeByPath(ccm, cmd.path, cmd.index);
            if (!target) return { ok: false, error: '找不到节点：' + cmd.path };

            var method = cmd.method || cmd.handler;
            var comps = compsOf(target, ccm);
            var called = [];
            if (method) {
                for (var i = 0; i < comps.length; i++) {
                    if (typeof comps[i][method] === 'function') {
                        try {
                            comps[i][method](cmd.arg);
                            called.push(classNameOf(comps[i], ccm) + '.' + method);
                        } catch (e) {
                            return { ok: false, error: '调用 ' + method + ' 抛错：' + (e.message || e) };
                        }
                    }
                }
                if (!called.length) {
                    return { ok: false, error: '节点 ' + cmd.path + ' 上没有方法 ' + method };
                }
                return { ok: true, result: { called: called } };
            }

            // 没指定方法：找组件上唯一的事件处理方法（onBtnXxx / onXxxClick 之类）
            // 只看自有属性 —— 原型上的方法名不一定是事件处理。
            for (var k = 0; k < comps.length; k++) {
                var c = comps[k];
                var names;
                try { names = Object.keys(c); } catch (e) { continue; }
                for (var m = 0; m < names.length; m++) {
                    var nm = names[m];
                    if (!/^on[A-Z]/.test(nm)) continue;
                    if (typeof c[nm] !== 'function') continue;
                    try {
                        c[nm](cmd.arg);
                        called.push(classNameOf(c, ccm) + '.' + nm);
                    } catch (e) {
                        return { ok: false, error: '调用 ' + nm + ' 抛错：' + (e.message || e) };
                    }
                }
            }
            if (!called.length) {
                return { ok: false, error: '节点 ' + cmd.path + ' 上没找到 onXxx 事件处理方法' };
            }
            return { ok: true, result: { called: called } };
        }


        if (action === 'module') {
            // 加载项目模块并（可选）调用它的方法。
            //
            // 为什么需要：项目的 TS 类（PrivilegeView / KeyData 这些）
            // 既不是 cc 组件、也不挂在 window 上，
            // 只有 quick compile 的模块表里才有 —— window.__quick_compile_project__.require
            //
            // 参数：
            //   module  —— 模块路径，如 "./assets/game/scripts/game/datas/KeyData"
            //   method  —— 要调用的方法名
            //   args    —— 调用的参数数组
            //   prop    —— 不调方法，只读某个属性（method 为空时）
            var qc = window.__quick_compile_project__;
            if (!qc || typeof qc.require !== 'function') {
                return { ok: false, error: 'quick compile 模块系统不可用' };
            }
            var mod;
            try {
                mod = qc.require(String(cmd.module || ''));
            } catch (e) {
                return { ok: false, error: '加载模块失败：' + (e.message || e) };
            }
            if (!mod) {
                return { ok: false, error: '模块加载后是空的：' + cmd.module };
            }

            if (cmd.method) {
                var fn = mod[cmd.method];
                if (typeof fn !== 'function') {
                    return {
                        ok: false,
                        error: '模块 ' + cmd.module + ' 上没有方法 ' + cmd.method +
                            '。可用：' + Object.keys(mod).slice(0, 20).join(', ')
                    };
                }
                var callArgs = cmd.args || [];
                var ret;
                try {
                    ret = fn.apply(mod, callArgs);
                } catch (e) {
                    return { ok: false, error: '调用 ' + cmd.method + ' 抛错：' + (e.message || e) };
                }
                return { ok: true, result: propValue(ret, ccRef()) };
            }

            // 只读导出
            var out2 = {};
            var ks = Object.keys(mod);
            for (var i = 0; i < ks.length; i++) {
                var v = null;
                try { v = propValue(mod[ks[i]], ccRef()); } catch (e) { continue; }
                if (v !== null && v !== undefined) out2[ks[i]] = v;
            }
            return { ok: true, result: out2 };
        }

        if (action === 'script') {
            // 在预览页里执行一段 JS 源码（多语句，可异步）。
            //
            // 为什么单独有这个：eval 只能跑单表达式，
            // 复杂逻辑（遍历 FairyGUI 树、反射类方法、等待几帧看状态变化）
            // 写成一行既难读又难转义。
            //
            // 支持异步：源码里可以 await / return Promise，
            // 执行器会等它 resolve 完再回报 —— 这样才能观察
            // 「点了之后状态变成什么样」。
            var code = String(cmd.code || '');
            if (!code) return { ok: false, error: '缺少 code' };
            var fn;
            try {
                /* jshint evil:true */
                fn = new Function('cc', 'window', 'return (async function () {\n' + code + '\n})();');
            } catch (e) {
                return { ok: false, error: '语法错误：' + e.message };
            }
            var ret;
            try {
                ret = fn(ccRef(), window);
            } catch (e) {
                return { ok: false, error: '执行出错：' + (e.message || e) };
            }
            // 等 Promise 完成（最多 15 秒）
            if (ret && typeof ret.then === 'function') {
                return new Promise(function (resolve) {
                    var settled = false;
                    var result = null;
                    var failure = null;
                    try {
                        ret.then(function (v) { settled = true; result = v; },
                                 function (e) { settled = true; failure = e; });
                    } catch (e) { settled = true; failure = e; }

                    var wait = Date.now() + 15000;
                    var poll = function () {
                        if (settled) {
                            resolve(failure
                                ? { ok: false, error: '执行出错：' + (failure.message || failure) }
                                : { ok: true, result: propValue(result, ccRef()) });
                            return;
                        }
                        if (Date.now() > wait) {
                            resolve({ ok: false, error: '脚本超时（15s），Promise 没 resolve' });
                            return;
                        }
                        setTimeout(poll, 50);
                    };
                    poll();
                });
            }
            return { ok: true, result: propValue(ret, ccRef()) };
        }

        if (action === 'clickbutton') {
            // 点节点上的 cc.Button —— 走引擎正规的 clickEvents 派发。
            //
            // 为什么这是「通用点按钮」的正确姿势：
            // cc.Button 的 clickEvents 里存着 (target, handler)，
            // 点击时引擎就是调这些 handler。
            // 直接调 handler 等价于「跳过命中测试」，
            // 而调 clickEvents.emit() 等价于「用户真点了这个按钮」。
            //
            // 参数：
            //   path   —— 节点路径（找不到时按名字全树搜）
            //   index  —— 同名节点取第几个（默认 0）
            var node = findNodeByPath(ccm, cmd.path, cmd.index, 'Button');
            if (!node) return { ok: false, error: '找不到节点：' + cmd.path };

            var btn = null;
            var cs = node._components || [];
            for (var i = 0; i < cs.length; i++) {
                // 只按类名判断 —— 2.4 的 cc.Button 没有 emit 方法，
                // 用「有没有 emit」来认按钮会永远找不到。
                if (cc.js.getClassName(cs[i]).indexOf('Button') >= 0) { btn = cs[i]; break; }
            }
            if (!btn) return { ok: false, error: '节点 ' + cmd.path + ' 上没有 Button 组件' };

            var evs = btn.clickEvents || [];
            var called = [];

            // 造一个引擎认可的 touch 事件
            var touch = null;
            try {
                var T = cc.Event.EventTouch;
                touch = new T();
                if (touch._setEventCode) touch._setEventCode(T.BEGAN);
                if (touch._setTouches) touch._setTouches([]);
                touch.target = node;
                touch.currentTarget = node;
            } catch (e) {
                touch = { target: node, currentTarget: node, type: 'touch' };
            }

            // 情况一：有 clickEvents —— 走引擎正规的派发路径
            if (evs.length) {
                for (var j = 0; j < evs.length; j++) {
                    var e = evs[j];
                    var target = e.target || node;
                    var fn = target[e.handler];

                    // Cocos 的 Component.EventHandler 在触发时，
                    // 会在 **target 节点及其组件** 上找 handler。
                    // 而引擎序列化时 target 常常只存了节点 ——
                    // 真正带方法的是某个祖先节点上的自定义脚本组件
                    // （比如 bottle 的 onClickBottle 在父节点 level1 的 Game 组件上）。
                    // 所以这里沿父链往上找，找到第一个带该方法的组件。
                    if (typeof fn !== 'function') {
                        var holder = null;
                        var holderComp = null;
                        var probe = node;
                        var depth = 0;
                        while (probe && depth < 8) {
                            var pcs = probe._components || [];
                            for (var c = 0; c < pcs.length; c++) {
                                if (typeof pcs[c][e.handler] === 'function') {
                                    holder = probe;
                                    holderComp = pcs[c];
                                    break;
                                }
                            }
                            if (holderComp) break;
                            probe = probe.parent;
                            depth++;
                        }
                        if (holderComp) {
                            fn = holderComp[e.handler];
                            target = holderComp;
                        }
                    }

                    if (typeof fn !== 'function') {
                        called.push(e.handler + '(找不到：节点和祖先的组件上都没有)');
                        continue;
                    }
                    try {
                        fn.call(target, touch);
                        called.push((cc.js.getClassName(target) || target.name || '?') + '.' + e.handler);
                    } catch (err) {
                        return { ok: false, error: '点击 ' + e.handler + ' 抛错：' + (err.message || err) };
                    }
                }
                return { ok: true, result: { clicked: node.name, called: called } };
            }

            // 情况二：没有 clickEvents —— 有些按钮是**代码绑定**的
            //（比如 this.onTouch(this.btnBack, this.onBtnBack, this)）。
            // 这时按名字在节点和父链的组件里找「像点击处理」的方法。
            //
            // 只认点击语义的方法名：onBtn* / on*Click / on*Event / on*Touch。
            // 不能只看 on 前缀 —— onItemRender / onLoad / onEnable 这些不是点击处理，
            // 调了只会抛错（实测 onItemRender 会报 item.getComponent is not a function）。
            var CLICK_LIKE = /^on(Btn|.*Click|.*Event|.*Touch)/;
            var SKIP = {
                onLoad: 1, onEnable: 1, onDisable: 1, onDestroy: 1, onStart: 1,
                onEvents: 1, onItemRender: 1, onUpdate: 1, onEnter: 1, onExit: 1,
                onDisableIn: 1, onEnableIn: 1, onDraw: 1
            };
            var fallback = null;
            var fbComp = null;
            var fbName = null;
            var p2 = node;
            var d2 = 0;
            while (p2 && d2 < 8 && !fbComp) {
                var cs2 = p2._components || [];
                for (var c2 = 0; c2 < cs2.length; c2++) {
                    var proto = Object.getPrototypeOf(cs2[c2]);
                    if (!proto) continue;
                    var mnames = Object.getOwnPropertyNames(proto).filter(function (k) {
                        if (k === 'constructor') return false;
                        if (SKIP[k]) return false;
                        if (!CLICK_LIKE.test(k)) return false;
                        return typeof proto[k] === 'function';
                    });
                    if (mnames.length) {
                        fbComp = cs2[c2];
                        fbName = mnames[0];
                        break;
                    }
                }
                p2 = p2.parent;
                d2++;
            }

            if (!fbComp) {
                return {
                    ok: false,
                    error: '按钮 ' + cmd.path + ' 没有 clickEvents，' +
                        '节点和祖先的组件上也没找到 onBtn*/on*Click/on*Event 这类点击方法。' +
                        '（这个按钮可能是代码动态绑定的，用 script 动作直接调它的方法）'
                };
            }

            try {
                fbComp[fbName](touch);
            } catch (err2) {
                return { ok: false, error: '点击 ' + fbName + ' 抛错：' + (err2.message || err2) };
            }
            called.push((cc.js.getClassName(fbComp) || fbComp.node.name || '?') + '.' + fbName);
            return {
                ok: true,
                result: {
                    clicked: node.name,
                    called: called,
                    note: '这个按钮没有 clickEvents（代码绑定），改为直接调用 ' + fbName
                }
            };
        }

        if (action === 'dispatchtouch') {
            // 真派发 DOM 触摸事件到 canvas —— 走引擎自己的输入系统。
            //
            // 为什么不用 node.emit('touch', evt)：
            // 那只是往节点上扔事件，Button 的点击判定、命中测试都不经过，
            // 结果是「事件发出去了但游戏没反应」。
            // 派发 DOM 事件才能让引擎的 input 系统完整跑一遍
            // （坐标转换 → 命中测试 → Button 响应）。
            //
            // 坐标换算（2.4）：
            //   节点世界坐标 → 父节点空间 → Canvas 节点空间（原点左下）
            //   → 乘 view 缩放 → canvas 像素 → 加 canvas 的 CSS 偏移
            if (!ccm) return { ok: false, error: 'cc 引擎还没加载好' };
            var node = findNodeByPath(ccm, cmd.path, cmd.index);
            if (!node) return { ok: false, error: '找不到节点：' + cmd.path };

            var canvas = document.getElementById('GameCanvas') || document.querySelector('canvas');
            if (!canvas) return { ok: false, error: '页面上找不到 canvas' };

            // 1) 世界坐标 → 父空间
            var wp = node.position;
            var parent = node.parent;
            var lp = parent && parent.convertToNodeSpaceAR
                ? parent.convertToNodeSpaceAR(cc.v2(wp.x, wp.y))
                : cc.v2(wp.x, wp.y);

            // 2) 父空间 → Canvas 节点空间（Canvas 节点位置就是偏移量）
            var canvasNode = null;
            var findCanvas = function (n) {
                if (!n || canvasNode) return;
                var cs = n._components || [];
                for (var i = 0; i < cs.length; i++) {
                    if (cc.js.getClassName(cs[i]).replace(/^cc[_.]/, '') === 'Canvas') { canvasNode = n; return; }
                }
                (n.children || []).forEach(findCanvas);
            };
            findCanvas(ccm.director.getScene());
            var originX = canvasNode ? canvasNode.position.x : 0;
            var originY = canvasNode ? canvasNode.position.y : 0;
            var px = lp.x + originX;
            var py = lp.y + originY;

            // 3) 乘 view 缩放 → canvas 像素
            var sx = ccm.view.getScaleX();
            var sy = ccm.view.getScaleY();
            var cw = canvas.width;
            var ch = canvas.height;
            var dx = px * sx;
            var dy = py * sy;

            // 4) 画布像素 → CSS 像素（canvas 可能有 CSS 缩放）
            var rect = canvas.getBoundingClientRect();
            var cssX = rect.left + dx * (rect.width / cw);
            var cssY = rect.top + (ch - dy) * (rect.height / ch);   // 引擎原点在左下，DOM 在左上

            var kinds = cmd.kind ? String(cmd.kind) : 'touch';
            var types = kinds === 'mouse'
                ? ['mousedown', 'mouseup', 'click']
                : ['touchstart', 'touchend'];

            var sent = [];
            for (var i = 0; i < types.length; i++) {
                var t = types[i];
                var ev;
                try {
                    if (t.indexOf('touch') === 0) {
                        var touchDesc = {
                            identifier: 1, target: canvas,
                            clientX: cssX, clientY: cssY, pageX: cssX, pageY: cssY,
                            screenX: cssX, screenY: cssY
                        };
                        ev = new TouchEvent(t, {
                            bubbles: true, cancelable: true,
                            touches: t === 'touchend' ? [] : [new Touch(touchDesc)],
                            targetTouches: t === 'touchend' ? [] : [new Touch(touchDesc)],
                            changedTouches: [new Touch(touchDesc)]
                        });
                    } else {
                        ev = new MouseEvent(t, {
                            bubbles: true, cancelable: true, clientX: cssX, clientY: cssY,
                            screenX: cssX, screenY: cssY, button: 0
                        });
                    }
                    canvas.dispatchEvent(ev);
                    sent.push(t);
                } catch (e) {
                    return { ok: false, error: '派发 ' + t + ' 失败：' + (e.message || e) };
                }
            }

            return {
                ok: true,
                result: {
                    sent: sent,
                    canvasX: Math.round(dx),
                    canvasY: Math.round(dy),
                    cssX: Math.round(cssX),
                    cssY: Math.round(cssY)
                }
            };
        }

        if (action === 'fguitree') {
            // 列出 FairyGUI 的对象树（GObject）。
            //
            // FairyGUI 的界面不是 cc.Node 树，read/preview_report 都看不到。
            // 这是「看清游戏界面有哪些可点的东西」的唯一入口。
            var f = window.fgui;
            if (!f || !f.GRoot || !f.GRoot.inst) {
                return { ok: false, error: 'FairyGUI 运行时不可用' };
            }
            var root = f.GRoot.inst;
            var maxDepth = (typeof cmd.depth === 'number') ? cmd.depth : 8;
            var filter = cmd.filter ? String(cmd.filter).toLowerCase() : null;
            var lines = [];

            var walk = function (o, d) {
                if (!o || d > maxDepth) return;
                var nm = o.name || '?';
                var t = null;
                try { t = o.constructor ? o.constructor.name : null; } catch (e) {}
                var txt = '';
                try { if (o.text) txt = ' "' + String(o.text).slice(0, 20) + '"'; } catch (e) {}
                if (!filter || nm.toLowerCase().indexOf(filter) >= 0 || (t && t.toLowerCase().indexOf(filter) >= 0)) {
                    lines.push('  '.repeat(d) + nm + ' [' + (t || '?') + ']' + txt);
                }
                var n = o.numChildren || 0;
                for (var i = 0; i < n; i++) {
                    try { walk(o.getChildAt(i), d + 1); } catch (e) { /* 忽略 */ }
                }
            };
            walk(root, 0);

            return { ok: true, result: lines.join('\n') || '（空）' };
        }

        if (action === 'fguiclick') {
            // 点 FairyGUI 里的按钮/对象。
            //
            // 为什么单独有这个：FairyGUI 的按钮是 GObject，不是 cc.Node，
            // 而且回调挂在按钮的 onClick 列表里 —— 反射组件方法找不到它。
            // 正确做法是用 FairyGUI 官方的 simulateClick：
            // 它派发真实的 TOUCH_BEGIN/TOUCH_END 事件链，
            // 按钮的 onClick 会像用户真点了一样触发。
            //
            // 参数：
            //   path    —— GObject 名字（可以只给名字，全树搜）
            //   type    —— 只点这个类型的（可选，如 GButton）
            //   index   —— 同名时取第几个（默认 0）
            var f = window.fgui;
            if (!f || !f.GRoot || !f.GRoot.inst) {
                return { ok: false, error: 'FairyGUI 运行时不可用（GRoot.inst 为空）' };
            }
            var root = f.GRoot.inst;
            var wantName = String(cmd.path || '');
            if (!wantName) return { ok: false, error: '缺少 path（GObject 名字）' };
            var wantType = cmd.type ? String(cmd.type) : null;
            var wantIndex = (typeof cmd.index === 'number') ? cmd.index : 0;

            var hits = [];
            var walk = function (o) {
                if (!o) return;
                if (o.name === wantName) {
                    var t = null;
                    try { t = f.GObject && o.constructor ? o.constructor.name : null; } catch (e) {}
                    hits.push({ obj: o, type: t });
                }
                var n = o.numChildren || 0;
                for (var i = 0; i < n; i++) {
                    try { walk(o.getChildAt(i)); } catch (e) { /* 忽略 */ }
                }
            };
            walk(root);

            if (!hits.length) {
                return { ok: false, error: 'FairyGUI 树里没找到叫 "' + wantName + '" 的对象' };
            }
            if (wantType) {
                var filtered = hits.filter(function (h) { return h.type === wantType; });
                if (filtered.length) hits = filtered;
            }
            if (wantIndex >= hits.length) {
                return {
                    ok: false,
                    error: '同名对象只有 ' + hits.length + ' 个，取不到第 ' + wantIndex + ' 个'
                };
            }
            var target = hits[wantIndex].obj;
            try {
                var ip = root.inputProcessor;
                if (!ip || typeof ip.simulateClick !== 'function') {
                    return { ok: false, error: 'InputProcessor.simulateClick 不可用' };
                }
                ip.simulateClick(target);
            } catch (e) {
                return { ok: false, error: '点击抛错：' + (e.message || e) };
            }
            return {
                ok: true,
                result: {
                    clicked: wantName,
                    type: hits[wantIndex].type,
                    total: hits.length
                }
            };
        }

        if (action === 'screenshot') {
            // 抓 canvas 像素，返回尺寸和平均色（判断画面是不是全黑/白）
            var canvas = document.getElementById('GameCanvas') || document.querySelector('canvas');
            if (!canvas) return { ok: false, error: '页面上找不到 canvas' };
            var w = canvas.width, h = canvas.height;
            var sample = null;
            try {
                var g = canvas.getContext('webgl') || canvas.getContext('2d');
                if (g && w && h) {
                    var px = new Uint8Array(4 * 16);
                    var pts = [];
                    for (var i = 0; i < 16; i++) {
                        pts.push([
                            Math.floor(w * (0.2 + 0.6 * ((i % 4) / 3))),
                            Math.floor(h * (0.2 + 0.6 * (Math.floor(i / 4) / 3)))
                        ]);
                    }
                    var sum = 0, n = 0;
                    for (var p = 0; p < pts.length; p++) {
                        var one = new Uint8Array(4);
                        try { g.readPixels(pts[p][0], pts[p][1], 1, 1, g.RGBA, g.UNSIGNED_BYTE, one); } catch (e) { continue; }
                        sum += one[0] + one[1] + one[2];
                        n += 3;
                    }
                    sample = n ? Math.round(sum / n) : null;
                }
            } catch (e) { sample = null; }
            return { ok: true, result: { width: w, height: h, avgColor: sample } };
        }

        return { ok: false, error: '未知指令：' + action };
    }

    function pollCommands() {
        if (stopped) return;
        // 上一次轮询没回来就别叠着发，但要给个上限：
        // 页面重载 / 服务端重启会把在途连接晾死，回调永不触发，
        // 那样 cmdBusy 会一直 true —— 轮询永久停摆，命令全堆在服务端，表现就是"连着但不执行"
        if (cmdBusy) {
            if (Date.now() - cmdBusyAt < 5000) return;
        }
        cmdBusy = true;
        cmdBusyAt = Date.now();
        xhr('GET', '/bridge/commands?since=' + cmdCursor + '&page=' + encodeURIComponent(PAGE_ID), null, function (err, data) {
            cmdBusy = false;
            if (err || !data) return;
            var list = data.commands || [];
            for (var i = 0; i < list.length; i++) {
                var cmd = list[i];
                cmdCursor = Math.max(cmdCursor, cmd.seq || 0);
                reportResult(cmd, null);
            }
            // 首次拉取（cursor 还是 -1）：服务端只回一个当前位点，
            // 历史命令一律不重放 —— 否则整页重载会把这次会话发过的所有脚本重跑一遍
            if (cmdCursor < 0) {
                cmdCursor = (typeof data.cursor === 'number' ? data.cursor : 0);
            }
        });
    }

    /**
     * 执行一条指令并把结果报回去。
     *
     * runCommand 可能返回 Promise（script 动作支持异步），
     * 所以这里要能处理两种情况。
     */
    function reportResult(cmd, preError) {
        var res;
        if (preError) {
            res = { ok: false, error: preError };
        } else {
            try {
                res = runCommand(cmd);
            } catch (e) {
                res = { ok: false, error: '执行指令时抛错：' + (e.message || e) };
            }
        }

        var send = function (r) {
            r.id = cmd.id;
            r.seq = cmd.seq;
            xhr('POST', '/bridge/result', r, function () { /* 忽略 */ });
        };

        if (res && typeof res.then === 'function') {
            res.then(send, function (e) {
                send({ ok: false, error: '指令执行出错：' + (e && e.message ? e.message : e) });
            });
            return;
        }
        send(res);
    }

    // ---------------------------------------------------------------- 启动

    installConsoleCapture();

    // 等引擎起来
    var tries = 0;
    var waitIv = setInterval(function () {
        tries++;
        var ccm = ccRef();
        var ready = false;
        try { ready = !!(ccm && ccm.director && ccm.director.getScene()); } catch (e) { ready = false; }
        if (ready) {
            clearInterval(waitIv);
            pushLog('log', ['[MCP Bridge] 检测到 cc 引擎就绪，开始上报']);
            report();
            setInterval(report, INTERVAL);
        } else if (tries > 600) {
            clearInterval(waitIv);
            pushLog('warn', ['[MCP Bridge] 30 秒还没等到 cc 引擎，放弃自动上报']);
        }
    }, 100);

    setInterval(pollCommands, CMD_POLL);

    // 页面卸载时告诉服务端
    window.addEventListener('beforeunload', function () {
        stopped = true;
        xhr('POST', '/bridge/bye', { at: now() }, function () { /* 忽略 */ });
    });

    pushLog('log', ['[MCP Bridge] 已注入，端口 ' + PORT]);
})();
