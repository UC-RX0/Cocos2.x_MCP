/**
 * cocos-mcp-2x 运行时上报（静默注入）
 *
 * 由 MCP 扩展在构建 web-mobile / web-desktop 产物后自动注入。
 * 作用：把浏览器里跑着的游戏的运行时状态，POST 回 MCP 扩展的 HTTP 端点，
 *       这样 AI 就能读到"玩家实际在玩的时候"的状态，而不只是编辑器里的设计态。
 *
 * 设计原则：
 *   - 静默：不弹窗、不改画面、不影响游戏逻辑，失败也完全无声
 *   - 低频：默认 2 秒一次，避免影响帧率
 *   - 可关：URL 加 ?mcp=off 或 ?mcp=port=0 即禁用
 *   - 无依赖：不依赖 MCP 扩展存在，连不上就放弃
 *
 * 协议：POST {mcp}/runtime-report
 *   { project, port, scene, nodes: {...}, frame, fps, at }
 */

(function () {
    'use strict';

    // ---------- 配置 ----------
    var DEFAULT_PORT = 25901;

    function readConfig() {
        var cfg = { port: DEFAULT_PORT, enabled: true, interval: 2000, path: 'runtime-report' };

        // 从注入时写死的全局变量读（构建时由扩展填入）
        if (window.__MCP_RUNTIME_CONFIG__) {
            var c = window.__MCP_RUNTIME_CONFIG__;
            if (typeof c.port === 'number' && c.port > 0) cfg.port = c.port;
            if (typeof c.interval === 'number' && c.interval > 0) cfg.interval = c.interval;
            if (typeof c.path === 'string') cfg.path = c.path;
            if (c.enabled === false) cfg.enabled = false;
            if (c.project) cfg.project = c.project;
        }

        // URL 参数覆盖：?mcp=off 关闭，?mcp=port=25800 换端口
        try {
            var q = window.location.search || '';
            if (/[?&]mcp=off(&|$)/.test(q)) cfg.enabled = false;
            var pm = q.match(/[?&]mcp=port=(\d+)/);
            if (pm) cfg.port = parseInt(pm[1], 10);
            var im = q.match(/[?&]mcp=interval=(\d+)/);
            if (im) cfg.interval = parseInt(im[1], 10);
        } catch (e) { /* 忽略 */ }

        // 极端情况：不是本机页面就别上报（避免污染别的服务）
        try {
            var h = window.location.hostname;
            if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '') {
                cfg.enabled = false;
            }
        } catch (e) { /* 忽略 */ }

        return cfg;
    }

    var CFG = readConfig();
    if (!CFG.enabled) return;

    // ---------- 序列化 ----------
    function safe(v, depth) {
        if (v === null || v === undefined) return null;
        var t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean') return v;
        if (depth > 2) return null;
        if (v instanceof Array) {
            var arr = [];
            for (var i = 0; i < Math.min(v.length, 30); i++) arr.push(safe(v[i], depth + 1));
            return arr;
        }
        if (t === 'object') {
            var out = {};
            try {
                var keys = Object.keys(v);
                for (var k = 0; k < keys.length && k < 30; k++) {
                    var key = keys[k];
                    if (key.charAt(0) === '_') continue;
                    var val = safe(v[key], depth + 1);
                    if (val !== null) out[key] = val;
                }
            } catch (e) { return null; }
            return out;
        }
        return null;
    }

    function nodeName(n) {
        try { return n.name || '?'; } catch (e) { return '?'; }
    }

    /** 取 cc 引擎对象。优先 window.cc（真实浏览器里两者等价），退回全局 cc */
    function ccRef() {
        try {
            if (window.cc) return window.cc;
        } catch (e) { /* 忽略 */ }
        try {
            if (typeof cc !== 'undefined') return cc;
        } catch (e) { /* 忽略 */ }
        return null;
    }

    function compType(c) {
        try {
            var ccm = ccRef();
            if (ccm && ccm.js && ccm.js.getClassName) {
                var n = ccm.js.getClassName(c);
                return (n && n.indexOf('cc_') === 0) ? 'cc.' + n.slice(3) : n;
            }
            return c.constructor ? c.constructor.name : '?';
        } catch (e) { return '?'; }
    }

    /** 读一棵树：节点 + 组件公开属性 */
    function readTree(root, maxDepth, maxNodes, rootIsScene) {
        var count = 0;
        var truncated = false;

        // B 类修复：cc.Scene 没有 active 属性，直接读会每次上报都打
        // "is not defined in the Scene, it is only defined in normal nodes"，
        // 把 errorTotal 淹没在桥接自身的噪声里。根节点按 active=true 处理。
        var sceneRoot = !!rootIsScene;
        if (!sceneRoot) {
            try {
                var ccm0 = ccRef();
                sceneRoot = !!(ccm0 && ccm0.Scene && root instanceof ccm0.Scene);
            } catch (e) { sceneRoot = false; }
        }

        function walk(node, depth) {
            if (count >= maxNodes) { truncated = true; return null; }
            count++;

            var activeVal = true;
            if (!(depth === 0 && sceneRoot)) {
                try { activeVal = !!node.active; } catch (e) { activeVal = true; }
            }

            var out = {
                name: nodeName(node),
                active: activeVal,
                components: []
            };

            try {
                out.position = { x: node.position.x, y: node.position.y, z: node.position.z };
            } catch (e) { /* 忽略 */ }
            try {
                out.scale = { x: node.scaleX, y: node.scaleY, z: node.scaleZ };
            } catch (e) { /* 忽略 */ }

            var comps = [];
            try {
                var ccm = ccRef();
                comps = node._components || (node.getComponents && ccm ? node.getComponents(ccm.Component) : []) || [];
            } catch (e) { comps = []; }

            for (var i = 0; i < comps.length && i < 12; i++) {
                var comp = comps[i];
                var co = { type: compType(comp), props: {} };
                try {
                    var names = Object.getOwnPropertyNames(comp);
                    var got = 0;
                    for (var j = 0; j < names.length && got < 25; j++) {
                        var n = names[j];
                        if (n.charAt(0) === '_') continue;
                        if (n === 'constructor' || n === 'node') continue;
                        if (typeof comp[n] === 'function') continue;
                        var v = safe(comp[n], 0);
                        if (v !== null) { co.props[n] = v; got++; }
                    }
                } catch (e) { /* 忽略 */ }
                out.components.push(co);
            }

            out.children = [];
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

        var tree = walk(root, 0);
        tree.truncated = truncated;
        tree.totalRead = count;
        return tree;
    }

    // ---------- 捕获 console ----------
    // 游戏里的错误通常是 console.error 打出来的。
    // 不劫持 console 的话，这些错误只进浏览器控制台，AI 永远看不到。
    var consoleLog = [];
    var consoleMax = 100;
    var consoleInstalled = false;

    function installConsoleCapture() {
        if (consoleInstalled) return;
        try {
            // 劫持 console 对象的 log/warn/error 等方法。
            //
            // 要同时处理两个引用：
            //   - 全局的 console（游戏代码直接 console.error(...) 走这个）
            //   - window.console（有些代码缓存了 window.console 的引用）
            // 浏览器里两者通常是同一个对象，但保��都处理更稳。
            var c = typeof console !== 'undefined' ? console : null;
            var wc = (typeof window !== 'undefined' && window.console) ? window.console : null;

            if (!c && !wc) return;
            var target = c || wc;
            if (!target.log) return;

            var origLog = target.log, origWarn = target.warn, origError = target.error;
            var origInfo = target.info, origDebug = target.debug;

            function push(level, args) {
                var parts = [];
                for (var i = 0; i < args.length; i++) {
                    var a = args[i];
                    var t = typeof a;
                    if (t === 'string') parts.push(a);
                    else if (t === 'number' || t === 'boolean') parts.push(String(a));
                    else if (a === null) parts.push('null');
                    else if (a === undefined) parts.push('undefined');
                    else {
                        try { parts.push(JSON.stringify(a)); } catch (e) { parts.push('[object]'); }
                    }
                }
                consoleLog.push({ level: level, text: parts.join(' '), at: Date.now() });
                if (consoleLog.length > consoleMax) consoleLog.shift();
            }

            function wrap(level, orig, fallback) {
                return function () {
                    push(level, arguments);
                    var f = orig || fallback;
                    if (typeof f === 'function') f.apply(target, arguments);
                };
            }

            var wrapped = {
                log: wrap('log', origLog, origLog),
                warn: wrap('warn', origWarn, origLog),
                error: wrap('error', origError, origLog),
                info: wrap('info', origInfo, origLog),
                debug: wrap('debug', origDebug, origLog)
            };

            if (c) {
                c.log = wrapped.log; c.warn = wrapped.warn; c.error = wrapped.error;
                c.info = wrapped.info; c.debug = wrapped.debug;
            }
            if (wc && wc !== c) {
                wc.log = wrapped.log; wc.warn = wrapped.warn; wc.error = wrapped.error;
                wc.info = wrapped.info; wc.debug = wrapped.debug;
            }

            // 未捕获异常也要抓到
            try {
                window.addEventListener('error', function (e) {
                    push('error', ['[uncaught] ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || '')]);
                });
                window.addEventListener('unhandledrejection', function (e) {
                    var r = e && e.reason;
                    push('error', ['[unhandled rejection] ' + (r && r.message ? r.message : String(r))]);
                });
            } catch (e2) { /* 忽略 */ }

            consoleInstalled = true;
        } catch (e) {
            // 装不上就算了，不影响别的功能
        }
    }

    installConsoleCapture();

    // ---------- 上报 ----------
    var failed = 0;

    function report() {
        var ccm = ccRef();
        if (!ccm || !ccm.director) return;

        var scene = null;
        try { scene = ccm.director.getScene(); } catch (e) { scene = null; }
        if (!scene) return;

        var payload = {
            project: CFG.project || null,
            scene: nodeName(scene),
            frame: 0,
            fps: 0,
            at: Date.now(),
            tree: null,
            console: null
        };

        try { payload.frame = ccm.director.getTotalFrames(); } catch (e) { /* 忽略 */ }
        try { payload.fps = Math.round(ccm.director.getFPS()); } catch (e) { /* 忽略 */ }

        // 只在需要时读树（比较费）
        try { payload.tree = readTree(scene, 3, 150, true); } catch (e) { payload.tree = null; }

        // 带上 console 输出，AI 才能看到游戏里报的错误
        try {
            payload.console = {
                installed: consoleInstalled,
                entries: consoleLog.slice(-30)
            };
        } catch (e) { payload.console = null; }

        var body = JSON.stringify(payload);
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'http://127.0.0.1:' + CFG.port + '/' + CFG.path, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status >= 200 && xhr.status < 300) { failed = 0; return; }
                // 连不上就放弃，别一直刷
                failed++;
                if (failed > 3) stop();
            };
            xhr.send(body);
        } catch (e) {
            failed++;
            if (failed > 3) stop();
        }
    }

    var timer = null;
    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    // ---------- 启动 ----------
    // 等 cc 和场景就绪
    var tries = 0;
    var iv = setInterval(function () {
        tries++;
        var ccm = ccRef();
        if (!ccm || !ccm.director) {
            if (tries > 600) clearInterval(iv);   // 30 秒还没 cc，放弃
            return;
        }
        var scene = null;
        try { scene = ccm.director.getScene(); } catch (e) { /* 忽略 */ }
        if (!scene) {
            if (tries > 600) clearInterval(iv);
            return;
        }
        clearInterval(iv);

        // 先立刻报一次，之后按间隔
        setTimeout(report, 500);
        timer = setInterval(report, CFG.interval);

        // 页面卸载时停掉
        window.addEventListener('beforeunload', stop);
    }, 50);
})();
