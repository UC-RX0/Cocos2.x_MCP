'use strict';

/**
 * Cocos Creator 2.x MCP Server
 *
 * 为什么 2.x 要单独写一个：
 *   1. 扩展 API 是老的（main-menu / panel），3.x 的 contributions 在 2.x 不认
 *   2. 2.x 没有内嵌 Game 面板，任何"在编辑器里操作游戏画面"的设计都不成立
 *   3. 但 2.x 的 .fire / .prefab 是纯 JSON —— 文件层能做的事比编辑器 API 还多
 *
 * 设计原则：不碰编辑器私有 IPC。
 *   场景读写走 .fire 的 JSON 解析，资源刷新走 Editor.assetdb，
 *   其余全部走文件系统。这样跨 2.3 / 2.4 都能用，也不会因为编辑器内部
 *   消息名变化而失效。
 *
 * 兼容性：Cocos Creator 2.4 内置 Node 版本较老，
 *   本文件刻意不使用 ?. / ?? / Array.flat 等新语法。
 *
 * v0.2 新增（解决"AI 看不懂项目"的问题）：
 *   - search_files   全文搜索，AI 读代码的刚需，之前只能逐个 read_file
 *   - resolve_uuid   uuid ↔ 资源路径双向解析
 *   - read_scene_node 单个节点的完整序列化值（@property 真实引用）
 *   - query_scene_tree 自动把脚本组件的压缩 uuid 还原成路径 + 类名
 *   - execute_script 支持 Promise，refresh_assets 等 assetdb 真回调
 *   - list_open_projects + 端口注册表，解决多项目端口递增连错项目
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PKG_NAME = 'cocos-mcp-2x';
// 版本从 package.json 读，避免两处各写一份、改一处忘一处
const VERSION = (function () {
    try {
        var pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
})();
const LOG = '[' + PKG_NAME + ']';
const BASE_PORT = 25900;
const PORT_RETRY = 10;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 400;
const UUID_CACHE_MS = 30000;

// 每次 load 生成一个新标识。热重载脚本靠它判断"到底换没换实例"，
// 比看 version 可靠：只改实现不改 VERSION 时版本号是不变的。
const INSTANCE_ID = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);

var server = null;
var listeningPort = 0;

// 搜索时默认跳过的目录。library / temp / local 是编辑器产物，搜了只会刷屏
var SKIP_DIRS = {
    'node_modules': 1, '.git': 1, '.svn': 1, 'library': 1, 'temp': 1,
    'local': 1, 'build': 1, 'dist': 1, '.vscode': 1
};

/**
 * 「写过但还没让编辑器导入」的文件。
 *
 * 为什么要有这个：改一个视图往往要同时写 .prefab、.prefab.meta、.ts、.ts.meta，
 * 它们分散在不同目录 —— 漏刷任一个的表现都是"编辑器里还是旧的"，最难查。
 * 所以写入时自动记账，refresh_assets 不传参时默认把记下的目录全刷一遍。
 *
 * 只记 assets 下的文件：temp/ 之类编辑器本来就不导入。
 */
var dirtyAssets = {};
var dirtyOrder = [];

function markDirty(rel) {
    var p = String(rel || '').replace(/\\/g, '/');
    if (!p) return;
    if (p.indexOf('assets/') !== 0) return;
    if (dirtyAssets[p]) return;
    dirtyAssets[p] = true;
    dirtyOrder.push(p);
}

function dirtyList() {
    return dirtyOrder.slice();
}

function clearDirty(covered) {
    if (!covered) { dirtyAssets = {}; dirtyOrder = []; return; }
    var keep = [];
    for (var i = 0; i < dirtyOrder.length; i++) {
        var p = dirtyOrder[i];
        var dir = p.replace(/\/[^/]*$/, '');
        if (covered[dir]) { delete dirtyAssets[p]; continue; }
        keep.push(p);
    }
    dirtyOrder = keep;
}

//#region 基础工具

/**
 * lib/ 是拆出来的纯逻辑层，不依赖 Editor，可以单独测试。
 * 这里把它们的导出接回来，下面所有代码照旧按全局函数用。
 */
var fsutil = require('./lib/fsutil.js');
var uuidlib = require('./lib/uuid.js');
var sceneparse = require('./lib/scene-parse.js');
var scenetools = require('./lib/scene-tools.js');
var prefablib = require('./lib/prefab.js');
var scenetpl = require('./lib/scene-template.js');
var doclib = require('./lib/doc.js');
var graphlib = require('./lib/asset-graph.js');
var editorState = require('./lib/editor-state.js');
var toolSchema = require('./lib/tool-schema.js');

var statSafe = fsutil.statSafe;
var walkFiles = fsutil.walkFiles;
var readTail = fsutil.readTail;
var escapeRegExp = fsutil.escapeRegExp;
var globToRegExp = fsutil.globToRegExp;

var compressUuid = uuidlib.compressUuid;
var buildUuidIndex = uuidlib.buildUuidIndex;
var uuidKind = uuidlib.uuidKind;
var uuidToPath = uuidlib.uuidToPath;
var pathToUuid = uuidlib.pathToUuid;
var readScriptInfo = uuidlib.readScriptInfo;

var loadSerialized = sceneparse.loadSerialized;
var findRootIndex = sceneparse.findRootIndex;
var readTRS = sceneparse.readTRS;
var readScaleTRS = sceneparse.readScaleTRS;
var readRotationTRS = sceneparse.readRotationTRS;
var describeComponentType = sceneparse.describeComponentType;
var findSpriteFrameUuidFor = sceneparse.findSpriteFrameUuidFor;
var expandNode = sceneparse.expandNode;
var countNodes = sceneparse.countNodes;
var findNode = sceneparse.findNode;
var findNodeByName = sceneparse.findNodeByName;
var resolveNode = sceneparse.resolveNode;
var nodeNotFoundError = sceneparse.nodeNotFoundError;
var dumpProps = sceneparse.dumpProps;
var PROP_SKIP = sceneparse.PROP_SKIP;

var findSceneRootId = scenetools.findSceneRootId;
var findRootForEdit = sceneparse.findRootForEdit;   // 唯一实现，在 scene-parse.js
var isRootRef = scenetools.isRootRef;
var makePrefabInfo = scenetools.makePrefabInfo;
var saveNote = scenetools.saveNote;
var newNodeId = scenetools.newNodeId;
var pickNodeTemplate = scenetools.pickNodeTemplate;
var loadSceneForEdit = scenetools.loadSceneForEdit;
var saveSceneFile = scenetools.saveSceneFile;
var toolSceneAddNode = scenetools.toolSceneAddNode;
var toolSceneSetProps = scenetools.toolSceneSetProps;
var resolveComponentType = scenetools.resolveComponentType;
var findScriptByClassName = scenetools.findScriptByClassName;
var resolveAssetUuid = scenetools.resolveAssetUuid;
var applyComponentProps = scenetools.applyComponentProps;
var findComponentIndex = scenetools.findComponentIndex;
var toolSceneAddComponent = scenetools.toolSceneAddComponent;
var toolSceneRemoveComponent = scenetools.toolSceneRemoveComponent;
var toolSceneSetComponentProps = scenetools.toolSceneSetComponentProps;
var toolPrefabInstantiate = scenetools.toolPrefabInstantiate;
var collectDeletionSet = scenetools.collectDeletionSet;
var scanRefs = scenetools.scanRefs;
var rewriteRefs = scenetools.rewriteRefs;
var toolSceneRemoveNode = scenetools.toolSceneRemoveNode;
var openDocForEdit = scenetools.openDocForEdit;
var commitDoc = scenetools.commitDoc;
var applyOps = scenetools.applyOps;

var pickPrefabTemplates = prefablib.pickTemplates;
var buildPrefabFromSpec = prefablib.buildFromSpec;
var validatePrefabArray = prefablib.validatePrefabArray;
var assertPrefabArray = prefablib.assertPrefabArray;
var stabilizePrefabFileIds = prefablib.stabilizeFileIds;
var prefabLayoutCheck = prefablib.layoutCheck;

/**
 * 把主进程的能力注入给 lib 模块。
 * lib 模块刻意不直接引用 Editor —— 那样它们就能脱离编辑器单测。
 */
uuidlib.setContext({
    projectRoot: projectRoot,
    relPath: relPath,
    safePath: safePath,
    walkFiles: walkFiles,
    statSafe: statSafe,
    skipDirs: SKIP_DIRS
});

sceneparse.setContext({
    readScriptInfo: readScriptInfo
});

prefablib.setContext({
    newNodeId: newNodeId
});

doclib.setContext({
    validatePrefab: function (arr) { return prefablib.validatePrefabArray(arr); }
});

graphlib.setContext({
    projectRoot: projectRoot,
    relPath: relPath,
    safePath: safePath,
    walkFiles: walkFiles,
    statSafe: statSafe,
    skipDirs: SKIP_DIRS
});

scenetools.setContext({
    projectRoot: projectRoot,
    safePath: safePath,
    relPath: relPath,
    statSafe: statSafe,
    buildUuidIndex: buildUuidIndex,
    uuidToPath: uuidToPath,
    pathToUuid: pathToUuid,
    uuidKind: uuidKind,
    compressUuid: compressUuid,
    readScriptInfo: readScriptInfo,
    loadSerialized: loadSerialized,
    findRootIndex: findRootIndex,
    findRootForEdit: findRootForEdit,
    moveNode: toolSceneMoveNode,
    validateDoc: doclib.validateDocArray,
    summarizeDoc: doclib.summarize,
    resolveNode: resolveNode,
    nodeNotFoundError: nodeNotFoundError,
    findNode: findNode,
    writeJsonPreserving: writeJsonPreserving,
    currentSceneFile: currentSceneFile,
    describeEditorState: describeEditorState,
    noteFileWrite: noteFileWrite
});

editorState.setContext({
    projectRoot: projectRoot,
    statSafe: statSafe,
    relPath: relPath
});

/** 当前项目根目录 */
function projectRoot() {
    if (typeof Editor !== 'undefined' && Editor.Project && Editor.Project.path) {
        return Editor.Project.path;
    }
    return null;
}

/**
 * 把相对路径解析成项目内的绝对路径，并阻断越界访问。
 * 这是唯一的安全边界：AI 只能在项目目录里读写。
 */
function safePath(rel) {
    var root = projectRoot();
    if (!root) throw new Error('项目未打开，拿不到 Editor.Project.path');
    var abs = path.resolve(root, rel || '.');
    var rootNorm = path.resolve(root);
    // Windows 大小写不敏感，统一转小写比较
    var a = process.platform === 'win32' ? abs.toLowerCase() : abs;
    var b = process.platform === 'win32' ? rootNorm.toLowerCase() : rootNorm;
    if (a !== b && a.indexOf(b + path.sep) !== 0) {
        throw new Error('路径越界：' + rel + ' 不在项目目录内');
    }
    return abs;
}

function relPath(abs) {
    var root = projectRoot();
    if (!root) return abs;
    return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * 找最新的编辑器日志。
 * 2.4 有两个目录：log/（单个会话的 editor-<ts>.txt）和 logs/（CocosCreator.log）。
 * 不同版本 / 不同安装哪边在写不固定，所以两个都扫，取 mtime 最新的那个。
 * v0.1 只扫了 log/，在 bottle_new 这台机器上读到的是 7 个月前的旧文件。
 */
function latestEditorLog() {
    var base = path.join(os.homedir(), '.CocosCreator');
    var dirs = [path.join(base, 'logs'), path.join(base, 'log')];

    var candidates = [];
    var skipped = [];
    var blocked = false;

    for (var d = 0; d < dirs.length; d++) {
        var files;
        try {
            files = fs.readdirSync(dirs[d]);
        } catch (e) {
            continue;
        }
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f.indexOf('.txt') < 0 && f.indexOf('.log') < 0) continue;
            var full = path.join(dirs[d], f);
            var isMainLog = /^CocosCreator.*\.log$/i.test(f);

            var st = statSafe(full);
            if (!st) {
                // 被别的进程独占时，连 stat 都会 EPERM
                if (isMainLog) blocked = true;
                skipped.push(f + '（无法 stat，可能被另一个编辑器独占）');
                continue;
            }
            if (!st.isFile()) continue;

            // 开一下才知道真能不能读。多个编辑器同时开时，先启动的那个独占
            // CocosCreator.log，后启动的读不了。
            var fd = -1;
            try {
                fd = fs.openSync(full, 'r');
            } catch (e) {
                if (isMainLog) blocked = true;
                skipped.push(f + '（' + (e.code || e.message) + '）');
                continue;
            } finally {
                if (fd >= 0) {
                    try { fs.closeSync(fd); } catch (e2) { /* 忽略 */ }
                }
            }

            candidates.push({ path: full, name: f, mtime: st.mtimeMs });
        }
    }

    if (!candidates.length) return { path: null, skipped: skipped, blocked: blocked };

    // 同目录还有 native.log / update.log 之类，经常比 CocosCreator.log 新，
    // 只按 mtime 会选错。先按文件名认主，认不到再退回按时间取最新。
    var main = candidates.filter(function (c) { return /^CocosCreator.*\.log$/i.test(c.name); });
    var pool = main.length ? main : candidates;

    var best = pool[0];
    for (var k = 1; k < pool.length; k++) {
        if (pool[k].mtime > best.mtime) best = pool[k];
    }
    return { path: best.path, skipped: skipped, blocked: blocked };
}


//#endregion



//#region 端口注册表

function registryDir() {
    return path.join(os.homedir(), '.CocosCreator', PKG_NAME, 'ports');
}

/**
 * 注册表文件名带项目路径的哈希。
 * 原来只用目录名 —— 不同目录下同名项目会互相覆盖，端口直接串掉。
 */
function registryFile() {
    var root = projectRoot();
    if (!root) return null;
    var name = path.basename(root).replace(/[^\w\-.]/g, '_');
    var tag = crypto.createHash('md5').update(String(root).toLowerCase()).digest('hex').slice(0, 8);
    return path.join(registryDir(), name + '-' + tag + '.json');
}

/** 进程还活着吗。编辑器崩了会留下僵尸注册项。 */
function isPidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM = 存在但没权限，也算活着
        return e.code === 'EPERM';
    }
}

/**
 * 删掉已经退出的编辑器留下的僵尸注册项，
 * 以及同一项目的旧格式残留（改过文件命名规则后留下的）。
 */
function cleanDeadRegistry() {
    var dir = registryDir();
    var files;
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        return;
    }

    // 先按项目路径归拢，同一项目保留 startedAt 最新的
    var byProject = {};
    var entries = [];
    for (var i = 0; i < files.length; i++) {
        if (files[i].slice(-5) !== '.json') continue;
        var full = path.join(dir, files[i]);
        try {
            var o = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (!o || !o.name) continue;
            entries.push({ file: full, o: o });
            var prev = byProject[o.project];
            if (!prev || (o.startedAt || '') > (prev.o.startedAt || '')) {
                byProject[o.project] = { file: full, o: o };
            }
        } catch (e) { /* 坏文件跳过 */ }
    }

    for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        var keep = byProject[e.o.project];
        var isZombie = e.o.pid && !isPidAlive(e.o.pid);
        // 僵尸删掉；同项目的非最新那份也删掉
        if (isZombie || (keep && keep.file !== e.file)) {
            try { fs.unlinkSync(e.file); } catch (e2) { /* 忽略 */ }
        }
    }
}

function writeRegistry(port) {
    var file = registryFile();
    if (!file) return null;
    // 跑测试时不写注册表：测试进程和真编辑器同项目名会互相覆盖
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') return null;
    try {
        fs.mkdirSync(registryDir(), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            name: path.basename(projectRoot()),
            project: projectRoot(),
            port: port,
            pid: process.pid,
            startedAt: new Date().toISOString()
        }, null, 2), 'utf8');
        cleanDeadRegistry();
        return file;
    } catch (e) {
        if (typeof Editor !== 'undefined' && Editor.warn) {
            Editor.warn(LOG, '端口注册表写入失败：' + e.message);
        }
        return null;
    }
}

function clearRegistry() {
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') return;
    var file = registryFile();
    if (!file) return;
    try {
        fs.unlinkSync(file);
    } catch (e) { /* 本来就没有 */ }
}

//#endregion

//#region 目标项目（多开时的路由）

/**
 * 多开编辑器时，AI 到底该操作哪个项目？
 *
 * 现状：mcp.json 里只能写一个 URL，客户端就固定连那一个端口。
 * 而每个编辑器各跑一个扩展实例、各占一个端口（25900、25901…），
 * 于是"AI 连的是谁"和"用户想操作谁"经常不是同一个。
 *
 * 解法：一个全局的 target.json 记录目标项目。
 * 每个实例收到 MCP 请求时先看目标：
 *   - 目标是别人 → 把请求转发过去，用对方的响应回给客户端
 *   - 目标是自己 / 没设目标 → 本地处理
 *
 * 于是客户端连哪个端口都无所谓，AI 永远操作 target 指定的项目。
 * 目标切换用 set_target_project 工具完成（它**永远本地处理**，否则会死锁）。
 */

function targetFile() {
    // 测试模式下用临时目录，别污染真实的目标文件
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') {
        return path.join(os.tmpdir(), 'cocos-mcp-2x-test-target.json');
    }
    return path.join(os.homedir(), '.CocosCreator', PKG_NAME, 'target.json');
}

/**
 * 读目标记录。
 *
 * 目标存的是**项目身份**（name + project 路径），不是端口。
 * 端口是按启动顺序分配的，编辑器一重启就会互换 —— 存端口等于存了个
 * 会漂移的引用，重启后目标就指错项目了。
 * 端口在运行时从注册表解析（见 resolveTarget）。
 *
 * 兼容：v0.3.x 早期版本写的是 {name, project, port}。这里读到旧格式时
 * 顺手迁移掉那个 port 字段，避免升级后目标直接失效。
 */
function readTarget() {
    var t = null;
    try {
        t = JSON.parse(fs.readFileSync(targetFile(), 'utf8'));
    } catch (e) {
        return null;
    }
    if (!t || !(t.name || t.project)) return null;

    // 旧格式带 port：端口会漂移，迁移掉
    if (t.port !== undefined) {
        delete t.port;
        try {
            writeTarget(t);
        } catch (e) { /* 迁移失败不影响本次使用 */ }
    }
    return t;
}

function writeTarget(t) {
    var file = targetFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(t, null, 2), 'utf8');
        return file;
    } catch (e) {
        throw new Error('写目标文件失败：' + e.message);
    }
}

/** 路径归一：统一分隔符、去掉尾斜杠，用于比较是不是同一个项目 */
function sameProjectPath(a, b) {
    if (!a || !b) return false;
    var norm = function (p) {
        return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    };
    return norm(a) === norm(b);
}

/**
 * 把目标记录解析成"当前实际在哪个端口"。
 *
 * 先按项目路径找注册表里对应的条目（路径是唯一可靠的身份），
 * 找不到再按项目名兜底。返回的 port 是**实时**的，
 * 附带 online 表示那个端口现在是不是真的活着。
 */
function resolveTarget() {
    var t = readTarget();
    if (!t) return null;

    var all = readRegistryAll();
    var names = Object.keys(all);
    var entry = null;

    // 优先按项目路径匹配 —— 同名项目在不同盘符下是常见情况
    for (var i = 0; i < names.length; i++) {
        if (t.project && sameProjectPath(all[names[i]].project, t.project)) {
            entry = all[names[i]];
            break;
        }
    }
    // 再按项目名兜底
    if (!entry && t.name) {
        for (var j = 0; j < names.length; j++) {
            if (all[names[j]].name === t.name) { entry = all[names[j]]; break; }
        }
    }

    if (!entry) {
        // 目标项目没在运行（编辑器关了）
        return {
            name: t.name || null,
            project: t.project || null,
            port: null,
            online: false,
            reason: '目标项目当前没有打开'
        };
    }

    return {
        name: entry.name,
        project: entry.project,
        port: entry.port,
        pid: entry.pid || null,
        online: true,
        stale: false
    };
}

/** 读整个端口注册表：{ 键: {name, project, port, pid, ...} } */
function readRegistryAll() {
    // 测试模式用假的注册表，不依赖本机实际开着的编辑器
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') {
        // 测试可以临时覆盖注册表，用来模拟"端口互换"这类场景
        if (global.__MCP_TEST_REGISTRY__) return global.__MCP_TEST_REGISTRY__;
        return {
            mock_alpha: { name: 'mock_alpha', project: 'G:/mock/alpha', port: 25990, pid: 1 },
            mock_beta: { name: 'mock_beta', project: 'G:/mock/beta', port: 25991, pid: 2 }
        };
    }

    var dir = registryDir();
    var out = {};
    var files;
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        return out;
    }
    for (var i = 0; i < files.length; i++) {
        if (files[i].slice(-5) !== '.json') continue;
        try {
            var full = path.join(dir, files[i]);
            var o = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (!o || !o.name || !o.port) continue;

            // 进程已经退出了，注册项是僵尸，不算数
            if (o.pid && !isPidAlive(o.pid)) {
                try { fs.unlinkSync(full); } catch (e2) { /* 忽略 */ }
                continue;
            }

            o.file = full;
            // 键用项目名；同名项目（不同盘符）用哈希后缀区分，别互相覆盖
            var key = o.name;
            if (out[key]) {
                key = o.name + '-' + crypto.createHash('md5')
                    .update(String(o.project).toLowerCase()).digest('hex').slice(0, 8);
            }
            out[key] = o;
        } catch (e) { /* 坏文件跳过 */ }
    }
    return out;
}

// 转发失败时记一笔，让工具结果里能说明"目标没连上，已退回本地处理"
var lastForwardError = null;

function probePort(port, timeoutMs) {
    return new Promise(function (resolve) {
        var net = require('net');
        var settled = false;
        var sock = net.connect({ host: '127.0.0.1', port: port });
        sock.setTimeout(timeoutMs || 800);
        sock.on('connect', function () {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(true);
        });
        sock.on('error', function () {
            if (settled) return;
            settled = true;
            resolve(false);
        });
        sock.on('timeout', function () {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(false);
        });
    });
}

/** 把一次 MCP 调用转发到另一个端口 */
function forwardToPort(port, msg) {
    return new Promise(function (resolve, reject) {
        var body = JSON.stringify(msg);
        var req = http.request({
            host: '127.0.0.1',
            port: port,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(body)
            }
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('目标项目返回了非 JSON 响应'));
                }
            });
        });
        req.on('error', function (e) {
            reject(new Error('目标项目没响应：' + (e.code || e.message)));
        });
        req.setTimeout(180000, function () {
            req.destroy(new Error('转发超时'));
        });
        req.end(body);
    });
}

/**
 * 会改磁盘的写类工具。
 *
 * 目标项目离线时**绝不能**退回本地执行：AI 以为在改目标项目，
 * 实际把文件写进了另一个项目 —— v0.3.1 修过端口漂移，但这个兜底本身还是危险的。
 * 读类工具退回本地是安全的（只是读到别的项目），写类不是。
 */
var WRITE_TOOLS = {
    write_file: 1, edit_file: 1,
    scene_add_node: 1, scene_set_props: 1, scene_remove_node: 1,
    scene_add_component: 1, scene_remove_component: 1, scene_set_component_props: 1,
    scene_move_node: 1, scene_create: 1,
    prefab_instantiate: 1, prefab_create_from_node: 1, prefab_create: 1,
    asset_move: 1, asset_delete: 1, asset_meta_set: 1,
    project_settings_set: 1, build_project: 1, runtime_inject: 1,
    execute_script: 1, execute_script_file: 1
};

/**
 * 目标项目不可达时的写操作拦截。返回 null 表示"不用拦"（读类工具，或不是工具调用）。
 */
function blockedWriteReply(msg, t, why) {
    if (!msg || msg.method !== 'tools/call' || !msg.params) return null;
    var name = msg.params.name;
    if (!WRITE_TOOLS[name]) return null;

    var targetName = (t && t.name) ? t.name : '（未命名的目标）';
    var localName = path.basename(projectRoot() || '') || '当前项目';
    var text = '错误：写操作被拒绝。\n' +
        '目标项目「' + targetName + '」当前不可达（' + (why || (t && t.reason) || '没有打开') + '），' +
        '而这条请求落到了「' + localName + '」这个编辑器实例上。\n' +
        '照旧在本地执行的话，你会在**错误的项目**里写文件（读类工具没这个限制，可以继续用）。\n' +
        '下一步：① list_open_projects 看哪些项目真的开着；' +
        '② set_target_project 切到确实要改的那个；' +
        '③ 或者先把目标项目的编辑器打开再重试。';

    return rpcResult(msg.id, {
        content: [{ type: 'text', text: text }],
        isError: true
    });
}

/**
 * 请求进来先判断要不要转发。
 * 返回 null 表示本地处理；返回 JSON-RPC 响应对象表示已由目标项目处理。
 */
function maybeForward(msg) {
    lastForwardError = null;

    // 测试模式不转发：测试环境没有真的编辑器，转发只会制造噪音
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') return null;

    // 热重载这类"要作用在本地实例上"的请求绝不能转发。
    // 否则 A 上发的重载指令会跑去 B，把 B 重载了 —— A 还在跑旧代码。
    if (msg && msg.method === 'tools/call' && msg.params) {
        var tname = msg.params.name;
        if (tname === 'execute_script' && msg.params.arguments) {
            var code = String(msg.params.arguments.code || '');
            if (code.indexOf('热重载完成') >= 0 || code.indexOf('fresh.load()') >= 0) {
                return null;
            }
        }
    }

    // 目标按项目身份记录，端口实时解析 —— 编辑器重启换了端口也能跟上
    var t = resolveTarget();
    if (!t || !t.port) {
        if (t && !t.online) {
            lastForwardError = t.reason || '目标项目当前没有打开';
            // 目标离线 + 写类工具 = 拒绝，不能"安全退回本地"
            var blockedOffline = blockedWriteReply(msg, t, lastForwardError);
            if (blockedOffline) return blockedOffline;
        }
        return null;
    }
    // 目标就是自己 —— 按项目身份判，不按端口
    if (sameProjectPath(t.project, projectRoot())) return null;

    // 切换目标的工具必须本地处理：否则 AI 在 A 上想切到 B，
    // 请求被转发到 B，B 又想把目标改成 A —— 死循环。
    var name = msg && msg.method === 'tools/call' && msg.params ? msg.params.name : null;
    if (name === 'set_target_project' || name === 'list_open_projects') return null;

    return forwardToPort(t.port, msg).then(function (reply) {
        return reply;
    }, function (err) {
        // 目标不在线（编辑器关了）——读类工具退回本地处理，但要在结果里说明；
        // 写类工具直接拒绝，免得"以为在改 A，其实改了 B"
        lastForwardError = err.message;
        var blocked = blockedWriteReply(msg, t, err.message);
        if (blocked) return blocked;
        return handleRpc(msg);
    });
}

function toolSetTargetProject(args) {
    var all = readRegistryAll();
    var names = Object.keys(all);

    var entry = null;
    if (args.name) {
        // 按 name 字段找，不直接用键 —— 同名项目的键带哈希后缀
        for (var i = 0; i < names.length; i++) {
            if (all[names[i]].name === args.name) { entry = all[names[i]]; break; }
        }
        if (!entry) {
            throw new Error('没找到叫 "' + args.name + '" 的项目。当前打开的：' +
                (names.length ? names.join(', ') : '（无）'));
        }
    } else if (args.port) {
        var port = parseInt(args.port, 10);
        for (var j = 0; j < names.length; j++) {
            if (all[names[j]].port === port) { entry = all[names[j]]; break; }
        }
        if (!entry) {
            throw new Error('没有项目跑在端口 ' + port + '。当前打开的：' +
                (names.length ? names.join(', ') : '（无）'));
        }
    } else {
        throw new Error('缺少 name（项目名）或 port（端口）');
    }

    // 目标只记项目身份，端口不固化 —— 端口会随编辑器重启而变
    var target = {
        name: entry.name,
        project: entry.project,
        updatedAt: new Date().toISOString()
    };
    writeTarget(target);

    return {
        target: target.name,
        project: target.project,
        port: entry.port,
        url: 'http://127.0.0.1:' + entry.port + '/mcp',
        switched: entry.port !== listeningPort,
        note: entry.port === listeningPort
            ? '目标就是当前这个项目，行为不变'
            : '已切换。之后所有 MCP 调用都会转发到 ' + target.name +
              '（当前端口 ' + entry.port + '，编辑器重启换端口也会自动跟上）'
    };
}

//#endregion

//#region 工具声明

/**
 * 工具声明表在 lib/tool-schema.js —— 纯数据，单独一个文件方便维护。
 * 加新工具：改 lib/tool-schema.js 的 TOOLS 数组 + main.js 的 callTool()。
 */
var toolSchema = require('./lib/tool-schema.js');
var TOOLS = toolSchema.TOOLS;
var TOOL_CONTRACT = toolSchema.TOOL_CONTRACT;
var TOOL_FOOTER = toolSchema.TOOL_FOOTER;

//#region 场景脚本通道

/**
 * 场景回传端点的收包统计。
 * total=0 说明场景进程根本没发出来（渲染进程里 require('http') 不可用）；
 * total>0 但 unknown>0 说明发出去了但 id 没对上。
 */
var sceneCallbackHits = { total: 0, unknown: 0, lastId: null, lastAt: null };


/**
 * 场景脚本通道：主进程 → 场景窗口（渲染进程）。
 *
 * 两个坑，都是实测出来的：
 *
 * 1. 不能用 Editor.Scene.callSceneScript —— 它在 2.4.15 上是坏的。
 *    实现是 `Editor.Ipc.sendToPanel.apply(Editor.sendToPanel, arguments)`，
 *    而 Editor.sendToPanel 在主进程里是 undefined，.apply(undefined) 直接抛 TypeError。
 *    所以绕开它，直接调 Editor.Ipc.sendToPanel。
 *
 * 2. 场景脚本**只收不回**。实测同一个面板：发一个不存在的消息会立刻回
 *    "message not found"；而注册过的消息（我们的、node-binder 的都一样）
 *    只执行、永远不回 reply。所以不能靠 callback 拿返回值。
 *
 * 回传改走文件信箱：主进程生成 id + 结果文件路径塞进 payload，
 * 场景脚本执行完把 {ok, data|error} 写进那个文件，主进程轮询取回。
 * 顺带用"未知消息会立刻报错"做快速失败，脚本没加载时不用干等超时。
 */
var BRIDGE_DIR = 'mcp-bridge';

/**
 * 等待回传的场景调用，key = 请求 id。
 *
 * 双通道设计：
 *   主通道 Editor.Ipc.sendToMain('cocos-mcp-2x:scene-result') —— 由下面
 *          module.exports.messages 里的 'scene-result' 接住，不依赖文件系统
 *   兜底   文件信箱 <项目>/temp/mcp-bridge/res-<id>.json —— 主通道不通时轮询
 * 哪条先到用哪条，另一条自动清理。
 */
var pendingSceneCalls = {};

/**
 * 场景进程的回传监听器。
 *
 * 本来只靠 module.exports.messages['scene-result'] 接，但实测场景面板发来的
 * sendToMain 不一定路由到包 messages（发送方是 builtin 的 scene 包）。
 * IpcListener 是主进程侧的全局监听，收得到就直接用它，两条路同时挂着不冲突。
 */
var sceneIpcListener = null;

function ensureSceneListener() {
    if (sceneIpcListener) return;
    if (typeof Editor === 'undefined' || typeof Editor.IpcListener !== 'function') return;

    try {
        sceneIpcListener = new Editor.IpcListener();
        sceneIpcListener.on('cocos-mcp-2x:scene-result', function (event, envelope) {
            if (!envelope || !envelope.__id) return;
            var settle = pendingSceneCalls[envelope.__id];
            if (settle) settle(envelope);
        });
    } catch (e) {
        sceneIpcListener = null;
    }
}

function ensureBridgeDir() {
    var root = projectRoot();
    if (!root) throw new Error('项目未打开');
    var dir = path.join(root, 'temp', BRIDGE_DIR);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        // 已存在或并发创建，都不影响后续读写
    }
    return dir;
}

function callSceneScript(method, payload, timeoutMs) {
    var wait = timeoutMs || 12000;
    var lastSceneIpcError = null;

    return new Promise(function (resolve, reject) {
        var registered = (Editor.sceneScripts || {})[PKG_NAME];
        if (!registered) {
            var others = Object.keys(Editor.sceneScripts || {});
            reject(new Error(
                '场景脚本未注册。package.json 要声明 "scene-script"，' +
                '并且必须重启编辑器才会被场景窗口加载。' +
                '当前已注册场景脚本的包：' + (others.length ? others.join(', ') : '（无）')
            ));
            return;
        }

        var dir = ensureBridgeDir();
        var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var resFile = path.join(dir, 'res-' + id + '.json');

        var body = {};
        if (payload) {
            for (var k in payload) {
                if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
            }
        }
        body.__id = id;
        body.__res = resFile;
        body.__port = listeningPort || 0;
        // fire-fs 这种跨平台 shim 可能不认 Windows 反斜杠，再给一份正斜杠的
        body.__resPosix = resFile.replace(/\\/g, '/');

        var done = false;
        var timer = null;
        var poll = null;

        function finish(err, data) {
            if (done) return;
            done = true;
            delete pendingSceneCalls[id];
            if (timer) clearTimeout(timer);
            if (poll) clearInterval(poll);
            // 正常结束才清掉结果文件；超时时保留，用来诊断场景进程到底写没写
            if (!err) {
                try { fs.unlinkSync(resFile); } catch (e) { /* 没生成过就算了 */ }
            }
            if (err) reject(err); else resolve(data);
        }

        // 先挂等待者再投递，避免脚本回得太快错过
        pendingSceneCalls[id] = function (env) {
            if (env.ok) finish(null, env.data);
            else finish(new Error(env.error || '场景脚本执行失败（无错误信息）'));
        };

        timer = setTimeout(function () {
            // 超时了也把结果文件的内容捞出来——如果场景进程写成功了，这里就能看到
            var extra = '';
            try {
                if (statSafe(resFile)) {
                    var txt = fs.readFileSync(resFile, 'utf8');
                    if (txt) extra = '；场景进程已写出结果文件：' + txt.slice(0, 300);
                }
            } catch (e) { /* 读不到就算了 */ }

            finish(new Error(
                '场景脚本 ' + method + ' 超时 ' + wait + 'ms：消息已投递，但回传没到主进程。' +
                (extra || '（场景进程也没写出结果文件，说明它的文件写入同样不可用）') +
                (lastSceneIpcError ? '；IPC 回调报了：' + lastSceneIpcError : '') +
                '去编辑器控制台看 [cocos-mcp-2x] 前缀的报错。'
            ));
        }, wait);

        poll = setInterval(function () {
            if (done) return;
            if (!statSafe(resFile)) return;

            var txt;
            try {
                txt = fs.readFileSync(resFile, 'utf8');
            } catch (e) {
                return; // 还在写，下一轮再读
            }
            if (!txt) return;

            var env;
            try {
                env = JSON.parse(txt);
            } catch (e) {
                return; // 读到半截 JSON，下一轮
            }

            if (env.ok) finish(null, env.data);
            else finish(new Error(env.error || '场景脚本执行失败（无错误信息）'));
        }, 50);

        try {
            Editor.Ipc.sendToPanel('scene', PKG_NAME + ':' + method, body, function (err, data) {
                // 这个回调有三种情况：
                //   1. err = "message not found" —— 方法没注册
                //   2. err 非空但不是 not found —— 其他 IPC 错误
                //   3. 无 err —— 场景脚本用 evt.reply(envelope) 回传了结果
                // 之前只处理了 1、2，把 3 直接丢了，所以"回传成功"却拿不到数据。
                if (err) {
                    var msg = String(err.message || err);
                    if (msg.indexOf('message not found') >= 0) {
                        finish(new Error(
                            '场景窗口里没有 ' + method + ' 这个处理器：脚本没加载，或方法名对不上。'
                        ));
                    } else {
                        // 不是"没注册"，先不当失败 —— 文件信箱可能已经把结果送到了，
                        // 等超时时会带着文件内容再报一次
                        lastSceneIpcError = msg;
                    }
                    return;
                }

                // 成功回传
                if (data === undefined || data === null) return;
                var env = data;
                if (typeof env === 'string') {
                    try { env = JSON.parse(env); } catch (e) { env = { ok: true, data: data }; }
                }
                if (env && typeof env === 'object') {
                    if (env.ok === false) {
                        finish(new Error(env.error || '场景脚本执行失败（无错误信息）'));
                    } else {
                        finish(null, env.data !== undefined ? env.data : env);
                    }
                } else {
                    finish(null, env);
                }
            });
        } catch (e) {
            finish(e);
        }
    });
}

/**
 * 存盘。scene:save-scene 同样拿不到回执，所以改成可观测的判定：
 * 记下当前场景 .fire 的 mtime，发消息后轮询它有没有变。
 *
 * 返回 true = 确认写盘；false = 超时没变化；null = 拿不到场景文件路径，无法判定。
 */
function findSceneFiles() {
    var root = projectRoot();
    if (!root) return [];
    var out = [];
    walkFiles(path.join(root, 'assets'), { maxDepth: 40, skip: SKIP_DIRS }, function (full, name) {
        if (name.slice(-5).toLowerCase() === '.fire') out.push(full);
    });
    return out;
}

function currentSceneFile() {
    try {
        var uuid = Editor.currentSceneUuid;
        if (uuid) {
            var idx = buildUuidIndex();
            var rel = idx.byFull[uuid];
            if (rel) return path.join(projectRoot(), rel);
        }
    } catch (e) {
        // 落到下面的兜底
    }

    // 兜底：编辑器没开场景（或没有 currentSceneUuid）时，
    // 如果项目里只有一个 .fire，那就没有歧义，用它。
    // 有多个就返回 null，让调用方显式传 path——猜错场景文件去写入比报错危险得多。
    try {
        var scenes = findSceneFiles();
        if (scenes.length === 1) return scenes[0];
    } catch (e2) {
        // 忽略
    }
    return null;
}

function saveScene(timeoutMs) {
    var file = currentSceneFile();
    var before = file ? (statSafe(file) || {}).mtimeMs : 0;

    return new Promise(function (resolve) {
        try {
            Editor.Ipc.sendToPanel('scene', 'scene:save-scene');
        } catch (e) {
            resolve(false);
            return;
        }

        if (!file) {
            resolve(null);
            return;
        }

        var wait = timeoutMs || 6000;
        var start = Date.now();
        var poll = setInterval(function () {
            var st = statSafe(file);
            if (st && st.mtimeMs !== before) {
                clearInterval(poll);
                resolve(true);
                return;
            }
            if (Date.now() - start > wait) {
                clearInterval(poll);
                resolve(false);
            }
        }, 120);
    });
}

function sceneScriptState() {
    var ss = Editor.sceneScripts || {};
    return {
        registered: !!ss[PKG_NAME],
        entry: ss[PKG_NAME] || null,
        all: Object.keys(ss)
    };
}

//#endregion

//#region 运行时（走场景进程）

/**
 * 在场景进程里执行一段代码（多语句），读回返回值。
 *
 * runtime_eval 只能求值单个表达式；这个能跑多语句 —— 问 FairyGUI 运行时、
 * 遍历引擎对象、查资源表这类事都靠它。
 * 返回值必须可 JSON 序列化。
 */
function toolSceneEval(args) {
    if (!args.code) throw new Error('缺少 code');
    return callSceneScript('sceneEval', args, 20000).then(function (data) {
        return {
            ok: true,
            source: 'scene-process（编辑器内运行时）',
            value: data.value
        };
    }, function (err) {
        throw new Error('场景进程执行失败：' + err.message +
            '。如果是"没有 xxx 这个处理器"，说明 scene.js 改过还没重启编辑器 —— ' +
            '场景窗口只在启动时加载场景脚本，重启编辑器即可。');
    });
}

/**
 * 读运行时状态 —— 读的是编辑器里正在编辑的场景实例（cc.director.getScene()）。
 *
 * 这和 query_scene_tree 的区别：那个读 .fire 文件（静态设计态），
 * 这个读场景进程里的活对象（运行时值：脚本改过的 @property、当前动画帧、
 * 组件的实际字段）。
 *
 * 前提：场景进程通道可用。先跑 runtime_info 看通道通不通。
 */
function toolRuntimeRead(args) {
    // sceneMethod 允许指定场景脚本里的方法名（默认 runtimeRead）。
    // 测试用它验证"方法未注册时快速失败"，也是给高级用户的逃生口。
    var method = (args && args.sceneMethod) ? String(args.sceneMethod) : 'runtimeRead';
    return callSceneScript(method, args || {}, 15000).then(function (data) {
        return {
            ok: true,
            source: 'scene-process（编辑器内运行时）',
            data: data
        };
    }, function (err) {
        throw new Error(
            '读运行时状态失败：' + err.message +
            '。先跑 runtime_info 看通道通不通；如果报"没有处理器"，说明 scene.js 改过、' +
            '需要重启编辑器（场景窗口只在启动时加载脚本）'
        );
    });
}

/**
 * 在场景进程里求值一个表达式，读回结果。
 * 用于查任意运行时状态：{"expr":"cc.director.getScene().name"}
 */
function toolRuntimeEval(args) {
    if (!args.expr) throw new Error('缺少 expr');
    return callSceneScript('runtimeEval', args, 15000).then(function (data) {
        return {
            ok: true,
            source: 'scene-process（编辑器内运行时）',
            expr: data.expr,
            value: data.value
        };
    }, function (err) {
        throw new Error('求值失败：' + err.message +
            '。如果是"没有 xxx 这个处理器"，需要重启编辑器（场景窗口只在启动时加载场景脚本）。');
    });
}

/**
 * 读捕获到的运行时 console 输出。
 * 场景进程的 console.log 平时只进编辑器控制台，这里能拉出来。
 */
function toolRuntimeConsole(args) {
    return callSceneScript('runtimeConsole', args || {}, 12000).then(function (data) {
        return {
            ok: true,
            source: 'scene-process（编辑器内运行时）',
            captured: data.captured,
            installed: data.installed,
            entries: data.entries,
            latestAt: data.latestAt,
            note: data.installed
                ? '只包含场景进程加载本扩展之后打印的内容（更早的已经在控制台里了）'
                : '场景进程里劫持 console 失败，这个功能不可用'
        };
    }, function (err) {
        throw new Error('读运行时 console 失败：' + err.message +
            '。如果是"没有 xxx 这个处理器"，需要重启编辑器（场景窗口只在启动时加载场景脚本）。');
    });
}

/**
 * 浏览器侧运行时上报 —— 控制注入 / 撤销。
 *
 * 注入是静默的：只改构建产物的 index.html（加一段 script 引用），
 * 带哈希的资源文件一个字节都不动，游戏画面和逻辑完全不受影响。
 */
function toolRuntimeInject(args) {
    var action = String(args.action || 'status').toLowerCase();

    var buildRoot = null;
    if (args.buildRoot) {
        buildRoot = safePath(args.buildRoot);
    } else {
        // 默认找项目下的 build 目录
        var root = projectRoot();
        if (root) buildRoot = path.join(root, 'build');
    }
    if (!buildRoot || !statSafe(buildRoot)) {
        throw new Error('找不到构建目录。先跑 build_project 构建一次');
    }

    var injector = require('./injector.js');
    var dests = injector.findWebDests(buildRoot);
    if (!dests.length) {
        return {
            action: action,
            targets: 0,
            note: '构建目录里没有带 index.html 的 web 产物',
            buildRoot: relPath(buildRoot)
        };
    }

    if (action === 'status') {
        var st = dests.map(function (d) {
            return {
                dest: relPath(d),
                injected: injector.isInjected(d),
                hasBackup: statSafe(path.join(d, 'index.html.mcp-bak')) ? true : false
            };
        });
        return { action: 'status', targets: st.length, items: st, buildRoot: relPath(buildRoot) };
    }

    // 上报端口：客户端连的是中继就报给中继，中继会转发给目标项目的扩展实例
    var reportPort = listeningPort;
    return probeHub(HUB_DEFAULT_PORT).then(function (r) {
        if (r.ok) reportPort = HUB_DEFAULT_PORT;
        return doInject(action, dests, injector, reportPort, args);
    }, function () {
        return doInject(action, dests, injector, reportPort, args);
    });
}

function doInject(action, dests, injector, reportPort, args) {
    var results = dests.map(function (d) {
        try {
            return injector.applyInjection(d, {
                selfDir: __dirname,
                port: reportPort,
                project: path.basename(projectRoot() || ''),
                interval: args.interval || 2000,
                remove: action === 'remove'
            });
        } catch (e) {
            return { injected: false, changed: false, dest: relPath(d), reason: e.message };
        }
    });

    var injected = 0;
    for (var i = 0; i < results.length; i++) {
        if (results[i].injected) injected++;
    }

    return {
        action: action,
        targets: results.length,
        injected: injected,
        reportPort: reportPort,
        results: results,
        note: action === 'remove'
            ? '已撤销注入，index.html 恢复原样'
            : '已静默注入。浏览器打开游戏后状态会自动上报到端口 ' + reportPort +
              '，用 runtime_browser_report 读。URL 加 ?mcp=off 可临时关闭。'
    };
}

/**
 * 读浏览器侧（web 构建）上报的运行时状态。
 */
function toolRuntimeBrowserReport(args) {
    var maxAge = (typeof args.maxAge === 'number') ? args.maxAge : 15000;

    var out = {
        source: 'browser（web 构建产物里的游戏）',
        count: browserReports.count,
        lastAt: browserReports.lastAt,
        ageMs: browserReports.lastAt ? (Date.now() - browserReports.lastAt) : null,
        report: browserReports.last
    };

    if (!browserReports.last) {
        out.note = '还没有收到浏览器上报。要先 build_project（会自动注入），' +
            '再用 preview_control start 起服务，浏览器打开游戏页面。';
        return out;
    }

    if (out.ageMs > maxAge) {
        out.stale = true;
        out.note = '最近一次上报是 ' + Math.round(out.ageMs / 1000) + ' 秒前，' +
            '游戏可能已经关了或页面没在跑。';
    }

    // 游戏里报的错（console.error / 未捕获异常）—— AI 最想看到这个
    var con = browserReports.last.console;
    if (con && con.entries && con.entries.length) {
        out.console = {
            installed: con.installed,
            total: con.entries.length,
            entries: con.entries
        };
        var errors = con.entries.filter(function (e) { return e.level === 'error'; });
        if (errors.length) {
            out.errors = errors;
            out.hasErrors = true;
            out.note = '游戏里有 ' + errors.length + ' 条 error 级输出，见 errors 字段';
        }
    }

    if (args.history) {
        out.history = browserReports.history.map(function (h) {
            return { at: h.at, scene: h.report && h.report.scene, frame: h.report && h.report.frame };
        });
    }

    return out;
}

/**
 * 读 Web 预览（引擎即时编译那个）里跑着的游戏的运行时状态和日志。
 *
 * 和 runtime_browser_report 的区别：
 *   - runtime_browser_report 读的是 **build 产物**里跑的（需要 build_project）
 *   - 这个读的是 **引擎自己的 Web 预览**（不需要 build，改完 .ts 重编译就生效）
 */
function toolPreviewReport(args) {
    var maxAge = (typeof args.maxAge === 'number') ? args.maxAge : 20000;
    var limit = (typeof args.limit === 'number') ? args.limit : 50;

    // B 类修复：桥接读 cc.Scene.active 会产生引擎错误日志，属于工具自身噪声，
    // 不能计入 errorTotal，否则「有 100 条错误」但真实错误为 0。
    var NOISE = /is not defined in the Scene|it is only defined in normal nodes/;
    function isNoise(e) {
        return NOISE.test(String((e && (e.text || e.message)) || e || ''));
    }
    var allErrors = bridgeState.errors || [];
    var realErrors = allErrors.filter(function (e) { return !isNoise(e); });
    var allLogs = bridgeState.logs || [];
    var cleanLogs = allLogs.filter(function (e) { return !isNoise(e); });

    var rep = bridgeState.lastReport;
    var out = {
        source: 'preview（引擎的 Web 预览，即时编译，不需要 build）',
        connected: bridgeState.connected,
        lastAt: bridgeState.lastAt,
        ageMs: bridgeState.lastAt ? (Date.now() - bridgeState.lastAt) : null,
        scene: rep ? rep.scene : null,
        frame: rep ? rep.frame : null,
        fps: rep ? rep.fps : null,
        url: rep ? rep.url : null,
        logTotal: bridgeState.logSeq,
        errorTotal: realErrors.length,
        noiseFiltered: (allErrors.length - realErrors.length) + (allLogs.length - cleanLogs.length)
    };

    if (!rep) {
        out.note = '预览页还没连上。先 preview_control start（会开内置 Chromium 窗口并注入 bridge）。' +
            '如果窗口开了还没数据，看 preview_control {action:"bridge"} 的 connected 字段。';
        return out;
    }

    if (out.ageMs > maxAge) {
        out.stale = true;
        out.note = '最近一次上报是 ' + Math.round(out.ageMs / 1000) + ' 秒前 —— 预览窗口可能关了。';
    }

    // 日志（按 seq 倒序，最新的在前），已剔除桥接自身噪声
    out.logs = cleanLogs.slice(-limit).reverse();

    if (realErrors.length) {
        out.errors = realErrors.slice(-20).reverse();
        out.hasErrors = true;
    }

    if (args.tree !== false && rep.tree) {
        out.tree = rep.tree;
    }

    return out;
}

/**
 * 向 Web 预览里的游戏下发指令，并等它执行完返回结果。
 *
 * action:
 *   ping       —— 确认通道通
 *   eval       —— 在预览页里求值表达式（expr）
 *   read       —— 读某个节点的组件属性（path）
 *   click      —— 触发节点上的事件处理方法（path，可选 method）
 *   dispatchTouch —— 真派发触摸事件到 canvas（path）
 *   screenshot —— 抓 canvas 像素，返回尺寸和平均色
 *
 * 指令是排队 + 轮询的：bridge.js 每 400ms 拉一次，
 * 所以这里最多等 timeout 毫秒。
 */
function toolPreviewCommand(args) {
    var action = String(args.action || '').toLowerCase();
    if (!action) throw new Error('缺少 action。可用：ping / eval / read / click / dispatchTouch / screenshot');

    var timeout = (typeof args.timeout === 'number') ? args.timeout : 12000;
    var cmd = bridgeQueueCommand({
        action: action,
        path: args.path,
        expr: args.expr,
        method: args.method,
        handler: args.handler,
        arg: args.arg,
        args: args.args,
        module: args.module,
        code: args.code,
        type: args.type,
        index: args.index,
        depth: args.depth,
        filter: args.filter
    });

    return new Promise(function (resolve) {
        var deadline = Date.now() + timeout;

        function check() {
            var r = bridgeTakeResult(cmd.id);
            if (r) {
                resolve({
                    ok: r.ok !== false,
                    action: action,
                    result: r.result,
                    error: r.ok === false ? r.error : null,
                    note: r.ok === false
                        ? ('指令执行失败：' + r.error)
                        : '指令已在预览页里执行完毕'
                });
                return;
            }
            if (Date.now() > deadline) {
                resolve({
                    ok: false,
                    action: action,
                    error: '等指令结果超时（' + timeout + 'ms）。' +
                        '预览页可能没连上 —— 先 preview_control {action:"bridge"} 看 connected。',
                    pendingCommands: bridgeState.commands.length,
                    connected: bridgeState.connected
                });
                return;
            }
            setTimeout(check, 120);
        }
        setTimeout(check, 120);
    });
}

/**
 * 场景进程的入口可用性检查 + 能力清单。
 */
function toolRuntimeInfo(args) {
    return callSceneScript('ping', {}, 8000).then(function (data) {
        return {
            ok: true,
            available: true,
            source: 'scene-process（编辑器内运行时）',
            capabilities: data,
            note: '运行时读的是编辑器里正在编辑的场景实例。' +
                '浏览器里那个 web 构建是另一个进程，那边靠 runtime_browser_report（静默注入上报）。'
        };
    }, function (err) {
        return {
            ok: false,
            available: false,
            error: err.message,
            note: '场景进程通道不通。可能是场景窗口没打开，或 scene.js 改过需要重启编辑器。'
        };
    });
}

//#endregion

//#region 资源层（走 Editor.assetdb）

/**
 * 资源操作全部走 Editor.assetdb，而不是直接动文件。
 * 原因：assetdb 会同步维护 uuid ↔ 路径映射、生成/更新 .meta、广播 assets-created 等事件，
 * 直接改文件再 refresh 虽然也能用，但 uuid 和 meta 得自己兜，容易不一致。
 */

/** 项目内路径 / 绝对路径 / db:// 统一转成 db://assets/... */
function toDbUrl(p) {
    var s = String(p === undefined || p === null ? '' : p).trim().replace(/\\/g, '/');
    if (!s) throw new Error('缺少路径');
    if (s.indexOf('db://') === 0) return s;

    var root = String(projectRoot() || '').replace(/\\/g, '/');
    if (root && s.indexOf(root + '/') === 0) s = s.slice(root.length + 1);
    if (s.indexOf('assets/') === 0) return 'db://' + s;

    throw new Error('路径不在 assets 目录下，转不成 db:// 形式：' + p);
}

function relFromAbs(abs) {
    if (!abs) return null;
    return path.relative(projectRoot(), abs).replace(/\\/g, '/');
}

function requireAssetdb() {
    if (typeof Editor === 'undefined' || !Editor.assetdb) {
        throw new Error('Editor.assetdb 不可用');
    }
    return Editor.assetdb;
}

function toolAssetQuery(args) {
    var db = requireAssetdb();
    var pattern = args.pattern ? toDbUrl(args.pattern) : 'db://assets/**';

    return new Promise(function (resolve, reject) {
        try {
            // 签名是 (pattern, typeFilter, callback)——第二个参数容易漏，
            // 漏了的话回调会被当成过滤条件，永远不触发
            db.queryAssets(pattern, null, function (err, infos) {
                if (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }

                var list = (infos || []).map(function (i) {
                    return {
                        uuid: i.uuid,
                        url: i.url,
                        path: relFromAbs(i.path),
                        type: i.type
                    };
                });

                if (args.type) {
                    list = list.filter(function (x) { return x.type === args.type; });
                }

                var total = list.length;
                var limit = typeof args.limit === 'number' ? args.limit : 200;
                var truncated = list.length > limit;
                if (truncated) list = list.slice(0, limit);

                resolve({
                    pattern: pattern,
                    total: total,
                    returned: list.length,
                    truncated: truncated,
                    assets: list
                });
            });
        } catch (e) {
            reject(e);
        }
    });
}

function toolAssetMove(args) {
    if (!args.from) throw new Error('缺少 from');
    if (!args.to) throw new Error('缺少 to');

    var db = requireAssetdb();
    var from = toDbUrl(args.from);
    var to = toDbUrl(args.to);

    return new Promise(function (resolve, reject) {
        try {
            db.move(from, to, function (err, results) {
                if (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
                resolve({ from: from, to: to, moved: Array.isArray(results) ? results.length : 1 });
            });
        } catch (e) {
            reject(e);
        }
    });
}

function toolAssetDelete(args) {
    if (!args.path) throw new Error('缺少 path');
    if (args.confirm !== true) {
        throw new Error('删除资源不可逆，确认要删就带 confirm: true 再调一次');
    }

    var db = requireAssetdb();
    var url = toDbUrl(args.path);

    return new Promise(function (resolve, reject) {
        try {
            db.delete(url, function (err, results) {
                if (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
                resolve({
                    deleted: url,
                    count: Array.isArray(results) ? results.length : 1,
                    backup: db.assetBackupPath || null,
                    hint: db.assetBackupPath ? '被删资源在备份目录里还能找回来' : null
                });
            });
        } catch (e) {
            reject(e);
        }
    });
}

/** db://assets/xxx → 磁盘绝对路径 */
function dbUrlToAbs(url) {
    var s = String(url || '');
    if (s.indexOf('db://') !== 0) return safePath(s);
    return path.join(projectRoot(), s.slice(5).replace(/\//g, path.sep));
}

/** 写 JSON 时保留原文件的换行风格和结尾换行，避免整个文件 diff 全变 */
function writeJsonPreserving(abs, obj) {
    var original = '';
    try { original = fs.readFileSync(abs, 'utf8'); } catch (e) { /* 新文件 */ }

    var text = JSON.stringify(obj, null, 2);
    var crlf = original.indexOf('\r\n') >= 0;
    if (crlf) text = text.replace(/\n/g, '\r\n');
    if (original.length && /\n$/.test(original)) text += crlf ? '\r\n' : '\n';

    fs.writeFileSync(abs, text, 'utf8');
}

function readMetaFile(url) {
    var abs = dbUrlToAbs(url) + '.meta';
    if (!statSafe(abs)) throw new Error('找不到 .meta 文件：' + relFromAbs(abs) + '。确认这个资源确实存在于 assets 下（.meta 是 Cocos 自动生成的）。');
    return { abs: abs, meta: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

function toolAssetMetaGet(args) {
    if (!args.path) throw new Error('缺少 path');

    var url = toDbUrl(args.path);
    var read = readMetaFile(url);

    var top = {};
    var subMetas = {};

    // 顶层：除 subMetas 外的原始值
    for (var k in read.meta) {
        if (!Object.prototype.hasOwnProperty.call(read.meta, k)) continue;
        if (k === 'subMetas') continue;
        var v = read.meta[k];
        var t = typeof v;
        if (v === null || t === 'string' || t === 'number' || t === 'boolean') top[k] = v;
    }

    // 子资源（比如 sprite-frame 的九宫格切边）
    var subs = read.meta.subMetas || {};
    for (var name in subs) {
        if (!Object.prototype.hasOwnProperty.call(subs, name)) continue;
        var s = subs[name];
        var flat = {};
        for (var sk in s) {
            if (!Object.prototype.hasOwnProperty.call(s, sk)) continue;
            if (sk === 'subMetas') continue;
            var sv = s[sk];
            var st = typeof sv;
            if (sv === null || st === 'string' || st === 'number' || st === 'boolean') flat[sk] = sv;
        }
        subMetas[name] = flat;
    }

    if (args.keys && args.keys.length) {
        var picked = {};
        for (var i = 0; i < args.keys.length; i++) {
            var kk = args.keys[i];
            if (top[kk] !== undefined) picked[kk] = top[kk];
        }
        top = picked;
    }

    return {
        url: url,
        uuid: read.meta.uuid || null,
        importer: read.meta.importer || null,
        meta: top,
        subMetas: subMetas
    };
}

/**
 * 刷新单个资源。和 toolRefreshAssets 一样用参数个数探测回调支持：
 * 老版本 / mock 里 refresh 可能只有一个参数，回调永远不来，不能把请求挂死。
 */
function refreshAssetUrl(url, timeoutMs) {
    // 导入完成 = assets 里可能多了/少了资源，uuid 索引必须重建，
    // 否则紧接着的 resolve_uuid / query_scene_tree 会看不到刚写的文件
    uuidlib.invalidateCache();
    return new Promise(function (resolve) {
        var called = false;
        function finish(err) {
            if (called) return;
            called = true;
            resolve(err || null);
        }
        try {
            if (Editor.assetdb.refresh.length >= 2) {
                Editor.assetdb.refresh(url, finish);
                setTimeout(function () { finish(null); }, timeoutMs || 5000);
            } else {
                Editor.assetdb.refresh(url);
                finish(null);
            }
        } catch (e) {
            // assetdb 内部对非法 url（比如写到 assets 之外的路径）会抛裸 TypeError，
            // 那个报错完全看不出是"路径不在 assets 下"造成的。翻译成人话。
            var msg = String(e && e.message ? e.message : e);
            finish(new Error(
                '资源已写入，但让编辑器重新导入失败：' + msg +
                '。如果这个路径在 assets 目录之外（像 temp/），' +
                '编辑器本来就不会导入它 —— 文件本身已经写好了，可以直接用。'
            ));
        }
    });
}

/**
 * 写完文件后通知编辑器导入。
 *
 * 导入失败**不算整个操作失败** —— 文件已经写到磁盘了。
 * 把导入结果放进 out.imported / out.importNote，调用方自己决定要不要当失败。
 */
function afterWrite(url, out, okNote) {
    return refreshAssetUrl(url).then(function (err) {
        if (!err) {
            out.imported = true;
            out.note = okNote;
            return out;
        }
        out.imported = false;
        out.note = '文件已写盘，但编辑器没能重新导入它：' + String(err.message || err) +
            '。如果这个路径在 assets 之外，编辑器本来就不会导入 —— ' +
            '想让它出现在编辑器里，把文件放到 assets 下再 refresh_assets。';
        return out;
    });
}

function toolAssetMetaSet(args) {
    if (!args.path) throw new Error('缺少 path');
    if (!args.props && !args.subMetas) throw new Error('props 和 subMetas 至少给一个');

    var url = toDbUrl(args.path);
    var read = readMetaFile(url);
    var meta = read.meta;
    var applied = [];

    if (args.props) {
        for (var k in args.props) {
            if (!Object.prototype.hasOwnProperty.call(args.props, k)) continue;
            if (k.charAt(0) === '_') throw new Error('不允许改内部字段：' + k);
            if (k === 'uuid' || k === 'importer') throw new Error('不允许改 ' + k);
            meta[k] = args.props[k];
            applied.push(k);
        }
    }

    if (args.subMetas) {
        meta.subMetas = meta.subMetas || {};
        for (var name in args.subMetas) {
            if (!Object.prototype.hasOwnProperty.call(args.subMetas, name)) continue;
            var sub = meta.subMetas[name];
            if (!sub) {
                throw new Error('没有这个子资源：' + name +
                    '（现有：' + Object.keys(meta.subMetas).join(', ') + '）');
            }
            var props = args.subMetas[name] || {};
            for (var sk in props) {
                if (!Object.prototype.hasOwnProperty.call(props, sk)) continue;
                if (sk.charAt(0) === '_' || sk === 'uuid') throw new Error('不允许改子资源字段：' + sk);
                sub[sk] = props[sk];
                applied.push(name + '.' + sk);
            }
        }
    }

    if (!applied.length) return { changed: [], note: '没给要改的字段' };

    writeJsonPreserving(read.abs, meta);

    return afterWrite(url, {
        url: url,
        uuid: meta.uuid || null,
        changed: applied,
        saved: true
    }, 'meta 已写盘并重新导入');
}

//#endregion

//#region 场景文件与构建

/** uuid v4。不用 crypto.randomUUID，编辑器内置 Node 版本可能没有 */
function newUuidV4() {
    var b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
        h.slice(16, 20) + '-' + h.slice(20);
}

/**
 * 新建空场景（可从零搭建工程）。
 *
 * 有模板：克隆已有 .fire 的 [0] 与场景根，字段跟引擎写的一致。
 * 无模板：用 lib/scene-template.js 的内置引擎同款模板，直接产出
 *         SceneAsset + Scene + Canvas + Main Camera —— 不再要求先手工建场景。
 * 两条路径都会保证至少有 Canvas（withCanvas !== false 时），
 * 并自动写 start-scene，避免预览默认跑 "New Node" 空场景。
 */
function toolSceneCreate(args) {
    if (!args.path) throw new Error('缺少 path（新场景路径，如 assets/scene/New.fire）');
    var rel = String(args.path).replace(/\\/g, '/');
    if (rel.slice(-5).toLowerCase() !== '.fire') throw new Error('场景文件必须以 .fire 结尾');

    var abs = safePath(rel);
    if (statSafe(abs)) throw new Error('目标已存在：' + rel + '。换个路径，或者先删掉旧的（asset_delete）。');
    if (statSafe(abs + '.meta')) throw new Error('同名 .meta 已存在：' + rel + '.meta');

    var design = [
        (args.canvas && args.canvas[0]) || 960,
        (args.canvas && args.canvas[1]) || 640
    ];
    var withCanvas = args.withCanvas !== false;
    var arr;
    var tplUsed;

    var candidates = findSceneFiles().filter(function (p) {
        return path.resolve(p) !== path.resolve(abs);
    });

    if (!candidates.length) {
        arr = scenetpl.buildEmptyScene({ design: design, name: path.basename(rel, '.fire') });
        tplUsed = 'builtin://empty-scene';
    } else {
        var tpl = loadSerialized(candidates[0]);
        var tplRoot = findSceneRootId(tpl);
        if (tplRoot < 0) throw new Error('模板场景里没有 cc.Scene：' + relFromAbs(candidates[0]));

        var asset = JSON.parse(JSON.stringify(tpl[0]));
        var scene = JSON.parse(JSON.stringify(tpl[tplRoot]));
        scene._children = [];
        scene._components = [];
        scene._prefab = null;
        scene._parent = null;
        if (scene._id !== undefined) scene._id = newNodeId();
        asset._name = '';
        asset.scene = { __id__: 1 };
        arr = [asset, scene];
        tplUsed = relFromAbs(candidates[0]);
    }

    var canvasAdded = withCanvas ? scenetpl.attachCanvas(arr, { design: design }) : 0;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(arr, null, 2), 'utf8');

    var uuid = newUuidV4();
    var meta = {
        ver: '1.3.2',
        uuid: uuid,
        importer: 'scene',
        asyncLoadAssets: false,
        autoReleaseAssets: false,
        subMetas: {}
    };
    fs.writeFileSync(abs + '.meta', JSON.stringify(meta, null, 2), 'utf8');
    markDirty(rel);
    try { noteFileWrite(abs, { tool: 'scene_create' }); } catch (e) { /* 忽略 */ }

    var wroteStart = false;
    try {
        if (args.startScene !== false && typeof Editor !== 'undefined' && Editor.Profile) {
            var p = Editor.Profile.load('project://project.json');
            if (p) { p.set('start-scene', uuid); p.set('design-resolution-width', design[0]); p.set('design-resolution-height', design[1]); p.save(); wroteStart = true; }
        }
    } catch (e) { /* 项目设置不可用时不影响建场景 */ }

    var relOut = path.relative(projectRoot(), abs).replace(/\\/g, '/');
    var out = {
        created: relOut,
        uuid: uuid,
        template: tplUsed,
        objects: arr.length,
        canvasAdded: canvasAdded,
        startSceneSet: wroteStart,
        design: design
    };

    return afterWrite('db://' + relOut, out,
        '场景已创建并导入。空项目会用内置 Canvas/Camera 模板，并自动设为启动场景。'
    ).then(function (result) {
        // 编辑器导入可能重分配 .meta.uuid；以它为唯一口径同步返回值与 start-scene
        var real = null;
        try { real = JSON.parse(fs.readFileSync(abs + '.meta', 'utf8')).uuid; } catch (e) { }
        if (real && real !== uuid) {
            try {
                if (wroteStart && typeof Editor !== 'undefined' && Editor.Profile) {
                    var p2 = Editor.Profile.load('project://project.json');
                    if (p2) { p2.set('start-scene', real); p2.save(); }
                }
            } catch (e) { }
            result.uuid = real;
            result.uuidReconciled = { from: uuid, to: real };
        }
        return result;
    });
}

// ---- 构建 ----

var buildState = {
    state: 'idle',
    platform: null,
    buildPath: null,
    dest: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    lastError: null,
    output: null,
    fileCount: null,
    bytes: null,
    injected: 0,
    injectionResults: null,
    injectionError: null
};

function toolBuildTargets() {
    var b = Editor.Builder;
    if (!b || !b.simpleBuildTargets) throw new Error('Editor.Builder 不可用');

    var list = [];
    var t = b.simpleBuildTargets;
    for (var k in t) {
        if (!Object.prototype.hasOwnProperty.call(t, k)) continue;
        list.push({ platform: k, name: t[k].name || k, extends: t[k].extends || null });
    }
    list.sort(function (a, c) { return a.platform < c.platform ? -1 : 1; });

    return {
        count: list.length,
        targets: list,
        note: 'web-mobile / web-desktop / android / ios 这类平台不在这里，但可以作为 platform 直接传给 build_project'
    };
}

/**
 * 触发构建。
 *
 * options 不自己拼：Editor.Builder._getOptionsFromCommand 会从
 * project://builder.json 读项目已有的构建配置（buildPath、scenes、startScene 等），
 * 只把平台覆盖进去。这样拿到的是一份完整合法的配置。
 *
 * 构建可能跑几分钟，所以默认立刻返回，用 build_status 查进度。
 */
function toolBuildProject(args) {
    var b = Editor.Builder;
    if (!b || typeof b.build !== 'function') {
        throw new Error(
            '这个编辑器环境不支持构建（Editor.Builder.build 不可用）。' +
            '如果是在别的 Cocos 版本上，确认一下版本；' +
            '构建需要真正的编辑器进程，不是命令行工具。'
        );
    }
    if (buildState.state === 'running') {
        throw new Error('已经有一个构建在跑（平台 ' + buildState.platform + '），先用 build_status 看进度');
    }

    var platform = args.platform ? String(args.platform).trim() : null;

    // 平台名的合法性交给引擎判断 —— 不要自己维护一份列表：
    // simpleBuildTargets 里只有小游戏平台，web-mobile / web-desktop / android 这些
    // 都不在里面，但它们是合法的。自己硬编码列表会误拒合法平台。
    var opts;
    try {
        opts = b._getOptionsFromCommand(platform ? ('platform=' + platform) : '');
    } catch (e) {
        var known = null;
        try { known = toolBuildTargets(); } catch (e2) { /* 读不到就算了 */ }
        var names = known && known.targets
            ? known.targets.map(function (t) { return t.platform; })
            : [];
        throw new Error(
            '读取项目构建配置失败：' + (e.message || e) +
            '。如果平台名不对，先跑 build_targets 看可用平台' +
            (names.length ? '（' + names.slice(0, 12).join(', ') + (names.length > 12 ? ' ...' : '') + '）' : '') +
            '。注意 web-mobile / web-desktop / android / ios 这类平台不在 build_targets 里，' +
            '但可以直接传给 build_project。'
        );
    }
    // _getOptionsFromCommand 返回的是 { options: {...} } 包装
    if (opts && opts.options) opts = opts.options;
    if (!opts || !opts.platform) {
        throw new Error('项目里还没有构建配置，请显式传 platform（可用值见 build_targets）');
    }

    // build() 内部会 scenes.indexOf(startScene)，scenes 为空必然报"找不到启动场景"。
    // 配置里没给就用项目里全部 .fire 兜上（排除 excludeScenes）。
    if (!opts.scenes || !opts.scenes.length) {
        var idx = buildUuidIndex();
        var excluded = opts.excludeScenes || [];
        var all = [];
        for (var full in idx.byFull) {
            if (!Object.prototype.hasOwnProperty.call(idx.byFull, full)) continue;
            var relPath = idx.byFull[full];
            if (relPath.slice(-5).toLowerCase() !== '.fire') continue;
            if (excluded.indexOf(relPath) >= 0 || excluded.indexOf(full) >= 0) continue;
            all.push(full);
        }
        opts.scenes = all;
    }
    if (!opts.scenes.length) {
        throw new Error('项目里一个场景都没有，没法构建');
    }
    if (!opts.startScene || opts.scenes.indexOf(opts.startScene) < 0) {
        opts.startScene = opts.scenes[0];
    }
    if (args.scenes && args.scenes.length) {
        opts.scenes = args.scenes;
        if (opts.scenes.indexOf(opts.startScene) < 0) opts.startScene = opts.scenes[0];
    }
    if (args.startScene) opts.startScene = args.startScene;

    if (args.buildPath) opts.buildPath = safePath(args.buildPath);
    if (args.debug === true) opts.debug = true;
    if (args.md5Cache === true) opts.md5Cache = true;

    // buildPath 只是父目录，真正输出目录是 dest = buildPath / <平台输出名>。
    // 只改 buildPath 不改 dest，构建仍会写到旧位置（踩过）。
    var outDirName;
    try {
        outDirName = b._getOutputDir(opts.actualPlatform || opts.platform) || (opts.actualPlatform || opts.platform);
    } catch (e) {
        outDirName = opts.actualPlatform || opts.platform;
    }
    var destAbs = path.join(opts.buildPath, outDirName);
    opts.dest = destAbs;

    buildState = {
        state: 'running',
        platform: opts.platform,
        buildPath: opts.buildPath || null,
        dest: destAbs,
        startedAt: Date.now(),
        finishedAt: null,
        elapsedMs: null,
        lastError: null,
        output: null,
        fileCount: null,
        bytes: null
    };

    try {
        b.build(opts, function (err, result) {
            buildState.finishedAt = Date.now();
            buildState.elapsedMs = buildState.finishedAt - buildState.startedAt;
            if (err) {
                buildState.state = 'error';
                buildState.lastError = String(err.message || err);
                return;
            }

            // 回调说成功不算数，产物得真的在
            var check = describeDir(destAbs);
            buildState.fileCount = check.files;
            buildState.bytes = check.bytes;
            if (!check.exists || check.files === 0) {
                buildState.state = 'error';
                buildState.lastError = '构建回调返回成功，但输出目录里没有文件：' + destAbs;
                return;
            }
            buildState.state = 'done';
            buildState.output = destAbs;

            // 自动注入运行时上报（静默）。
            // 只对 web 产物（带 index.html 的）注入；小游戏/原生平台没这个概念。
            // 失败不影响构建结果 —— 上报是附加能力，不是构建的一部分。
            try {
                var injector = require('./injector.js');
                var webDests = injector.findWebDests(path.dirname(destAbs));
                if (webDests.length) {
                    // 上报端口：客户端连的是中继就报给中继
                    probeHub(HUB_DEFAULT_PORT).then(function (r) {
                        var rp = r.ok ? HUB_DEFAULT_PORT : listeningPort;
                        var res = [];
                        for (var w = 0; w < webDests.length; w++) {
                            res.push(injector.applyInjection(webDests[w], {
                                selfDir: __dirname,
                                port: rp,
                                project: path.basename(projectRoot() || ''),
                                interval: 2000
                            }));
                        }
                        buildState.injected = res.filter(function (x) { return x.injected; }).length;
                        buildState.injectionResults = res;
                    }, function () {
                        var res = [];
                        for (var w2 = 0; w2 < webDests.length; w2++) {
                            res.push(injector.applyInjection(webDests[w2], {
                                selfDir: __dirname,
                                port: listeningPort,
                                project: path.basename(projectRoot() || ''),
                                interval: 2000
                            }));
                        }
                        buildState.injected = res.filter(function (x) { return x.injected; }).length;
                        buildState.injectionResults = res;
                    });
                }
            } catch (injErr) {
                buildState.injected = 0;
                buildState.injectionError = String(injErr.message || injErr);
            }
        });
    } catch (e) {
        buildState.state = 'error';
        buildState.lastError = String(e.message || e);
        buildState.finishedAt = Date.now();
        throw e;
    }

    return {
        started: true,
        platform: opts.platform,
        dest: destAbs,
        note: '构建已开始，用 build_status 查结果（大项目可能要几分钟）'
    };
}

/** 统计目录下的文件数和总字节，用来验证构建真的产出了东西 */
function describeDir(abs) {
    var files = 0;
    var bytes = 0;
    if (!statSafe(abs)) return { exists: false, files: 0, bytes: 0 };

    var stack = [abs];
    while (stack.length) {
        var dir = stack.pop();
        var ents;
        try {
            ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            continue;
        }
        for (var i = 0; i < ents.length; i++) {
            var full = path.join(dir, ents[i].name);
            if (ents[i].isDirectory()) {
                stack.push(full);
                continue;
            }
            var st = statSafe(full);
            if (!st) continue;
            files++;
            bytes += st.size;
        }
    }
    return { exists: true, files: files, bytes: bytes };
}

function toolBuildStatus() {
    var out = {};
    for (var k in buildState) {
        if (Object.prototype.hasOwnProperty.call(buildState, k)) out[k] = buildState[k];
    }
    if (buildState.state === 'running' && buildState.startedAt) {
        out.runningMs = Date.now() - buildState.startedAt;
    }
    return out;
}

//#endregion

//#region 预制体导出

/**
 * 把场景里的一个节点子树导出成 .prefab。
 *
 * 结构参考引擎自己产出的预制体（已逆向确认）：
 *   [0] cc.Prefab { data: {__id__: 根节点下标}, optimizationPolicy: 0, ... }
 *   节点们（_id 一律空串，_prefab 指向各自的 PrefabInfo）
 *   组件们
 *   每个节点一个 cc.PrefabInfo { root: 根下标, asset: 预制体 uuid, fileId: 22位唯一id, sync: false }
 *
 * 根节点的 fileId 是空串，子节点各自一个唯一 id —— 这是引擎的约定，
 * 预制体更新时靠它把改动对回对应节点。
 */
/**
 * 批量改一份 .fire / .prefab：**一次解析、多次应用、一次提交**。
 *
 * 为什么需要它：v0.4.x 之前改 20 个节点 = 20 次调用 = 20 次整文件读写 + 20 次落盘。
 * 慢是次要的，要命的是中途失败会留半成品（前 12 个改了、后 8 个没改），
 * 而且每次都重新解析、重新定位根节点。
 *
 * 这个工具把"改"和"写"分开：
 *   - 所有 op 在内存里依次应用（任何一步失败 → 整批放弃，文件一个字节没动）
 *   - dryRun: true 只回报"会变成什么样" + 结构校验结果，不写盘
 *   - 通过则一次性写盘 + 导入
 */
function toolSceneApply(args) {
    args = args || {};
    var ops = args.ops;
    if (!Array.isArray(ops) || !ops.length) {
        throw new Error('缺少 ops（操作数组）。例子：' +
            '{"path":"assets/ui/Foo.prefab","ops":[{"op":"setProps","node":"panel/title","position":{"x":0,"y":500}}]}');
    }

    var ctx = openDocForEdit({ path: args.path });
    var originalText = fs.readFileSync(ctx.abs, 'utf8');

    // 应用阶段：全部在内存里，不写盘
    var applied = applyOps(ctx, ops);
    var dryRun = args.dryRun === true || args.dry_run === true;

    var summary = applied.results.map(function (r) {
        return describeOpResult(r.op, r.result);
    });

    if (dryRun) {
        return {
            dryRun: true,
            path: relPath(ctx.abs),
            kind: ctx.kind,
            opCount: ops.length,
            before: applied.before,
            after: applied.after,
            problems: applied.problems,
            wouldWrite: applied.problems.length === 0,
            bytesBefore: Buffer.byteLength(originalText, 'utf8'),
            bytesAfter: Buffer.byteLength(JSON.stringify(ctx.arr, null, 2), 'utf8'),
            results: summary,
            note: applied.problems.length
                ? ('结构校验有 ' + applied.problems.length + ' 个问题，真跑会被拒绝；' +
                   '先修掉这些问题（或调整 ops）再提交')
                : ('试运行通过：' + ops.length + ' 个操作都会成功，' +
                   applied.before.objects + ' → ' + applied.after.objects + ' 个对象。' +
                   '去掉 dryRun 就真写')
        };
    }

    // 结构校验不通过就不写 —— 宁可不改，也不留一个编辑器打不开的文件
    if (applied.problems.length) {
        throw new Error('批量操作后结构校验不通过，已放弃写入（文件未改）：\n  - ' +
            applied.problems.join('\n  - ') +
            '\n先用 dryRun:true 看 where 出的问题，或者减少这一批里的操作');
    }

    // 提交阶段：一次写盘。写失败就把原文写回去，别留半个文件
    ctx.defer = false;
    var written;
    try {
        written = commitDoc(ctx, {});
    } catch (e) {
        try { fs.writeFileSync(ctx.abs, originalText, 'utf8'); } catch (e2) { /* 尽力 */ }
        throw new Error('写盘失败，已尝试还原原文件：' + (e && e.message ? e.message : e));
    }

    var rel = relPath(ctx.abs);
    var out = {
        path: rel,
        kind: ctx.kind,
        opCount: ops.length,
        before: applied.before,
        after: applied.after,
        results: summary,
        file: written.file,
        saved: true,
        problems: [],
        note: '已把 ' + ops.length + ' 个操作合成一次写盘。' +
            '编辑器里如果开着这个文件，请重新打开，否则它下次保存会覆盖掉这次改动。'
    };

    // assets 下的才让编辑器重导；temp/ 里的副本不用（也没法）
    if (rel.indexOf('assets/') === 0) {
        return refreshAssetUrl('db://' + rel).then(function (err) {
            out.imported = !err;
            if (err) out.importNote = '文件已写盘，但编辑器没能重新导入：' + String(err.message || err);
            return out;
        });
    }
    return out;
}

/** 把一个 op 的执行结果压成一行人话，批量 20 个时才看得下去 */
function describeOpResult(op, r) {
    if (!r) return String(op) + '（无结果）';
    switch (String(op).replace(/[_\s-]/g, '').toLowerCase()) {
        case 'addnode':
            return '+ ' + (r.added && r.added.name) + ' #' + (r.added && r.added.id);
        case 'setprops':
            return '~ ' + r.node + ' [' + (r.changed || []).join(',') + ']';
        case 'removenode':
            return '- ' + r.removed + '（连带 ' + r.deletedObjects + ' 个对象）';
        case 'movenode':
            return '> ' + r.moved + ' → ' + r.to + ' @' + r.index;
        case 'addcomponent':
            return '+ ' + (r.added && r.added.component) + ' @ ' + r.node;
        case 'removecomponent':
            return '- ' + r.removed + ' @ ' + r.node;
        case 'setcomponentprops':
            return '~ ' + r.component + ' @ ' + r.node + ' [' + (r.changed || []).join(',') + ']';
        case 'addprefab':
            return '+ 预制体 ' + (r.instantiated && r.instantiated.name) +
                '（' + (r.instantiated && r.instantiated.objects) + ' 个对象）';
        default:
            return String(op);
    }
}

function toolPrefabCreateFromNode(args) {
    if (!args.node) throw new Error('缺少 node（要导出的节点路径）');
    if (!args.prefab) throw new Error('缺少 prefab（输出预制体路径）');

    var prefabRel = String(args.prefab).replace(/\\/g, '/');
    if (prefabRel.slice(-7).toLowerCase() !== '.prefab') throw new Error('预制体文件必须以 .prefab 结尾');

    var prefabAbs = safePath(prefabRel);
    if (statSafe(prefabAbs)) throw new Error('目标已存在：' + prefabRel + '。换个路径，或者先删掉旧的（asset_delete）。');
    if (statSafe(prefabAbs + '.meta')) throw new Error('同名 .meta 已存在：' + prefabRel + '.meta');

    var sceneAbs = args.scene ? safePath(args.scene) : currentSceneFile();
    if (!sceneAbs) throw new Error('定位不到场景文件，用 scene 参数指定 .fire 路径');
    var sceneArr = loadSerialized(sceneAbs);

    var srcId = findNode(sceneArr, findSceneRootId(sceneArr), args.node);
    if (srcId === null || srcId === undefined || srcId < 0) throw new Error('找不到节点：' + args.node);
    if (sceneArr[srcId].__type__ !== 'cc.Node') throw new Error('目标不是 cc.Node：' + args.node);

    // 收集子树：节点 + 组件，DFS
    var picked = [];
    var pickedSet = {};

    (function collect(id) {
        if (pickedSet[id]) return;
        var o = sceneArr[id];
        if (!o) return;
        pickedSet[id] = true;

        picked.push({ id: id, isNode: o.__type__ === 'cc.Node' });

        var comps = o._components || [];
        for (var c = 0; c < comps.length; c++) collect(comps[c].__id__);

        var kids = o._children || [];
        for (var k = 0; k < kids.length; k++) collect(kids[k].__id__);
    })(srcId);

    if (!picked.length) throw new Error('没收集到任何对象');

    // 复制并建立 旧下标 → 新下标 映射
    var map = {};
    var clones = [];
    var nodeOrder = [];

    for (var i = 0; i < picked.length; i++) {
        map[picked[i].id] = i + 1; // 0 号位置留给 cc.Prefab
        clones.push(JSON.parse(JSON.stringify(sceneArr[picked[i].id])));
        if (picked[i].isNode) nodeOrder.push(i);
    }

    // 去掉场景里的预制体关联，导出成独立预制体
    for (var n = 0; n < clones.length; n++) {
        if (clones[n].__type__ === 'cc.Node') clones[n]._prefab = null;
    }

    // 根节点在场景里的 _parent 指向场景根（子树外），导出后应该是 null
    clones[map[srcId] - 1]._parent = null;

    // 重写内部引用；指向子树外的引用直接拒绝
    (function rewrite(obj) {
        if (obj === null || typeof obj !== 'object') return;

        if (Array.isArray(obj)) {
            for (var m = 0; m < obj.length; m++) rewrite(obj[m]);
            return;
        }

        if (typeof obj.__id__ === 'number') {
            var old = obj.__id__;
            if (map[old] === undefined) {
                var t = sceneArr[old];
                throw new Error('这个节点引用了子树外的对象 #' + old +
                    '（' + ((t && t.__type__) || '未知') + '），导出成独立预制体后会悬空');
            }
            obj.__id__ = map[old];
            return;
        }

        for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) rewrite(obj[key]);
        }
    })(clones);

    // uuid 先定下来，PrefabInfo 的 asset 要用它
    var uuid = newUuidV4();

    // 布局：[0] cc.Prefab，节点和组件，然后每个节点一个 PrefabInfo
    var arr = [];
    arr.push({
        __type__: 'cc.Prefab',
        _name: '',
        _objFlags: 0,
        _native: '',
        data: { __id__: map[srcId] },
        optimizationPolicy: 0,
        asyncLoadAssets: false,
        readonly: false
    });

    for (var p = 0; p < clones.length; p++) arr.push(clones[p]);

    // PrefabInfo 放在最后
    var infoStart = arr.length;
    for (var q = 0; q < nodeOrder.length; q++) {
        var cloneIdx = nodeOrder[q];
        var isRoot = cloneIdx === (map[srcId] - 1);

        arr.push({
            __type__: 'cc.PrefabInfo',
            root: { __id__: map[srcId] },
            asset: { __uuid__: uuid },
            fileId: isRoot ? '' : newNodeId(),
            sync: false
        });

        arr[cloneIdx + 1]._prefab = { __id__: infoStart + q };
        if (isRoot) arr[cloneIdx + 1]._parent = null;
    }

    // 节点在预制体里 _id 一律空串（引擎的约定）
    for (var z = 0; z < arr.length; z++) {
        if (arr[z].__type__ === 'cc.Node') arr[z]._id = '';
    }

    fs.writeFileSync(prefabAbs, JSON.stringify(arr, null, 2), 'utf8');

    var meta = {
        ver: '1.3.2',
        uuid: uuid,
        importer: 'prefab',
        optimizationPolicy: 'AUTO',
        asyncLoadAssets: false,
        readonly: false,
        subMetas: {}
    };
    fs.writeFileSync(prefabAbs + '.meta', JSON.stringify(meta, null, 2), 'utf8');

    var relOut = path.relative(projectRoot(), prefabAbs).replace(/\\/g, '/');

    return afterWrite('db://' + relOut, {
        created: relOut,
        uuid: uuid,
        from: args.node,
        objects: arr.length,
        nodes: nodeOrder.length
    }, '预制体已导出并导入。用 prefab_instantiate 可以把它拷回场景');
}

//#region 从 spec 直接造预制体

/** 图片路径 → sprite-frame uuid（和 resolve_sprite_frame 走同一条路，保证一致） */
function spriteFrameUuidOf(rel) {
    var r = toolResolveSpriteFrame({ path: rel });
    if (!r.spriteFrameUuid) {
        throw new Error('这张图没有 sprite-frame 子资源：' + rel +
            '（.prefab 的 Sprite 只能用 png/jpg 这类图片资源）');
    }
    return r.spriteFrameUuid;
}

/** 资源路径 → 完整 uuid */
function assetUuidOf(rel) {
    try {
        return resolveAssetUuid(rel);
    } catch (e) {
        throw new Error('资源引用解析不出 uuid：' + rel +
            '。确认路径相对项目根、且同名 .meta 存在（先用 list_dir / search_files 核对）');
    }
}

/** 脚本路径 → 组件 __type__（23 位压缩 uuid） */
function scriptTypeOf(rel) {
    try {
        var r = resolveComponentType(rel);
        if (r.kind !== 'script') throw new Error('not a script');
        return r;
    } catch (e) {
        throw new Error('脚本组件解析失败：' + rel +
            '。确认是 assets 下的 .ts/.js，并且有 .meta（编辑器导入过）');
    }
}

/**
 * 找节点/组件的克隆模板。
 *
 * 「不手搓节点对象」这条铁律对新预制体同样成立 —— `_objFlags` / `_trs.ctor` /
 * `_is3DNode` 这些字段少一个，编辑器行为就可能怪怪的。所以优先从项目里
 * 已有的 .fire / .prefab 克隆，实在一个都没有才用内置兜底模板。
 */
function collectPrefabTemplates(templatePath) {
    var root = projectRoot();
    if (!root) throw new Error('项目未打开');

    var arrays = [];
    var seen = {};

    function add(abs) {
        if (!abs || seen[abs]) return;
        seen[abs] = true;
        try {
            var a = loadSerialized(abs);
            if (Array.isArray(a)) arrays.push(a);
        } catch (e) { /* 坏文件跳过，模板而已 */ }
    }

    if (templatePath) {
        var tp = safePath(templatePath);
        if (!statSafe(tp)) throw new Error('template 指定的文件不存在：' + templatePath);
        add(tp);
    }

    var cur = currentSceneFile();
    if (cur) add(cur);

    var assetsDir = path.join(root, 'assets');
    var count = 0;
    if (statSafe(assetsDir)) {
        walkFiles(assetsDir, { maxDepth: 20, skip: SKIP_DIRS }, function (full, name) {
            if (count >= 40) return;
            var low = name.toLowerCase();
            if (low.slice(-7) !== '.prefab' && low.slice(-5) !== '.fire') return;
            count++;
            add(full);
        });
    }

    return { templates: pickPrefabTemplates(arrays), scanned: arrays.length };
}

/**
 * 从声明式节点树一次生成 .prefab（+ .meta）。
 *
 * 为什么需要它：prefab_create_from_node 要求"先把节点搭进场景"，等于把创作
 * 拆成两步还污染主场景；手写 99 个 JSON 对象又等于手工模拟六个工具。
 * 这个工具只接受**图片路径**和**脚本路径**，序列化细节（sprite-frame uuid、
 * PrefabInfo、fileId、_trs 顺序）全部内部处理。
 */
function toolPrefabCreate(args) {
    args = args || {};

    // from=node：把场景里已有的节点子树导出（原 prefab_create_from_node）。
    // 两种模式产物一样，只是来源不同，合成一个工具少一次"该用哪个"的判断。
    var from = args.from ? String(args.from).toLowerCase() : (args.root ? 'spec' : (args.node ? 'node' : 'spec'));
    if (from === 'node') {
        return toolPrefabCreateFromNode({ node: args.node, prefab: args.prefab, scene: args.scene });
    }
    if (from !== 'spec') throw new Error('from 只能是 spec / node，收到：' + args.from);

    if (!args.path) throw new Error('缺少 path（输出路径，如 assets/packages/ui/views/Foo.prefab）');
    if (!args.root) throw new Error('缺少 root（节点树 spec，{name, size, sprite, children...}）');

    var rel = String(args.path).replace(/\\/g, '/');
    if (rel.slice(-7).toLowerCase() !== '.prefab') throw new Error('path 必须以 .prefab 结尾');
    if (rel.indexOf('assets/') !== 0) throw new Error('预制体必须建在 assets 下（编辑器只导入 assets 里的资源）：' + rel);

    var abs = safePath(rel);
    if (statSafe(abs)) {
        throw new Error('目标已存在：' + rel + '。' +
            '要整份重写请用 write_file（会做结构校验 + 保住 fileId），或先 asset_delete。');
    }
    if (statSafe(abs + '.meta')) throw new Error('同名 .meta 已存在：' + rel + '.meta，先清掉它再建');

    var collected = collectPrefabTemplates(args.template);
    var warnings = [];
    if (!collected.templates.node) {
        warnings.push('项目里没有任何 .fire / .prefab 可当模板，节点字段用了内置兜底模板');
    }
    if (collected.scanned === 0) warnings.push('没扫到模板文件，组件字段可能不全');

    var uuid = newUuidV4();
    var built = buildPrefabFromSpec(args.root, {
        uuid: uuid,
        templates: collected.templates,
        spriteUuid: spriteFrameUuidOf,
        assetUuid: assetUuidOf,
        scriptType: scriptTypeOf,
        script: args.script || null,
        mask: args.mask === true
    });

    // 自己生成的东西也要过校验 —— 校验器是最后一道闸，不信"我刚生成的应该没问题"
    var problems = validatePrefabArray(built.arr, rel);
    if (problems.length) {
        throw new Error('生成的预制体结构不合法（这是 MCP 自身的缺陷，请把这条信息报给维护者）：\n  - ' +
            problems.join('\n  - '));
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeJsonPreserving(abs, built.arr);

    var meta = {
        ver: '1.3.2',
        uuid: uuid,
        importer: 'prefab',
        optimizationPolicy: 'AUTO',
        asyncLoadAssets: false,
        readonly: false,
        subMetas: {}
    };
    fs.writeFileSync(abs + '.meta', JSON.stringify(meta, null, 2), 'utf8');
    markDirty(rel);
    // prefab_create 是唯一一个"从零造文件"的写路径，也要记账
    try { noteFileWrite(abs, { tool: 'prefab_create' }); } catch (e) { /* 忽略 */ }

    var out = {
        created: rel,
        uuid: uuid,
        compressedUuid: compressUuid(uuid),
        nodeCount: built.nodeCount,
        objects: built.arr.length,
        templateFiles: collected.scanned,
        nodes: built.nodes.map(function (n) { return n.path; }),
        warnings: built.warnings.length ? built.warnings.concat(warnings) : (warnings.length ? warnings : null)
    };
    if (!out.warnings) delete out.warnings;

    return afterWrite('db://' + rel, out,
        '预制体已生成并导入。用 query_scene_tree 读回确认，用 prefab_layout_check 查布局，' +
        '用 prefab_instantiate 把它放进场景'
    ).then(function (result) {
        // A 类修复：编辑器导入后可能重分配 .meta.uuid。
        // 以 .meta 为唯一口径，把 prefab 内所有 PrefabInfo.asset 自引用对齐，
        // 避免 project_doctor 报「悬空引用」（运行时才显形）。
        var real = null;
        try { real = JSON.parse(fs.readFileSync(abs + '.meta', 'utf8')).uuid; } catch (e) { }
        if (!real || real === uuid) return result;

        var cur = null;
        try { cur = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { return result; }
        var changed = 0;
        for (var k = 0; k < cur.length; k++) {
            var o = cur[k];
            if (o && o.__type__ === 'cc.PrefabInfo' && o.asset && o.asset.__uuid__ === uuid) {
                o.asset.__uuid__ = real;
                changed++;
            }
        }
        if (changed) {
            writeJsonPreserving(abs, cur);
            markDirty(rel);
        }
        result.uuid = real;
        result.compressedUuid = compressUuid(real);
        result.uuidReconciled = { from: uuid, to: real, refs: changed };
        return result;
    });
}

//#endregion

//#region 布局自检与脚本编译状态

/**
 * 纯几何布局自检：越界 / 同级重叠 / 超出父容器 / 隐藏节点。
 *
 * 这次的真实教训：任务文字和左侧图标重叠，是靠自己写 PIL 渲染器出预览图才发现的。
 * 但"谁压在谁上面"其实不用渲染就能算出来 —— 遍历 _trs 累加世界坐标，
 * 按 _contentSize + _anchorPoint 算包围盒，两两比一下就有答案。
 */
function toolPrefabLayoutCheck(args) {
    if (!args.path) throw new Error('缺少 path（.fire 或 .prefab 的路径）');
    var abs = safePath(args.path);
    if (!statSafe(abs)) {
        throw new Error('文件不存在：' + args.path + '。用 list_dir 看目录结构、search_files 搜文件名来定位。');
    }

    var arr = loadSerialized(abs);
    var root = findRootForEdit(arr);
    if (root.rootId < 0) {
        throw new Error('既不是 .fire（没有 cc.Scene）也不是 .prefab（没有 cc.Prefab.data）：' + args.path);
    }

    var rep = prefabLayoutCheck(arr, root.rootId, {
        canvas: Array.isArray(args.canvas) && args.canvas.length >= 2 ? args.canvas : null,
        tolerance: typeof args.tolerance === 'number' ? args.tolerance : 1
    });

    rep.path = relPath(abs);
    rep.kind = root.kind;
    rep.note = '纯几何计算：不算旋转，也不模拟 cc.Widget 的运行时对齐。' +
        '只比同级兄弟节点之间的重叠（父子重叠是正常结构）。' +
        '重叠报出来不等于错 —— 层叠背景、投影这类是有意为之。';
    return rep;
}

function isoTime(ms) {
    if (!ms) return null;
    return new Date(ms).toISOString();
}

/**
 * 脚本编译状态：改完 .ts 到底编译了没有。
 *
 * 为什么需要它：`get_editor_log` 在 2.x 多开时读不到主日志（另个进程独占），
 * 但"改完源码要等编辑器编译完再构建"这条约束还在。构建用的是
 * `library/imports/<uuid>.js` 和 `temp/quick-scripts/dst/` 里的产物 ——
 * 产物比源码旧就是 stale，产物不存在就是 missing。
 *
 * 局限（如实说明，不编造）：拿不到编译器报的语法错误。语法错时编译不会更新产物，
 * 所以表现为持续 stale；诊断信息只在你指定 paths 且产物缺失时给解释。
 */
function buildCompileStatus(args) {
    var root = projectRoot();
    if (!root) throw new Error('项目未打开');

    var since = typeof args.since === 'number' ? args.since : null;
    var onlyProblems = args.all !== true;
    var MAX = 400;

    var rels = [];
    if (Array.isArray(args.paths) && args.paths.length) {
        for (var i = 0; i < args.paths.length; i++) {
            var p = String(args.paths[i]).replace(/\\/g, '/');
            if (p.slice(-3).toLowerCase() !== '.ts' && p.slice(-3).toLowerCase() !== '.js') {
                throw new Error('paths 只接受 .ts / .js：' + p);
            }
            rels.push(p);
        }
        onlyProblems = false; // 指定了就都报，别自作主张过滤
    } else {
        var assetsDir = path.join(root, 'assets');
        if (!statSafe(assetsDir)) throw new Error('项目里没有 assets 目录：' + root);
        walkFiles(assetsDir, { maxDepth: 30, skip: SKIP_DIRS }, function (full, name) {
            var low = name.toLowerCase();
            if (low.slice(-3) !== '.ts' && low.slice(-3) !== '.js') return;
            if (low.slice(-8) === '.d.ts') return;
            if (rels.length >= MAX) return;
            rels.push(relPath(full));
        });
    }

    var items = [];
    var counts = { ok: 0, stale: 0, missing: 0, unknown: 0 };

    for (var r = 0; r < rels.length; r++) {
        var relp = rels[r];
        var abs = safePath(relp);
        var st = statSafe(abs);
        if (!st) {
            items.push({ script: relp, state: 'missing-source', note: '源码文件不存在（可能已被删/改名）' });
            counts.unknown++;
            continue;
        }
        if (since && st.mtimeMs < since) continue;

        var uuid = pathToUuid(relp);
        var libAbs = uuid ? path.join(root, 'library', 'imports', uuid.slice(0, 2), uuid + '.js') : null;
        var qsAbs = path.join(root, 'temp', 'quick-scripts', 'dst', relp.replace(/\.(ts|js)$/i, '.js'));

        var libSt = libAbs ? statSafe(libAbs) : null;
        var qsSt = statSafe(qsAbs);
        var compiledMs = Math.max(libSt ? libSt.mtimeMs : 0, qsSt ? qsSt.mtimeMs : 0);

        var state;
        var note = null;
        if (!libSt && !qsSt) {
            state = 'missing';
            note = '两个编译产物都没有（library/imports/' + (uuid ? uuid.slice(0, 2) : '??') +
                '/<uuid>.js 与 temp/quick-scripts/dst/）。' +
                '可能是新文件还没被编辑器导入，或者不是脚本（.d.ts 之类）。';
        } else if (compiledMs < st.mtimeMs) {
            state = 'stale';
            note = '编译产物比源码旧：编辑器还没编译完，或编译失败（语法错时产物不会更新）。' +
                '等编辑器编译完再看，或去编辑器控制台确认报错。';
        } else {
            state = 'ok';
        }

        if (onlyProblems && state === 'ok') continue;

        items.push({
            script: relp,
            uuid: uuid,
            state: state,
            sourceMtime: isoTime(st.mtimeMs),
            compiledMtime: isoTime(compiledMs || 0),
            lagSeconds: compiledMs ? Math.round((st.mtimeMs - compiledMs) / 100) / 10 : null,
            libraryArtifact: libSt ? relPath(libAbs) : null,
            quickScriptArtifact: qsSt ? relPath(qsAbs) : null,
            diagnostics: [],
            note: note
        });
        if (counts[state] !== undefined) counts[state]++;
    }

    var scanned = rels.length;
    var out = {
        scanned: scanned,
        reported: items.length,
        summary: counts,
        truncated: scanned >= MAX,
        scripts: items,
        // B 类修复：显式声明诊断不可用，避免调用方把空 diagnostics 当成「无语法错误」
        diagnosticsAvailable: false,
        conclusion: 'ok/stale 只反映编译产物与源码的 mtime 关系，不代表编译无错误；' +
            '要确认可运行请用 preview 的 eval/script 做运行时断言',
        note: (onlyProblems
            ? '只列了不是 ok 的脚本（要全部传 all:true）。'
            : '按 paths 列出全部指定脚本。') +
            ' 判断依据是编译产物的 mtime 与源码 mtime 的先后，' +
            '不读编辑器日志（2.x 多开时那个日志被另一个进程独占，读不到）。' +
            'diagnostics 恒为空数组 —— 4.x 之前的编译器不落盘错误清单，需要具体报错请看编辑器控制台。'
    };
    if (since) out.since = since;
    // 一条问题都没有 = 全绿。空数组在这里是好消息，不该被标成 partial
    if (!items.length) {
        out.__status = 'ok';
        out.__reason = onlyProblems
            ? '所有脚本的编译产物都是最新的（或 since 之后没有改动）'
            : '指定的路径在 since 之后没有改动';
    }
    return out;
}

/**
 * 编译状态（可等待）。
 *
 * 不带 waitMs 就是一次快照；带 waitMs 会轮询到"全部 ok"或超时 ——
 * 这是给"改完 .ts 立刻构建"用的：构建选项 autoCompile:false，
 * 不等编译完就构建，打进的是旧代码，而且构建不会告诉你。
 */
function toolScriptCompileStatus(args) {
    args = args || {};
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 0;

    if (waitMs <= 0) return buildCompileStatus(args);

    var cap = Math.min(waitMs, 60000);
    var t0 = Date.now();
    var deadline = t0 + cap;

    function poll() {
        var out = buildCompileStatus(args);
        var pending = (out.scripts || []).filter(function (x) {
            return x.state === 'stale' || x.state === 'missing';
        });

        if (!pending.length) {
            out.waitedMs = Date.now() - t0;
            out.settled = true;
            if (out.waitedMs > 0) {
                out.note = '已等到全部编译完成（' + out.waitedMs + 'ms）。' + out.note;
            }
            return out;
        }
        if (Date.now() >= deadline) {
            out.waitedMs = Date.now() - t0;
            out.settled = false;
            out.pending = pending.map(function (x) { return x.script + '：' + x.state; });
            out.note = '等了 ' + out.waitedMs + 'ms 还没编译完（' + pending.length + ' 个脚本仍是 stale/missing）。' +
                '要么编辑器没在编译（语法错 / 窗口没聚焦），要么这个文件不参与编译。' +
                '**别急着构建** —— 构建用的是缓存产物。' + out.note;
            return out;
        }
        return new Promise(function (r) { setTimeout(r, 400); }).then(poll);
    }

    return poll();
}

//#endregion

//#endregion

//#region 节点重排与项目设置

/**
 * 换父节点 / 调整同级顺序。
 * UI 层级调整（比如把 bottomUI 提到 topUI 前面）很常用，场景里改一次要动
 * 父节点的 _children 和节点自己的 _parent 两处，漏一个就串位。
 */
function toolSceneMoveNode(args) {
    if (!args.node) throw new Error('缺少 node（要移动的节点）');

    var ctx = openDocForEdit(args);
    var arr = ctx.arr;

    var rn = resolveNode(arr, ctx.rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw nodeNotFoundError(arr, ctx.rootId, args.node);
    }
    var id = rn.id;
    if (id === ctx.rootId) {
        throw new Error('不能移动' + (ctx.kind === 'prefab' ? '预制体根节点' : '场景根节点'));
    }

    var node = arr[id];
    if (node.__type__ !== 'cc.Node') throw new Error('目标不是 cc.Node：' + args.node);

    var oldParentId = node._parent && typeof node._parent.__id__ === 'number' ? node._parent.__id__ : null;
    if (oldParentId === null) throw new Error('这个节点没有父节点引用，不敢动');

    var oldParent = arr[oldParentId];

    // 目标父节点：不给就留在原父节点下，只调顺序
    var newParentId = oldParentId;
    if (args.newParent) {
        if (isRootRef(args.newParent, ctx.kind)) {
            newParentId = ctx.rootId;
        } else {
            var npn = resolveNode(arr, ctx.rootId, args.newParent);
            newParentId = npn.id;

            // 根下找不到就按"兄弟节点"理解：AI 说"挂到 Main Camera 下"时
            // 往往指的是同级那个，而不是要写全路径
            if (newParentId === null || newParentId === undefined || newParentId < 0) {
                var sibMatch = -1;
                var sibs = (oldParent && oldParent._children) || [];
                for (var s = 0; s < sibs.length; s++) {
                    var so = arr[sibs[s].__id__];
                    if (so && so._name === args.newParent) {
                        if (sibMatch >= 0) {
                            throw new Error('"' + args.newParent + '" 有多个同名兄弟，请写完整路径');
                        }
                        sibMatch = sibs[s].__id__;
                    }
                }
                newParentId = sibMatch;
            }

            if (newParentId === null || newParentId === undefined || newParentId < 0) {
                throw new Error('找不到目标父节点：' + args.newParent +
                    '（可以写场景根算起的完整路径，或用同级节点的名字）');
            }
        }
    }

    // 不能挂到自己的子孙下面，会造成环
    if (newParentId !== oldParentId) {
        var guard = {};
        (function check(pid) {
            if (guard[pid]) return;
            guard[pid] = true;
            var o = arr[pid];
            if (!o) return;
            var kids = o._children || [];
            for (var i = 0; i < kids.length; i++) check(kids[i].__id__);
        })(newParentId);
        if (guard[id]) throw new Error('不能把节点挂到它自己的子孙下面');
    }

    var newParent = arr[newParentId];
    if (!Array.isArray(newParent._children)) newParent._children = [];

    // 从旧父节点摘掉
    var oldKids = (oldParent && oldParent._children) || [];
    for (var i = 0; i < oldKids.length; i++) {
        if (oldKids[i] && oldKids[i].__id__ === id) { oldKids.splice(i, 1); break; }
    }

    // 插到目标位置
    var index = typeof args.index === 'number' ? args.index : newParent._children.length;
    if (index < 0) index = 0;
    if (index > newParent._children.length) index = newParent._children.length;
    newParent._children.splice(index, 0, { __id__: id });

    node._parent = { __id__: newParentId };

    return commitDoc(ctx, {
        moved: node._name,
        from: oldParent && oldParent._name ? oldParent._name : (ctx.kind === 'prefab' ? 'Root' : 'Scene'),
        to: newParent._name ? newParent._name : (ctx.kind === 'prefab' ? 'Root' : 'Scene'),
        index: index,
        kind: ctx.kind
    });
}

function profileToPlain(data) {
    var out = {};
    if (!data || typeof data !== 'object') return out;
    for (var k in data) {
        if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
        var v = data[k];
        var t = typeof v;
        if (v === null || t === 'string' || t === 'number' || t === 'boolean') out[k] = v;
    }
    return out;
}

function toolProjectSettingsGet(args) {
    if (typeof Editor === 'undefined' || !Editor.Profile) throw new Error('Editor.Profile 不可用');

    var url = args.profile || 'project://project.json';
    var p = Editor.Profile.load(url);
    if (!p) throw new Error('读不到 profile：' + url);

    var data = p.getSelfData();
    var plain = profileToPlain(data);

    if (args.keys && args.keys.length) {
        var picked = {};
        for (var i = 0; i < args.keys.length; i++) {
            var k = args.keys[i];
            if (plain[k] !== undefined) picked[k] = plain[k];
        }
        plain = picked;
    }

    return { profile: url, settings: plain };
}

function toolProjectSettingsSet(args) {
    if (typeof Editor === 'undefined' || !Editor.Profile) throw new Error('Editor.Profile 不可用');
    if (!args.settings || typeof args.settings !== 'object') throw new Error('缺少 settings');

    var url = args.profile || 'project://project.json';
    var p = Editor.Profile.load(url);
    if (!p) throw new Error('读不到 profile：' + url);

    var applied = [];
    for (var k in args.settings) {
        if (!Object.prototype.hasOwnProperty.call(args.settings, k)) continue;
        p.set(k, args.settings[k]);
        applied.push(k);
    }
    if (!applied.length) return { changed: [], note: 'settings 是空的' };

    p.save();

    return {
        profile: url,
        changed: applied,
        saved: true,
        note: '项目设置已保存。design-resolution / fit-width / start-scene 这类改完可能需要重开编辑器才完全生效'
    };
}

//#endregion

//#region 预览服务

var previewState = {
    running: false,
    port: null,
    url: null,
    startedAt: null,
    error: null
};

/** 探一下预览服务是不是真的在响应 */
function probeHttp(url, timeoutMs) {
    var http = require('http');
    return new Promise(function (resolve) {
        var settled = false;
        var req = http.get(url, function (res) {
            if (settled) return;
            settled = true;
            res.resume();
            resolve({ ok: true, status: res.statusCode });
        });
        req.on('error', function (e) {
            if (settled) return;
            settled = true;
            resolve({ ok: false, error: e.code || e.message });
        });
        req.setTimeout(timeoutMs || 3000, function () {
            if (settled) return;
            settled = true;
            req.destroy();
            resolve({ ok: false, error: 'timeout' });
        });
    });
}

/**
 * 预览服务的「场景校验」函数。
 *
 * 引擎的 PreviewServer.start 第一个参数就是它。作用是保证
 * Editor.stashedScene 里有当前场景 —— 预览页要靠它拿到场景的
 * designResolution / 场景列表。
 *
 * 行为和引擎自带的那份一致：
 *   已有 stashedScene → 直接往下走
 *   没有 → 广播 scene:preview-server-scene-stashed 给场景窗口，
 *          等它把场景 stash 上来再继续
 *
 * 不传这个函数（传 null）会导致 query 整个函数体被跳过，
 * settings.js 请求永远挂着，浏览器那边页面直接卡死。
 */
function previewValidateStashedScene(work) {
    if (Editor.stashedScene) {
        work();
        return;
    }
    try {
        Editor.App.once('app:preview-server-scene-stashed', function () {
            work();
        });
        Editor.Ipc.sendToWins('scene:preview-server-scene-stashed');
    } catch (e) {
        // 发不出去也别把请求挂死 —— 至少让页面能加载
        setTimeout(function () {
            try { work(); } catch (e2) { /* 忽略 */ }
        }, 2000);
    }
}

function startPreviewServer(ps) {
    return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            previewState.error = '启动超时';
            reject(new Error('启动预览服务超时（10s）'));
        }, 10000);

        try {
            // 第一个参数是「场景校验函数」，**不能传 null**。
            //
            // 引擎的 PreviewServer.query 源码长这样：
            //   async function(e,i,r){ ... if(this._validateStashedScene) switch(...){ case "settings.js": ... } }
            // 整个 switch 被这个 if 包着 —— 传了 null，query 什么都不做，
            // 回调永远不被调用，settings.js 这个请求就**永远挂着**，
            // 浏览器那边页面卡死（连 1+1 都执行不了）。
            //
            // 校验函数的作用：确保 Editor.stashedScene 里有当前场景。
            // 没有就广播消息给场景窗口，等它把场景 stash 上来。
            ps.start(previewValidateStashedScene, function () {
                if (settled) return;
                settled = true;
                clearTimeout(timer);

                var port = ps._previewPort;
                previewState = {
                    running: true,
                    port: port,
                    url: 'http://127.0.0.1:' + port + '/',
                    startedAt: Date.now(),
                    error: null
                };

                resolve({
                    running: true,
                    port: port,
                    url: previewState.url,
                    reused: false,
                    note: '预览服务已起。注意 /build 路由要求项目已经构建过，' +
                        '没构建的话页面会提示 "Please build your game project first!"'
                });
            });
        } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            previewState.error = String(e.message || e);
            reject(e);
        }
    });
}

/**
 * 把 bridge.js 注入到预览页。
 *
 * 用 Editor.PreviewServer.userMiddlewares（Express 中间件数组）拦截预览页 HTML，
 * 在 <head> 里插一段 <script>：
 *   - 先写配置（端口、项目名），bridge.js 靠它找到扩展
 *   - 再引 bridge.js 本体
 *
 * 关键：bridge.js 的内容**内联**进 HTML，不单独发一个文件请求 ——
 * 预览服务器的静态路由不好猜，多一个请求就多一个失败点。
 *
 * 只注入一次（用标记判断），重复调用不会叠加。
 */
function installPreviewBridge() {
    var ps = Editor.PreviewServer;
    if (!ps || !Array.isArray(ps.userMiddlewares)) {
        return { installed: false, reason: 'Editor.PreviewServer.userMiddlewares 不可用' };
    }

    // 已经装过的话，先把旧的摘掉再装新的。
    //
    // 为什么必须这么做：热重载（reload.js）会换掉整个模块，
    // 但装进引擎的中间件是**旧模块里的那个函数**，它还留在数组里。
    // 如果只靠标记判断要不要装，重载后的新代码永远装不上 ——
    // 标记还在，直接 return alreadyInstalled，新逻辑根本没进去。
    // 这就是「改了没生效」的一类根因。
    var existing = null;
    for (var i = ps.userMiddlewares.length - 1; i >= 0; i--) {
        var fn = ps.userMiddlewares[i];
        if (fn && fn.__mcpBridge) {
            existing = fn;
            ps.userMiddlewares.splice(i, 1);
        }
    }
    delete ps.userMiddlewares.__mcpBridgeInstalled;

    var bridgePath = path.join(__dirname, 'bridge.js');
    var src;
    try {
        src = fs.readFileSync(bridgePath, 'utf8');
    } catch (e) {
        return { installed: false, reason: '读不到 bridge.js：' + (e.message || e) };
    }

    // 注入配置里的端口：优先用**中继端口**。
    //
    // 为什么不用扩展自己的端口：扩展端口会变（编辑器重启、多开时按启动顺序分配）。
    // 页面里的配置一旦写死，扩展一重启就指向一个死端口 ——
    // 桥接静默断掉，不报任何错。
    // 中继端口是固定的（mcp.json 就指着它），中继再把 /bridge/* 转发给目标实例。
    //
    // 中继没跑的时候才退回扩展自己的端口（单实例直连也能用）。
    var port = 0;
    var usingHub = false;
    try {
        // 中继活着就用中继端口（固定），否则退回扩展自己的端口
        var hubInfo = readHubState();
        if (hubInfo && hubInfo.port) {
            port = hubInfo.port;
            usingHub = true;
        }
    } catch (e) { /* 忽略 */ }
    if (!port) {
        port = listeningPort || 0;
    }
    if (!port) {
        return { installed: false, reason: '扩展端口还没确定（listeningPort=0）' };
    }

    var project = path.basename(projectRoot() || '');

    // 内联脚本要转义 </script>，否则会提前闭合标签
    var safeSrc = src.replace(/<\/script>/gi, '<\\/script>');

    var mw = function (req, res, next) {
        // 只改预览页（HTML），别的资源原样放过
        var isHtml = function () {
            var u = (req.url || '').split('?')[0];
            return u === '/' || u === '/index.html' || u === '/preview';
        };
        if (!isHtml()) { next(); return; }

        // 注入内容只生成一次
        var injectHtml = function () {
            return '<script>window.__MCP_BRIDGE_CONFIG__=' +
                JSON.stringify({
                    port: port,
                    project: project,
                    interval: 1500,
                    cmdPollInterval: 400
                }) + ';</script>' +
                '<script>' + safeSrc + '</script>';
        };

        var injectOnce = function (html) {
            try {
                var s = String(html);
                if (s.indexOf('<head>') >= 0 && s.indexOf('__MCP_BRIDGE_CONFIG__') < 0) {
                    return s.replace('<head>', '<head>' + injectHtml());
                }
            } catch (e) { /* 忽略 */ }
            return html;
        };

        // 关键：预览页是用 res.render() 渲染的（不是 res.send）。
        //
        // 之前一直 hook res.send 不生效 —— 因为 Express 的 res.render 内部
        // 走的是它自己闭包里的发送逻辑，不会用我们替换过的 res.send。
        // hook res.render 的回调，在拿到渲染好的 HTML 之后再改，才是正确切入点。
        var origRender = res.render;
        res.render = function (view, locals, cb) {
            var self = this;
            var origCb = cb;

            // Express 的 render 有两种签名：
            //   render(view, locals, cb)
            //   render(view, cb)     ← locals 是函数
            if (typeof locals === 'function' && cb === undefined) {
                origCb = locals;
                locals = undefined;
            }

            var wrappedCb = function (err, html) {
                if (err) {
                    if (origCb) return origCb(err, html);
                    return self.send(html);
                }
                var out = injectOnce(html);
                if (origCb) return origCb(null, out);
                return self.send(out);
            };

            try {
                return origRender.call(this, view, locals, wrappedCb);
            } catch (e) {
                // render 本身失败就退回去，别把预览页搞挂
                return origRender.call(this, view, locals, origCb);
            }
        };

        // 兜底：万一某些路径真的走 res.send（模板不存在时的静态回退）
        var origSend = res.send;
        res.send = function (body) {
            if (typeof body === 'string' && body.indexOf('<head>') >= 0 &&
                body.indexOf('__MCP_BRIDGE_CONFIG__') < 0) {
                return origSend.call(this, injectOnce(body));
            }
            return origSend.apply(this, arguments);
        };

        next();
    };
    // 标记这个中间件是我装的 —— 热重载后要能把旧的摘掉
    mw.__mcpBridge = true;

    ps.userMiddlewares.push(mw);
    return { installed: true, port: port, viaHub: usingHub, project: project };
}

/**
 * 用 Electron 的 BrowserWindow 打开预览页。
 *
 * 为什么不用系统浏览器：这台机器上 chrome.exe 直接 Permission denied，
 * 浏览器进程根本创建不出来。Electron 自带的 Chromium 是编辑器的一部分，
 * 能正常跑 —— 而且它就在同一个进程树里，注入的 bridge.js 能连回扩展。
 */
var previewWindow = null;

function openPreviewWindow(url, forceReload) {
    var electron;
    try {
        electron = require('electron');
    } catch (e) {
        return { opened: false, reason: '扩展里拿不到 electron 模块：' + (e.message || e) };
    }
    if (!electron || !electron.BrowserWindow) {
        return { opened: false, reason: 'electron.BrowserWindow 不可用' };
    }

    // 已经开着一个就复用，别开一堆
    if (previewWindow && !previewWindow.isDestroyed()) {
        try {
            previewWindow.focus();
            // B 类修复：同 URL 的 loadURL 常被 Chromium 当作同一文档导航跳过，
            // 导致复用服务时页面里没有刚注入的 bridge。强制重载缓存即可。
            if (forceReload && previewWindow.webContents &&
                previewWindow.webContents.reloadIgnoringCache) {
                previewWindow.webContents.reloadIgnoringCache();
            } else {
                previewWindow.loadURL(url);
            }
        } catch (e) { /* 忽略 */ }
        return { opened: true, reused: true, url: url, reloaded: !!forceReload };
    }

    try {
        previewWindow = new electron.BrowserWindow({
            width: 480,
            height: 800,
            show: true,
            title: 'Cocos 预览 (cocos-mcp-2x)',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false,
                webSecurity: false,   // 允许 XHR 到 127.0.0.1（bridge 上报用）
                backgroundThrottling: false
            }
        });
    } catch (e) {
        previewWindow = null;
        return { opened: false, reason: '创建 BrowserWindow 失败：' + (e.message || e) };
    }

    try {
        previewWindow.loadURL(url);
    } catch (e) { /* 忽略 */ }

    previewWindow.on('closed', function () {
        previewWindow = null;
    });

    // 调试出口：让外部能问窗口里的状态（页面有没有加载完、bridge 装上没有）
    global.__mcpPreviewWindow = previewWindow;

    return { opened: true, reused: false, url: url };
}

function closePreviewWindow() {
    if (!previewWindow || previewWindow.isDestroyed()) {
        previewWindow = null;
        return { closed: false, note: '没有打开的预览窗口' };
    }
    try {
        previewWindow.close();
    } catch (e) { /* 忽略 */ }
    previewWindow = null;
    return { closed: true };
}

/**
 * preview_control —— 启动/停止**引擎的 Web 预览**。
 *
 * 关键点：预览页走的是 preview-scripts/__quick_compile__.js（引擎即时编译），
 * **不需要 build**。/build/index.html 才是构建产物。
 */
function toolPreviewControl(args) {
    var ps = Editor.PreviewServer;
    if (!ps) throw new Error('Editor.PreviewServer 不可用');

    var action = String(args.action || 'status').toLowerCase();

    if (action === 'start') {
        // 先探一下：PreviewServer 每次 start 都会新开一个端口，而 stop() 只关最后那个，
        // 多 start 几次会漏一堆端口。所以已经在跑就直接复用，别再开新的。
        var curPort = ps._previewPort;
        var curUrl = 'http://127.0.0.1:' + curPort + '/';
        return probeHttp(curUrl, 2000).then(function (r) {
            if (r.ok) {
                previewState = {
                    running: true,
                    port: curPort,
                    url: curUrl,
                    startedAt: previewState.startedAt || Date.now(),
                    error: null
                };
                // 服务已在跑，但 bridge 可能还没注入（比如扩展是后启动的）
                var inj = installPreviewBridge();
                var win = args.open === false
                    ? { opened: false, reason: 'open=false' }
                    : openPreviewWindow(curUrl, true);
                return {
                    running: true,
                    port: curPort,
                    url: curUrl,
                    reused: true,
                    bridge: inj,
                    window: win,
                    note: '预览服务已经在跑，复用它（没有新开端口）；' +
                        '已强制重载预览页以装入 bridge。预览页是引擎即时编译的，不需要 build。'
                };
            }
            return startPreviewServer(ps).then(function (out) {
                var inj = installPreviewBridge();
                var win = args.open === false ? { opened: false, reason: 'open=false' } : openPreviewWindow(out.url);
                return {
                    running: true,
                    port: out.port,
                    url: out.url,
                    reused: false,
                    bridge: inj,
                    window: win,
                    note: '预览服务已起（引擎即时编译，不需要 build）。' +
                        'bridge 已注入预览页，窗口已打开。'
                };
            });
        });
    }

    if (action === 'stop') {
        try {
            ps.stop();
        } catch (e) {
            // 关不掉也照常汇报
        }
        var closed = closePreviewWindow();
        // 把装进引擎的中间件摘掉 —— 不然下次 start 会有两个，
        // 而且热重载后装的是旧函数。
        try {
            var um = ps.userMiddlewares;
            if (Array.isArray(um)) {
                for (var ui = um.length - 1; ui >= 0; ui--) {
                    if (um[ui] && um[ui].__mcpBridge) um.splice(ui, 1);
                }
            }
        } catch (e) { /* 忽略 */ }
        previewState = {
            running: false,
            port: null,
            url: null,
            startedAt: null,
            error: null
        };
        return { running: false, window: closed, note: '已请求停止预览服务' };
    }

    if (action === 'open') {
        var p2 = ps._previewPort;
        if (!p2) throw new Error('预览服务没起。先 preview_control start');
        var u2 = 'http://127.0.0.1:' + p2 + '/';
        var inj2 = installPreviewBridge();
        var w2 = openPreviewWindow(u2);
        return {
            url: u2,
            bridge: inj2,
            window: w2,
            note: w2.opened
                ? '已在内置 Chromium 窗口打开预览页'
                : ('窗口没打开：' + (w2.reason || '未知原因') + '。可以手动访问 ' + u2)
        };
    }

    if (action === 'loadurl') {
        // 往预览窗口里加载任意 URL。诊断用（比如加载空白页看窗口本身是否正常）。
        var w3 = global.__mcpPreviewWindow;
        if (!w3 || w3.isDestroyed()) throw new Error('预览窗口没开。先 preview_control start');
        var target = String(args.url || 'about:blank');
        w3.webContents.loadURL(target);
        return { loaded: target, note: '已加载 ' + target };
    }

    if (action === 'bridge') {
        // 桥接状态：预览页连上了没、日志有多少
        var report = bridgeState.lastReport;
        return {
            connected: bridgeState.connected,
            lastAt: bridgeState.lastAt,
            ageMs: bridgeState.lastAt ? (Date.now() - bridgeState.lastAt) : null,
            scene: report ? report.scene : null,
            frame: report ? report.frame : null,
            fps: report ? report.fps : null,
            url: report ? report.url : null,
            logTotal: bridgeState.logSeq,
            errorTotal: bridgeState.errors.length,
            pendingCommands: bridgeState.commands.length,
            hasWindow: !!(previewWindow && !previewWindow.isDestroyed()),
            hint: !bridgeState.connected
                ? '预览页还没连上。确认 preview_control start 成功、窗口已打开、' +
                  '并且预览页能访问 127.0.0.1:' + (listeningPort || 0)
                : null
        };
    }

    // status：直接探端口。探静态路径而不是根路径——根路径是 EJS 渲染的，
    // 编辑器进程自己发请求时可能返回 500，但静态路径能真实反映服务状态。
    var port = ps._previewPort;
    var url = 'http://127.0.0.1:' + port + '/';
    var staticUrl = 'http://127.0.0.1:' + port + '/preview-scripts/__quick_compile__.js';

    return probeHttp(staticUrl, 3000).then(function (r) {
        return {
            running: !!r.ok,
            port: port,
            url: url,
            // 引擎预览（不需要 build）
            enginePreviewUrl: url,
            // 构建产物（需要 build）
            buildUrl: 'http://127.0.0.1:' + port + '/build/index.html',
            status: r.status || null,
            bridgeConnected: bridgeState.connected,
            hasWindow: !!(previewWindow && !previewWindow.isDestroyed()),
            lastError: r.ok ? null : (r.error || 'no response'),
            hint: r.ok ? null
                : '预览服务没在响应。先 preview_control start —— ' +
                  '引擎预览不需要 build，只要编辑器在跑就行'
        };
    });
}


//#endregion

//#region 中继（hub）

var HUB_DEFAULT_PORT = 25800;

function hubStateFile() {
    return path.join(os.homedir(), '.CocosCreator', PKG_NAME, 'hub.json');
}

function readHubState() {
    // 测试模式用假状态，别读/写真实的中继进程记录
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') {
        return { pid: 99999, port: HUB_DEFAULT_PORT, startedAt: new Date().toISOString(), mock: true };
    }
    try {
        return JSON.parse(fs.readFileSync(hubStateFile(), 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeHubState(s) {
    try {
        fs.mkdirSync(path.dirname(hubStateFile()), { recursive: true });
        fs.writeFileSync(hubStateFile(), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) { /* 忽略 */ }
}

function probeHub(port) {
    return new Promise(function (resolve) {
        var http = require('http');
        var req = http.get({ host: '127.0.0.1', port: port, path: '/status', timeout: 2000 }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                try {
                    resolve({ ok: true, status: res.statusCode, info: JSON.parse(data) });
                } catch (e) {
                    resolve({ ok: true, status: res.statusCode, info: null });
                }
            });
        });
        req.on('error', function (e) { resolve({ ok: false, error: e.code || e.message }); });
        req.on('timeout', function () { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
}

/**
 * 中继服务的开启/关闭/状态。
 *
 * 中继是独立于编辑器的常驻进程，固定占一个端口，mcp.json 指向它。
 * 这样不管开几个编辑器、也不管客户端连的那个编辑器在不在，
 * AI 都能通过 target 找到真正要操作的项目。
 */
function toolHubControl(args) {
    var action = String(args.action || 'status').toLowerCase();
    var port = args.port ? parseInt(args.port, 10) : HUB_DEFAULT_PORT;

    if (action === 'start') {
        var existing = readHubState();
        if (existing && existing.pid && existing.port === port) {
            return probeHub(port).then(function (r) {
                if (r.ok) {
                    return {
                        started: true,
                        alreadyRunning: true,
                        port: port,
                        url: 'http://127.0.0.1:' + port + '/mcp',
                        pid: existing.pid
                    };
                }
                // 记录在但实际没跑，清理后重启
                try { process.kill(existing.pid); } catch (e) { /* 已经死了 */ }
                return startHub(port);
            });
        }
        return startHub(port);
    }

    if (action === 'stop') {
        var st = readHubState();

        // 测试模式下不许碰真的中继进程
        if (process.env.COCOS_MCP_NO_REGISTRY === '1') {
            return { stopped: true, pid: st ? st.pid : null, note: '测试模式，没有真的停进程' };
        }

        if (!st || !st.pid) return { stopped: false, note: '没有记录到运行中的中继' };

        var killed = true;
        try {
            process.kill(st.pid);
        } catch (e) {
            killed = false;
        }
        writeHubState({ pid: null, port: null, stoppedAt: new Date().toISOString() });
        return { stopped: killed, pid: st.pid, port: st.port, note: killed ? '中继已停止' : '进程已经不在了' };
    }

    // status
    var state = readHubState();
    return probeHub(port).then(function (r) {
        return {
            running: !!r.ok,
            port: port,
            url: 'http://127.0.0.1:' + port + '/mcp',
            pid: state ? state.pid : null,
            info: r.info || null,
            lastError: r.ok ? null : (r.error || 'no response'),
            hint: r.ok
                ? '把 mcp.json 的 url 指到这个地址，之后用 set_target_project 决定操作哪个项目'
                : '中继没在跑，用 hub_control start 开启'
        };
    });
}

/**
 * 扩展启动时把中继拉起来。
 * 中继是独立进程，编辑器关了它还在；多开编辑器时它负责把请求转到目标项目。
 * 这样客户端连的那个编辑器在不在都不影响 AI 干活。
 */
/**
 * 启动时自动注入运行时上报（静默）。
 *
 * 用户的要求："当我选择在这个项目启动 MCP 的时候自动注入即可" ——
 * 不用手动跑 runtime_inject，也不用改项目代码。
 *
 * 注入的是构建产物（build/ 目录），不是项目源码，所以：
 *   - 项目源码一个字节都不动
 *   - 只改 index.html，带哈希的资源文件不动
 *   - 撤销很容易（runtime_inject remove）
 */
function ensureRuntimeInjected() {
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') return;
    if (typeof Editor === 'undefined') return;

    var root = projectRoot();
    if (!root) return;

    var buildRoot = path.join(root, 'build');
    if (!statSafe(buildRoot)) return;

    try {
        var injector = require('./injector.js');
        var dests = injector.findWebDests(buildRoot);
        if (!dests.length) return;

        // 注入脚本要往哪报？客户端连的是中继（mcp.json 指 25800），
        // 那就报给中继 —— 中继会把 /runtime-report 转给目标项目的扩展实例。
        // 中继不在（比如直接连扩展端口），就报给自己的端口。
        var reportPort = listeningPort;
        probeHub(HUB_DEFAULT_PORT).then(function (r) {
            if (r.ok) reportPort = HUB_DEFAULT_PORT;
            applyInjectionTo(dests, injector, reportPort, root);
        }, function () {
            applyInjectionTo(dests, injector, reportPort, root);
        });
    } catch (e) {
        // 注入失败不影响 MCP 主功能
        try { Editor.warn(LOG, '运行时上报注入失败：' + (e.message || e)); } catch (e2) { /* 忽略 */ }
    }
}

/** 真正执行注入（端口确定后） */
function applyInjectionTo(dests, injector, reportPort, root) {
    var injected = 0;
    for (var i = 0; i < dests.length; i++) {
        var r = injector.applyInjection(dests[i], {
            selfDir: __dirname,
            port: reportPort,
            project: path.basename(root),
            interval: 2000
        });
        if (r.injected) injected++;
    }
    if (injected) {
        Editor.log(LOG, '运行时上报已注入 ' + injected + ' 个构建产物（只改了 index.html）');
        Editor.log(LOG, '  浏览器打开游戏后状态会自动上报到端口 ' + reportPort +
            '，用 runtime_browser_report 读');
    }
}

function ensureHubRunning() {
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') return;
    if (typeof Editor === 'undefined') return;

    probeHub(HUB_DEFAULT_PORT).then(function (r) {
        if (r.ok) return;
        startHub(HUB_DEFAULT_PORT).then(function (res) {
            if (res.started) {
                Editor.log(LOG, '中继服务已自动开启 → ' + res.url);
                Editor.log(LOG, '  把 mcp.json 的 url 指到这个地址，之后用 set_target_project 决定操作哪个项目');
            }
        }, function () { /* 起不来就算了，不影响主服务 */ });
    }, function () { /* 探测失败就当没开 */ });
}

function startHub(port) {
    var cp = require('child_process');
    var script = path.join(__dirname, 'hub.js');

    if (!statSafe(script)) {
        throw new Error('找不到 hub.js：' + script);
    }

    // 测试模式下别真的起进程
    if (process.env.COCOS_MCP_NO_REGISTRY === '1') {
        writeHubState({ pid: null, port: port, startedAt: new Date().toISOString(), mock: true });
        return Promise.resolve({
            started: true,
            alreadyRunning: false,
            port: port,
            url: 'http://127.0.0.1:' + port + '/mcp',
            pid: null,
            note: '测试模式，没有真的起进程'
        });
    }

    // 编辑器里 process.execPath 是 CocosCreator.exe，不是 node，直接跑会把编辑器又拉起来一个。
    // Electron 的 ELECTRON_RUN_AS_NODE=1 能让它当纯 node 用，不依赖系统装了 node。
    var env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    var child = cp.spawn(process.execPath, [script, String(port)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: env
    });
    child.unref();

    writeHubState({
        pid: child.pid,
        port: port,
        startedAt: new Date().toISOString()
    });

    // 等它起来
    return new Promise(function (resolve) {
        var tries = 0;
        var iv = setInterval(function () {
            tries++;
            probeHub(port).then(function (r) {
                if (r.ok) {
                    clearInterval(iv);
                    resolve({
                        started: true,
                        alreadyRunning: false,
                        port: port,
                        url: 'http://127.0.0.1:' + port + '/mcp',
                        pid: child.pid,
                        info: r.info || null
                    });
                    return;
                }
                if (tries > 25) {
                    clearInterval(iv);
                    resolve({
                        started: false,
                        port: port,
                        pid: child.pid,
                        error: '中继启动了但 5 秒内没响应',
                        hint: '看 hub 的输出，或用 hub_control status 再查一次'
                    });
                }
            });
        }, 200);
    });
}

//#endregion

//#region 工具实现

function toolGetProjectInfo() {
    var root = projectRoot();
    if (!root) throw new Error('项目未打开');

    var info = { path: root, name: path.basename(root) };

    // 版本信息在 project.json 里
    var pj = path.join(root, 'project.json');
    if (statSafe(pj)) {
        try {
            var p = JSON.parse(fs.readFileSync(pj, 'utf8'));
            info.version = p.version;
            info.engine = p.engine;
        } catch (e) { /* 读不到就算了 */ }
    }

    // 场景列表
    info.scenes = [];
    var sceneDir = path.join(root, 'assets');
    if (statSafe(sceneDir)) {
        walkFiles(sceneDir, { maxDepth: 6, skip: SKIP_DIRS }, function (full, name) {
            if (name.slice(-5) === '.fire') info.scenes.push(relPath(full));
        });
        info.scenes.sort();
    }

    // uuid 索引规模，顺手确认 assets 扫得到
    try {
        var idx = buildUuidIndex(false);
        info.assetCount = idx.count;
    } catch (e) {
        info.assetCount = null;
    }

    info.mcpPort = listeningPort;
    info.mcpUrl = 'http://127.0.0.1:' + listeningPort + '/mcp';

    // 多开时 AI 最需要知道的一件事：现在实际操作的是哪个项目
    var target = resolveTarget();
    info.target = target;
    // isTarget 看项目身份，不看端口 —— 端口会随编辑器重启互换
    info.isTarget = !!(target && target.online && sameProjectPath(target.project, info.path));
    info.operatingProject = info.isTarget ? info.name : (target ? target.name : info.name);
    if (lastForwardError) {
        info.forwardError = lastForwardError;
        info.hint = '目标项目连不上，已退回本地处理。要切项目用 set_target_project';
    } else if (target && !target.online) {
        info.hint = '目标项目 ' + (target.name || '?') + ' 当前没打开，已退回本地处理';
    } else if (!info.isTarget && target) {
        info.hint = '当前实例是 ' + info.name + '，但目标项目是 ' + target.name + '，调用会被转发过去';
    }

    return info;
}

function toolListDir(args) {
    var abs = safePath(args.path || '.');
    var st = statSafe(abs);
    if (!st) throw new Error('目录不存在：' + args.path);
    if (!st.isDirectory()) throw new Error('不是目录：' + args.path);

    var items = fs.readdirSync(abs);
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var name = items[i];
        var full = path.join(abs, name);
        var s = statSafe(full);
        if (!s) continue;
        out.push({
            name: name,
            dir: s.isDirectory(),
            size: s.isDirectory() ? 0 : s.size
        });
    }
    out.sort(function (a, b) {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name < b.name ? -1 : 1;
    });
    return { path: relPath(abs), count: out.length, items: out };
}

function toolSearchFiles(args) {
    var t0 = Date.now();
    if (!args.pattern) throw new Error('缺少 pattern');

    var base = safePath(args.path || 'assets');
    var st = statSafe(base);
    if (!st) throw new Error('路径不存在：' + (args.path || 'assets'));

    var flags = args.ignoreCase === false ? '' : 'i';
    var src = args.useRegex ? args.pattern : escapeRegExp(args.pattern);
    var re;
    try {
        re = new RegExp(src, flags);
    } catch (e) {
        throw new Error('正则无效：' + e.message);
    }

    var maxResults = typeof args.maxResults === 'number' ? args.maxResults : 80;
    if (maxResults < 1) maxResults = 80;
    if (maxResults > 300) maxResults = 300;

    var ctx = typeof args.context === 'number' ? args.context : 0;
    if (ctx < 0) ctx = 0;
    if (ctx > 5) ctx = 5;

    var globRaw = args.glob ? String(args.glob) : null;
    var globRe = globRaw ? globToRegExp(globRaw) : null;
    var globByPath = globRaw ? globRaw.indexOf('/') >= 0 : false;
    var includeMeta = args.includeMeta === true;

    var candidates = [];
    function pushCandidate(full, name) {
        if (!includeMeta && name.slice(-5) === '.meta') return;
        if (globRe) {
            var target = globByPath ? relPath(full) : name;
            if (!globRe.test(target)) return;
        }
        candidates.push({ full: full, name: name });
    }

    if (st.isDirectory()) {
        walkFiles(base, { maxDepth: 30, skip: SKIP_DIRS }, function (full, name, s) {
            if (s.size > MAX_SEARCH_BYTES) return;
            pushCandidate(full, name);
        });
    } else {
        pushCandidate(base, path.basename(base));
    }

    candidates.sort(function (a, b) { return a.full < b.full ? -1 : (a.full > b.full ? 1 : 0); });

    var matches = [];
    var scanned = 0;
    var matchedFiles = 0;
    var total = 0;

    for (var i = 0; i < candidates.length; i++) {
        var f = candidates[i];
        var buf;
        try {
            buf = fs.readFileSync(f.full);
        } catch (e) {
            continue;
        }
        // 二进制文件里出现 \0 就当它不是文本
        if (buf.slice(0, 4096).toString('binary').indexOf('\u0000') >= 0) continue;
        scanned++;

        var text = buf.toString('utf8');
        if (text.indexOf('\ufeff') === 0) text = text.slice(1);
        var lines = text.split(/\r?\n/);
        var fileHit = 0;

        for (var L = 0; L < lines.length; L++) {
            if (!re.test(lines[L])) continue;
            total++;
            fileHit++;
            // 统计照做，只限制返回条数，这样 truncated 不会在"刚好装满"时误报
            if (matches.length >= maxResults) continue;
            var item = {
                file: relPath(f.full),
                line: L + 1,
                text: lines[L].length > MAX_LINE_CHARS
                    ? lines[L].slice(0, MAX_LINE_CHARS) + ' …'
                    : lines[L]
            };
            if (ctx > 0) {
                item.before = lines.slice(Math.max(0, L - ctx), L);
                item.after = lines.slice(L + 1, Math.min(lines.length, L + 1 + ctx));
            }
            matches.push(item);
        }
        if (fileHit > 0) matchedFiles++;
    }

    return {
        pattern: args.pattern,
        root: relPath(base),
        scannedFiles: scanned,
        matchedFiles: matchedFiles,
        totalMatches: total,
        returned: matches.length,
        truncated: total > matches.length,
        tookMs: Date.now() - t0,
        matches: matches
    };
}

function toolReadFile(args) {
    if (!args.path) throw new Error('缺少 path');
    var abs = safePath(args.path);
    var st = statSafe(abs);
    if (!st) throw new Error('文件不存在：' + args.path + '。用 list_dir 看目录结构、search_files 搜文件名来定位（别靠猜路径）。');
    if (st.isDirectory()) throw new Error('这是目录不是文件：' + args.path);
    if (st.size > MAX_READ_BYTES) {
        throw new Error('文件过大（' + Math.round(st.size / 1024) + 'KB），拒绝读取');
    }
    return fs.readFileSync(abs, 'utf8');
}

function toolWriteFile(args) {
    if (!args.path) throw new Error('缺少 path');
    if (typeof args.content !== 'string') throw new Error('content 必须是字符串');
    var abs = safePath(args.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    var content = args.content;
    var crlf = false;
    var existed = false;
    var old = null;
    try {
        old = fs.readFileSync(abs, 'utf8');
        existed = true;
        crlf = old.indexOf('\r\n') >= 0;
    } catch (e) { /* 新文件 */ }

    var lower = abs.toLowerCase();
    var extra = {};

    // ── .prefab：整文件覆盖前先做结构校验 ──
    // 悬空 __id__、缺 _prefab、fileId 重复这些错误编辑器导入时**不报**，
    // 要到运行时才显形，到那时已经很难定位了。所以宁可在写之前拦住。
    if (lower.slice(-7) === '.prefab') {
        var arr;
        try {
            arr = JSON.parse(content);
        } catch (e) {
            throw new Error('这个 .prefab 的内容不是合法 JSON（' + e.message + '）。' +
                '整文件必须是一个 JSON 数组；手改请用 edit_file 只动一段，别整文件重写。');
        }
        assertPrefabArray(arr, relPath(abs));

        // 覆盖已有预制体时保住节点身份：fileId 全变会让已有场景里的实例对不回原节点
        if (existed && old) {
            var oldArr = null;
            try { oldArr = JSON.parse(old); } catch (e2) { oldArr = null; }
            if (Array.isArray(oldArr) && oldArr[0] && oldArr[0].__type__ === 'cc.Prefab') {
                var reused = stabilizePrefabFileIds(arr, oldArr);
                if (reused > 0) {
                    content = JSON.stringify(arr, null, 2);
                    extra.fileIdReused = reused;
                }
            }
        }
    }

    // 保留原文件的换行风格。
    // 很多项目（尤其经过 git autocrlf 的）源码是 CRLF，
    // 硬写成 LF 会让整个文件每一行都变 —— git diff 直接变成全量重写，版本历史就废了。
    if (crlf && content.indexOf('\r\n') < 0) {
        content = content.replace(/\r?\n/g, '\r\n');
    } else if (!crlf && content.indexOf('\r\n') >= 0) {
        content = content.replace(/\r\n/g, '\n');
    }

    fs.writeFileSync(abs, content, 'utf8');
    var st = statSafe(abs);
    markDirty(relPath(abs));

    var out = {
        path: relPath(abs),
        bytes: st ? st.size : content.length,
        newline: crlf ? 'CRLF（沿用原文件）' : 'LF',
        created: !existed,
        hint: abs.slice(-5) === '.fire' || abs.slice(-7) === '.prefab'
            ? '已写入并记入待刷新列表；调用 refresh_assets（不传参）会自动刷掉这些目录'
            : '已写入'
    };
    if (lower.slice(-7) === '.prefab') {
        out.prefabValidated = true;
        if (extra.fileIdReused) out.fileIdReused = extra.fileIdReused;
    }

    // 整个文件重写 .fire/.prefab 时也要记账并报编辑器状态 —— 这条路径和 scene_* 一样危险
    if (abs.slice(-5) === '.fire' || abs.slice(-7) === '.prefab') {
        var ed = noteFileWrite(abs, { tool: 'write_file' });
        if (ed) {
            out.editor = ed;
            if (ed.openInEditor) {
                out.hint = '已写入，但编辑器正开着它 —— 调 editor_sync {action:"reload"} 让它跟上，' +
                    '否则你在编辑器里保存时会覆盖掉这次改动';
            }
        }
    }
    return out;
}

/**
 * 精确编辑文件里的某一段。
 *
 * 为什么需要它：AI 改代码最常见的是"把这一段换成那一段"，
 * 用 write_file 得先读全文再拼回去 —— 大文件上浪费上下文，
 * 而且中间任何一步出错都可能把文件写坏。
 * edit_file 只动匹配到的那一段，其余字节一个不动。
 *
 * args:
 *   path      必填
 *   oldText   要替换的原文（不填则用 newText 追加到末尾）
 *   newText   新内容
 *   all       是否替换全部匹配（默认只替换第一处）
 *   regex     oldText 当正则处理
 *   count     期望的匹配数 —— 不符就拒绝写入（防手滑）
 */
function toolEditFile(args) {
    if (!args.path) throw new Error('缺少 path');
    var abs = safePath(args.path);
    if (!statSafe(abs)) throw new Error('文件不存在：' + args.path + '。用 list_dir 看目录结构、search_files 搜文件名来定位（别靠猜路径）。');
    if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
        throw new Error('oldText 和 newText 都必须是字符串');
    }

    var original = fs.readFileSync(abs, 'utf8');

    var matches = [];
    var result = original;

    if (args.regex) {
        var re;
        try {
            re = new RegExp(args.oldText, args.all ? 'g' : '');
        } catch (e) {
            throw new Error('正则语法错误：' + e.message);
        }
        var m;
        var scan = original;
        var idx = 0;
        while ((m = re.exec(scan)) !== null) {
            matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
            if (!args.all) break;
            if (m.index === re.lastIndex) re.lastIndex++;
            void idx;
        }
        if (matches.length) {
            matches.forEach(function (m) { m.text = m.text || original.slice(m.start, m.end); });
            // 从后往前替换，避免前面的替换影响后面的偏移
            for (var i = matches.length - 1; i >= 0; i--) {
                result = result.slice(0, matches[i].start) + args.newText + result.slice(matches[i].end);
            }
        }
    } else {
        var pos = original.indexOf(args.oldText);
        if (pos >= 0) {
            matches.push({
                start: pos,
                end: pos + args.oldText.length,
                text: args.oldText
            });
            if (args.all) {
                // 全部替换：反复找，但要从后往前
                var all = [];
                var p = original.indexOf(args.oldText);
                while (p >= 0) {
                    all.push({
                        start: p,
                        end: p + args.oldText.length,
                        text: args.oldText
                    });
                    p = original.indexOf(args.oldText, p + args.oldText.length);
                    if (!args.oldText.length) break;
                }
                matches = all;
                for (var j = all.length - 1; j >= 0; j--) {
                    result = result.slice(0, all[j].start) + args.newText + result.slice(all[j].end);
                }
            } else {
                result = original.slice(0, pos) + args.newText + original.slice(pos + args.oldText.length);
            }
        }
    }

    if (!matches.length) {
        throw new Error(
            '没找到要替换的内容。oldText 必须在文件里**逐字符**一致' +
            '（注意空格、缩进、换行符）。' +
            '文件共 ' + original.length + ' 字符，前 200 字符是：\n' +
            original.slice(0, 200)
        );
    }

    // 期望匹配数校验 —— 防手滑
    if (typeof args.count === 'number' && matches.length !== args.count) {
        throw new Error(
            '匹配数不符：期望 ' + args.count + ' 处，实际 ' + matches.length + ' 处。' +
            '已放弃写入（文件没动）。'
        );
    }

    // 保留原文件换行风格
    var crlf = original.indexOf('\r\n') >= 0;
    var out = result;
    if (crlf && out.indexOf('\r\n') < 0) {
        out = out.replace(/\r?\n/g, '\r\n');
    } else if (!crlf && out.indexOf('\r\n') >= 0) {
        out = out.replace(/\r\n/g, '\n');
    }

    fs.writeFileSync(abs, out, 'utf8');
    markDirty(relPath(abs));

    var edOut = null;
    if (abs.slice(-5) === '.fire' || abs.slice(-7) === '.prefab') {
        edOut = noteFileWrite(abs, { tool: 'edit_file' });
    }

    return {
        path: relPath(abs),
        replaced: matches.length,
        bytesBefore: Buffer.byteLength(original, 'utf8'),
        bytesAfter: Buffer.byteLength(out, 'utf8'),
        newline: crlf ? 'CRLF（沿用原文件）' : 'LF',
        preview: (matches[0].text !== undefined ? matches[0].text : '').slice(0, 200),
        editor: edOut && edOut.openInEditor ? edOut : undefined,
        hint: '只替换了匹配到的那几段，其余字节未动；已记入待刷新列表'
    };
}

function toolQuerySceneTree(args) {
    if (!args.path) throw new Error('缺少 path');
    var abs = safePath(args.path);
    if (!statSafe(abs)) throw new Error('文件不存在：' + args.path + '。用 list_dir 看目录结构、search_files 搜文件名来定位（别靠猜路径）。');

    var arr = loadSerialized(abs);
    var rootId = findRootIndex(arr);
    var maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 20;
    var idx = buildUuidIndex(false);

    var startId = rootId;
    if (args.node) {
        var rnf = resolveNode(arr, rootId, args.node);
        if (rnf.id === null) {
            if (rnf.how === 'ambiguous') throw new Error('有 ' + rnf.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
            throw nodeNotFoundError(arr, rootId, args.node);
        }
        var found = rnf.id;
        if (found === null || found === undefined || found < 0) {
            throw new Error('找不到节点：' + args.node);
        }
        startId = found;
    }

    var tree = expandNode(arr, startId, 0, maxDepth, idx);

    var out = {
        path: relPath(abs),
        totalObjects: arr.length,
        nodeCount: tree ? countNodes(tree) : 0,
        rootId: startId,
        tree: tree
    };

    // detail：等价于原来的 read_scene_node —— 单节点的完整序列化值。
    // 放在同一个工具里是因为它和"看树"是同一个解析动作，只差展开深度。
    if (args.node && (args.detail === true || typeof args.depth === 'number')) {
        out.detail = toolReadSceneNode({
            path: args.path,
            node: args.node,
            depth: args.depth
        });
    }
    return out;
}

function toolReadSceneNode(args) {
    if (!args.path) throw new Error('缺少 path');
    if (!args.node) throw new Error('缺少 node');

    var abs = safePath(args.path);
    if (!statSafe(abs)) throw new Error('文件不存在：' + args.path + '。用 list_dir 看目录结构、search_files 搜文件名来定位（别靠猜路径）。');

    var arr = loadSerialized(abs);
    var rootId = findRootIndex(arr);
    var idx = buildUuidIndex(false);

    var rn = resolveNode(arr, rootId, args.node);
    if (rn.id === null) {
        if (rn.how === 'ambiguous') throw new Error('有 ' + rn.count + ' 个节点叫"' + args.node + '"，请写完整路径。');
        throw nodeNotFoundError(arr, rootId, args.node);
    }
    var id = rn.id;

    var depth = typeof args.depth === 'number' ? args.depth : 3;
    if (depth < 0) depth = 0;
    if (depth > 6) depth = 6;

    var obj = arr[id];
    var out = {
        path: relPath(abs),
        id: id,
        type: obj.__type__,
        name: obj._name || (obj.__type__ === 'cc.Scene' ? 'Scene' : ''),
        active: obj._active,
        position: readTRS(obj),
        scale: readScaleTRS(obj),
        rotationZ: readRotationTRS(obj),
        size: obj._contentSize || null,
        anchor: obj._anchorPoint || null,
        color: obj._color || null,
        opacity: obj._opacity,
        layer: obj._layer,
        children: [],
        components: []
    };

    var kids = obj._children || [];
    for (var i = 0; i < kids.length; i++) {
        var kid = arr[kids[i] && kids[i].__id__];
        if (kid) out.children.push({ id: kids[i].__id__, name: kid._name || '', active: kid._active });
    }

    var comps = obj._components || [];
    for (var c = 0; c < comps.length; c++) {
        var cid = comps[c] && comps[c].__id__;
        var comp = arr[cid];
        if (!comp) continue;
        var desc = describeComponentType(comp.__type__, idx);
        var entry = {
            id: cid,
            type: comp.__type__,
            enabled: comp._enabled !== false
        };
        if (desc.isScript) {
            entry.script = desc.script || null;
            entry.className = desc.className || null;
        }
        entry.props = dumpProps(arr, comp, depth, idx);
        out.components.push(entry);
    }

    return out;
}

/**
 * 查一张图片的 **sprite-frame** uuid —— 这个才是能填进 prefab 里
 * Sprite 组件 `_spriteFrame` 的值。
 *
 * 为什么单独开这个工具：
 *   一张 png 有两个 uuid：
 *     - 主 uuid（texture）      —— 是"这张图"这个资源
 *     - subMeta uuid（sprite-frame）—— 是"这张图里的这一块"（单图时尺寸相同）
 *   prefab 里 `_spriteFrame` 要的是**后者**。填了前者会报
 *   "spriteFrame.textureLoaded is not a function"（渲染时炸）。
 *
 * payload: { path: 'assets/xxx/yyy.png' }   也接受不给 path 时列全部 sprite-frame
 */
function toolResolveSpriteFrame(args) {
    var root = projectRoot();
    if (!root) throw new Error('项目未打开');

    var idx = buildUuidIndex(false);

    // 不给 path → 列出所有 sprite-frame（可能很多，截断）
    if (!args.path) {
        var all = [];
        for (var u in idx.byKind) {
            if (!Object.prototype.hasOwnProperty.call(idx.byKind, u)) continue;
            if (idx.byKind[u] !== 'sprite-frame') continue;
            all.push({
                uuid: u,
                compressed: compressUuid(u),
                path: idx.byFull[u]
            });
            if (all.length >= 200) break;
        }
        return {
            count: all.length,
            truncated: all.length >= 200,
            items: all,
            note: '这些 uuid 可以直接填进 prefab 的 Sprite 组件 _spriteFrame'
        };
    }

    var rel = String(args.path).trim();
    var abs = safePath(rel);
    var meta = abs + '.meta';
    if (!statSafe(meta)) {
        // 也许传的是没带后缀的
        if (statSafe(abs + '.png.meta')) { meta = abs + '.png.meta'; abs = abs + '.png'; }
        else throw new Error('找不到这个资源：' + rel + '。用 list_dir 看目录、search_files 搜文件名来定位（别靠猜路径）。');
    }

    var txt;
    try {
        txt = fs.readFileSync(meta, 'utf8');
    } catch (e) {
        throw new Error('读不了 meta：' + meta);
    }

    var mainM = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(txt);
    var mainUuid = mainM ? mainM[1] : null;

    // 找 subMetas 里的 sprite-frame
    var frames = [];
    var smRe = /"subMetas"\s*:\s*\{([\s\S]*?)\n(\s*)\}/g;
    var sm;
    while ((sm = smRe.exec(txt)) !== null) {
        var body = sm[1];
        var entryRe = /"([A-Za-z0-9_\-]+)"\s*:\s*\{([\s\S]*?)\n\s*\}/g;
        var em;
        while ((em = entryRe.exec(body)) !== null) {
            var key = em[1];
            var ebody = em[2];
            var uM = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(ebody);
            var iM = /"importer"\s*:\s*"([^"]+)"/.exec(ebody);
            if (!uM) continue;
            frames.push({
                name: key,
                uuid: uM[1],
                compressed: compressUuid(uM[1]),
                importer: iM ? iM[1] : null,
                isSpriteFrame: !!(iM && iM[1] === 'sprite-frame')
            });
        }
    }

    // 有些老 meta 没有 subMetas 结构，用全文扫一遍 importer=sprite-frame
    if (!frames.length) {
        var impRe = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"[\s\S]{0,300}?"importer"\s*:\s*"sprite-frame"/g;
        var im;
        while ((im = impRe.exec(txt)) !== null) {
            frames.push({
                name: null, uuid: im[1], compressed: compressUuid(im[1]),
                importer: 'sprite-frame', isSpriteFrame: true
            });
        }
    }

    var spriteFrames = frames.filter(function (f) { return f.isSpriteFrame; });

    return {
        path: relPath(abs),
        mainUuid: mainUuid,
        mainUuidIsTexture: true,
        spriteFrames: spriteFrames,
        // 直接给出最常用的那个（单图 png 只有一个）
        spriteFrameUuid: spriteFrames.length ? spriteFrames[0].uuid : null,
        allSubResources: frames,
        note: '用 spriteFrameUuid 填 prefab 的 _spriteFrame；' +
              '**不要用 mainUuid**（那是 texture，填了会报 textureLoaded is not a function）'
    };
}

/**
 * 找出项目里可以用来做体检探测的文件。
 * 各项目资源结构不一样，写死路径会让别的项目全报错。
 */
function findAuditProbeFiles() {
    var out = { ts: null, prefab: null, prefabRoot: null, png: null, pngUuid: null };
    var root = projectRoot();
    if (!root) return out;
    var assetsDir = path.join(root, 'assets');
    if (!statSafe(assetsDir)) return out;

    var found = 0;
    (function walk(d, depth) {
        if (found >= 3 || depth > 6) return;
        var es;
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (var i = 0; i < es.length && found < 3; i++) {
            var p = path.join(d, es[i].name);
            if (es[i].isDirectory()) { walk(p, depth + 1); continue; }
            var rel = relPath(p);
            if (!out.ts && /\.(ts|js)$/i.test(es[i].name) && es[i].name !== 'd.ts') {
                out.ts = rel; found++;
            } else if (!out.prefab && /\.prefab$/i.test(es[i].name)) {
                out.prefab = rel; found++;
                // 顺带读出根节点名（read_scene_node 要用）
                try {
                    var arr = JSON.parse(fs.readFileSync(p, 'utf8'));
                    var ri = findRootIndex(arr);
                    if (ri >= 0 && arr[ri] && arr[ri]._name) out.prefabRoot = arr[ri]._name;
                } catch (e2) { /* 忽略 */ }
            } else if (!out.png && /\.png$/i.test(es[i].name)) {
                out.png = rel; found++;
                // 顺带拿它的主 uuid
                try {
                    var m = JSON.parse(fs.readFileSync(p + '.meta', 'utf8'));
                    if (m && m.uuid) out.pngUuid = m.uuid;
                } catch (e2) { /* 忽略 */ }
            }
        }
    })(assetsDir, 0);

    return out;
}

/**
 * 深度自检：把**有副作用**的工具也实际跑一遍。
 *
 * mcp_audit 只跑无副作用的（21 个有副作用的跳过）。
 * 这个工具补上另一半 —— 在项目 temp 下造资源、跑完删掉，不碰用户真实文件。
 *
 * 这是「离开对话后还能验证」的关键：任何时候想知道 MCP 靠不靠谱，
 * 先跑 mcp_audit（快的部分），再跑 mcp_verify_all（慢但完整）。
 *
 * payload: { only?: string[], cleanup?: boolean }
 */
function toolMcpVerifyAll(args) {
    var only = (args && args.only && args.only.length) ? args.only : null;
    var doCleanup = !(args && args.cleanup === false);

    var root = projectRoot();
    if (!root) throw new Error('项目未打开');

    var tmpRel = 'temp/__mcp_verify';
    var tmpAbs = path.join(root, tmpRel);

    // 先把上次的残留清掉 —— 免得'目标已存在'干扰验证
    try { fs.rmSync(tmpAbs, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    try { fs.mkdirSync(tmpAbs, { recursive: true }); } catch (e) { /* 忽略 */ }

    // 探测项目里真实存在的资源（动态找，不能写死路径）
    var pa = findAuditProbeFiles();

    // 有副作用的工具的试调用。全部指向临时资源或故意用不存在的参数。
    // 节点名带唯一后缀，跑完再删掉 —— 不能污染用户的场景。
    // expectFail: 这个调用**本来就该失败**（故意用不存在的参数），
    // 它的报错是预期结果，不算工具缺陷。
    var STAMP = '__McpVerify_' + Date.now().toString(36);
    // asset_move / asset_delete 只能操作 assets 下的资源。
    // 为了**不碰用户的真实资源**，先在 assets 下建一个临时目录，
    // 复制一张图进去，只动那份副本，最后整个目录删掉。
    var probeDirRel = 'assets/__mcp_probe';
    var probeDirAbs = path.join(root, probeDirRel);
    var probeFileRel = null;
    var probeSetupError = null;
    if (pa.png) {
        try {
            fs.mkdirSync(probeDirAbs, { recursive: true });
            // 复制 png 和它的 meta（meta 里的 uuid 必须换新的，否则和原图冲突）
            var srcMeta = JSON.parse(fs.readFileSync(pa.png + '.meta', 'utf8'));
            var copyName = 'probe.png';
            var copyAbs = path.join(probeDirAbs, copyName);
            fs.copyFileSync(path.join(root, pa.png), copyAbs);
            var newMeta = JSON.parse(JSON.stringify(srcMeta));
            newMeta.uuid = newUuidV4();
            if (newMeta.subMetas) {
                Object.keys(newMeta.subMetas).forEach(function (k) {
                    newMeta.subMetas[k].uuid = newUuidV4();
                });
            }
            fs.writeFileSync(copyAbs + '.meta', JSON.stringify(newMeta, null, 2), 'utf8');
            probeFileRel = probeDirRel + '/' + copyName;
        } catch (e) {
            // 别把原因吞掉 —— 告诉调用方为什么这几个工具跳过了
            probeSetupError = String(e && e.message ? e.message : e);
            probeFileRel = null;
        }
    }

    // scene_* / prefab_* 改的是**磁盘上的 .fire 文件**。
    // 绝不能拿用户的真实场景文件做验证 —— 一次自检就把场景搞脏，太糟糕。
    // 所以：把当前场景复制一份到 temp，所有场景类操作都指向副本。
    var sceneCopyRel = tmpRel + '/scene_copy.fire';
    var sceneCopyAbs = path.join(root, sceneCopyRel);
    var sceneCopyReady = false;
    var realSceneMd5Before = null;
    try {
        var realScene = currentSceneFile();
        if (realScene && statSafe(realScene)) {
            // 记下真实场景的 md5 —— 自检结束要核对它没变（自证没碰用户文件）
            realSceneMd5Before = crypto.createHash('md5').update(fs.readFileSync(realScene)).digest('hex');
            fs.copyFileSync(realScene, sceneCopyAbs);
            sceneCopyReady = true;
        }
    } catch (e) { sceneCopyReady = false; }

    var cases = [
        ['write_file', { path: tmpRel + '/demo.ts', content: 'export const x = 1;\n' }],
        ['edit_file', { path: tmpRel + '/demo.ts', oldText: 'x = 1', newText: 'x = 2' }],
        ['refresh_assets', { path: 'db://assets/' }],
        ['scene_create', { path: tmpRel + '/verify_' + STAMP + '.fire' }],
        ['prefab', { cmd: 'create', from: 'node', node: 'Canvas', prefab: tmpRel + '/out_' + STAMP + '.prefab', scene: sceneCopyRel }],
        ['scene_edit', { cmd: 'add-node', from: 'prefab', prefab: tmpRel + '/out_' + STAMP + '.prefab', parent: 'Canvas', name: STAMP + '_pf', path: sceneCopyRel }],
        ['scene_edit', { cmd: 'add-node', parent: 'Canvas', name: STAMP, path: sceneCopyRel }],
        ['scene_edit', { cmd: 'set-props', node: STAMP, position: { x: 1, y: 2, z: 3 }, path: sceneCopyRel }],
        ['scene_edit', { cmd: 'move-node', node: STAMP, newParent: 'Canvas', path: sceneCopyRel }],
        ['scene_edit', { cmd: 'remove-node', node: STAMP, path: sceneCopyRel }],
        ['scene_edit', { cmd: 'add-component', node: 'Canvas', type: 'cc.Label', path: sceneCopyRel }],
        ['scene_edit', { cmd: 'remove-component', node: 'Canvas', type: 'cc.Label', path: sceneCopyRel }],
        ['scene_edit', { cmd: 'set-component-props', node: 'Canvas', type: 'cc.Canvas', props: { _priority: 1 }, path: sceneCopyRel }],
        // 从零造预制体：建在探测目录里，跑完整个目录一起删
        ['prefab', probeFileRel ? {
            cmd: 'create',
            path: probeDirRel + '/spec_' + STAMP + '.prefab',
            root: {
                name: 'ProbeRoot',
                size: [200, 100],
                children: [{ name: 'child', size: [40, 40], pos: [10, 10], label: 'hi' }]
            }
        } : null],
        ['prefab', probeFileRel ? { cmd: 'check-layout', path: probeDirRel + '/spec_' + STAMP + '.prefab' } : null],
        ['prefab', probeFileRel ? { cmd: 'diff', a: probeDirRel + '/spec_' + STAMP + '.prefab', b: probeDirRel + '/spec_' + STAMP + '.prefab' } : null],
        ['asset', probeFileRel ? { cmd: 'meta-get', path: probeFileRel } : null],
        ['asset', probeFileRel ? { cmd: 'meta-set', path: probeFileRel, props: { userData: { __mcpProbe: 1 } } } : null],
        ['asset', probeFileRel ? { cmd: 'move', from: probeFileRel, to: probeFileRel + '.moved' } : null],
        ['asset', probeFileRel ? { cmd: 'delete', path: probeFileRel + '.moved', confirm: true } : null],
        // runtime 探针用 info（只读）—— eval 依赖真实场景进程，mock Editor 下没有
        // sceneEval 处理器，放进自检只会制造假失败。
        ['runtime', { cmd: 'info' }],
        ['editor', { cmd: 'compile-status' }],
        ['build', { cmd: 'targets' }],
        ['project_settings', { cmd: 'get' }],
        ['preview', { cmd: 'control', action: 'status' }],
        ['run_script', { code: 'return 1 + 1;' }],
        // 旧名转发链也要真跑一遍：v0.8.0 的旧名（1 跳）和 v0.4.0 的旧名（2 跳）
        ['scene_add_node', { parent: 'Canvas', name: STAMP + '_legacy', path: sceneCopyRel }],
        ['prefab_instantiate', { prefab: tmpRel + '/out_' + STAMP + '.prefab', parent: 'Canvas', name: STAMP + '_legacy2', path: sceneCopyRel }],
        // 下面两个是故意用不存在的名字/平台 —— 报错是预期结果，任何环境下都该失败
        ['set_target_project', { name: '__不存在的项目__' }, true],
        ['project_settings', { cmd: 'set', settings: { 'design-resolution-width': 750 } }],
        // build{cmd:"start"} 传的是不存在的平台名，本来就该报错。
        // 真构建太慢（几分钟），自检不跑 —— 需要验证构建时手工跑这个 cmd。
        ['build', { cmd: 'start', platform: '__不存在的平台__' }, true]
    ];

    if (only) {
        cases = cases.filter(function (c) { return only.indexOf(c[0]) >= 0; });
    }

    var results = [];

    var chain = Promise.resolve();
    cases.forEach(function (c) {
        chain = chain.then(function () {
            var name = c[0], a = c[1], expectFail = !!c[2];
            if (!a) {
                results.push({
                    name: name,
                    skipped: probeSetupError
                        ? ('探测资源准备失败：' + probeSetupError)
                        : '这个项目里找不到可用的探测资源'
                });
                return;
            }
            // 场景类用例需要场景副本 —— 建不起来就跳过（不是工具坏了）。
            // prefab{cmd:"create", from:"spec"} 不需要场景（直接造），只有 from:"node" 才要。
            // prefab_instantiate 是 v0.4.0 旧名，转发后也是往场景里塞节点。
            var isSceneCase = /^scene_/.test(name) || name === 'prefab_instantiate' ||
                (name === 'prefab' && a && a.cmd === 'create' && a.from === 'node');
            if (isSceneCase && !sceneCopyReady) {
                results.push({
                    name: name,
                    skipped: '这个项目没有打开的场景文件（currentSceneFile 拿不到），' +
                        '场景类用例需要场景副本，跳过'
                });
                return;
            }
            return Promise.resolve()
                .then(function () { return callTool(name, a); })
                .then(function (r) {
                    var item = { name: name, ok: true };
                    if (expectFail) {
                        // 本来就该失败 —— 居然成功了才是问题
                        item.unexpectedSuccess = true;
                        item.issue = '这个调用本来该失败（故意传了不存在的参数），却成功了';
                    }
                    if (typeof r === 'string') {
                        item.shape = 'text';
                        item.length = r.length;
                        item.note = r.slice(0, 80);
                    } else {
                        item.shape = 'json';
                        item.__status = r.__status || '(无 __status)';
                        if (r.__emptyFields && r.__emptyFields.length) {
                            item.emptyFields = r.__emptyFields;
                        }
                    }
                    results.push(item);
                })
                .catch(function (e) {
                    var msg = String(e && e.message ? e.message : e);
                    var item = { name: name, ok: !expectFail };
                    item.error = msg;
                    item.__rawMsg = msg.slice(0, 120);
                    // 这个工具本来就是深度自检 —— 错误信息质量一律要查
                    item.errorHasGuidance = errorHasGuidance(msg);
                    if (expectFail) {
                        // 预期失败 —— 报错本身不是缺陷，但错误信息质量还是要查
                        item.expectedFailure = true;
                    } else {
                        item.unexpectedFailure = true;
                    }
                    if (!item.errorHasGuidance) item.issue = '错误信息没说下一步该怎么做';
                    results.push(item);
                });
        });
    });

    return chain.then(function () {
        // 清理：所有场景类操作都在**副本**上做（sceneCopyRel），
        // 所以这里只需要删掉临时目录 —— 用户的真实场景文件一个字节都没动过。
        //
        // 再加一道自证：对比操作前后的真实场景文件 md5。
        var cleaned = [];
        var leftOver = [];
        var realSceneUntouched = null;
        try {
            if (realSceneMd5Before) {
                var realScene = currentSceneFile();
                var now = realScene && statSafe(realScene)
                    ? crypto.createHash('md5').update(fs.readFileSync(realScene)).digest('hex')
                    : null;
                realSceneUntouched = (now === realSceneMd5Before);
                if (!realSceneUntouched) {
                    leftOver.push('真实场景文件在自检过程中被改动了（md5 变了）—— 这是 bug');
                }
            }
        } catch (e) {
            leftOver.push('校验真实场景文件失败：' + String(e.message || e));
        }

        if (doCleanup) {
            // temp 目录（含场景副本、验证用的 .fire/.prefab）
            // Windows 上刚写完的文件偶尔还被占着（EBUSY/EPERM），交给 fs.rm 自己重试。
            // 自检工具承诺「不留垃圾」，静默留个目录会让下一轮回归全是假失败。
            try {
                fs.rmSync(tmpAbs, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
            } catch (e) { leftOver.push('清理 ' + tmpRel + ' 失败：' + String(e.message || e)); }
            // assets 下的探测目录（连同它的 .meta）
            try { fs.rmSync(probeDirAbs, { recursive: true, force: true }); } catch (e) { leftOver.push('清理 ' + probeDirRel + ' 失败：' + String(e.message || e)); }
            try { fs.rmSync(probeDirAbs + '.meta', { force: true }); } catch (e) { leftOver.push('清理 ' + probeDirRel + '.meta 失败：' + String(e.message || e)); }
            // asset_move 可能把探测文件改成了别的名字，兜底扫一遍
            try {
                var leftovers = [];
                if (statSafe(probeDirAbs)) {
                    (function sweep(d) {
                        var es;
                        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
                        for (var i = 0; i < es.length; i++) {
                            var p = path.join(d, es[i].name);
                            if (es[i].isDirectory()) sweep(p);
                            else leftovers.push(p);
                        }
                    })(probeDirAbs);
                    leftovers.forEach(function (p) {
                        try { fs.rmSync(p, { force: true }); } catch (e) { /* 忽略 */ }
                    });
                    try { fs.rmSync(probeDirAbs, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
                }
            } catch (e) { /* 忽略 */ }
        }


        var problems = results.filter(function (r) {
            return r.issue || r.unexpectedFailure || r.unexpectedSuccess;
        });
        return {
            __status: problems.length ? 'partial' : 'ok',
            verified: results.length,
            cleanedNodes: cleaned,
            leftover: leftOver,
            realSceneUntouched: realSceneUntouched,
            usedSceneCopy: sceneCopyReady,
            problems: problems,
            items: results,
            cleanup: doCleanup ? '已清理临时目录 ' + tmpRel : '未清理（' + tmpRel + ' 还留着）',
            note: problems.length
                ? ('有 ' + problems.length + ' 个工具有问题，看 problems')
                : ('全部 ' + results.length + ' 个有副作用的工具都跑通了'),
            caveat: 'scene_* 改的是**磁盘上的 .fire 文件**，不是编辑器内存里的场景。' +
                '编辑器里打开的场景可能是旧的 —— 要看效果得重新打开场景。' +
                (cleaned.length ? '（本次已清理测试节点：' + cleaned.join(', ') + '）' : '')
        };
    });
}

/**
 * MCP 自检 —— 把所有工具实际跑一遍，检查返回值的可信度。
 *
 * 这工具是给「隔了很久再用」的场景准备的：
 * AI 拿到 MCP 后先跑一次 audit，就知道每个工具返回什么、
 * 哪些会空、哪些报错信息够不够用 —— 不用靠试错。
 *
 * payload: { only?: string[], deep?: boolean }
 *   only  只查指定的工具
 *   deep  额外检查「错误信息里有没有说下一步该怎么做」
 */

/**
 * 判断错误信息里有没有说清「下一步该怎么做」。
 * 关键词覆盖中英文的各种说法 —— 判断宽松一点，宁可放过也不误报。
 */
function errorHasGuidance(msg) {
    var s = String(msg || '');
    if (s.length < 8) return false;
    var pats = [
        /怎么办|怎么|请|先|建议|可以|需要|能用|试试|改成|写完整|用 .*_/,
        /跑|调用|检查|确认|查看|看列表|先跑|先查/,
        /list_dir|search_files|build_targets|list_open_projects|query_scene_tree|scene_remove_node|refresh_assets|mcp_audit/,
        /当前打开的|可用平台|现有|列表|名字/,
        /重启|不在 assets|本身已经写好/
    ];
    for (var i = 0; i < pats.length; i++) {
        if (pats[i].test(s)) return true;
    }
    return false;
}

/**
 * 自检用的参数表。
 *
 * 必须**动态找** —— 各项目的资源路径不一样，写死 bottle_new 的路径会让别的项目全报错。
 * 表里每个 TOOLS 的名字都得有一项（有副作用的写 null），
 * 漏了会在 mcp_selftest 的 problems 里点名，不再静默跳过。
 */
function buildAuditProbes() {
    var probeAssets = findAuditProbeFiles();
    return {
        get_project_info: {},
        list_dir: { path: 'assets' },
        search_files: { pattern: 'class' },
        read_file: probeAssets.ts ? { path: probeAssets.ts } : null,
        write_file: null,          // 有副作用，不自动跑
        edit_file: null,           // 有副作用
        query_scene_tree: probeAssets.prefab ? { path: probeAssets.prefab, maxDepth: 2 } : null,
        mcp_selftest: 'self',        // 自检不能自检自己（会递归）
        resolve_asset: probeAssets.png ? { input: probeAssets.png } : (probeAssets.pngUuid ? { input: probeAssets.pngUuid } : null),
        run_script: null,          // 有副作用（跑任意代码）
        refresh_assets: null,      // 有副作用
        list_open_projects: {},
        set_target_project: null,  // 有副作用
        hub_control: { action: 'status' },
        scene_diagnose: {},
        project_doctor: probeAssets.prefab ? { path: probeAssets.prefab } : null,
        editor_sync: { action: 'status' },
        scene_capture: null,        // 有副作用（写一张 png）
        scene_create: null,
        asset_refs: probeAssets.png ? { input: probeAssets.png } : null,
        // ---- v0.8.0 聚合入口：探针都挑无副作用的那个 cmd ----
        scene_edit: null,           // 8 个 cmd 全都写盘，自动体检不跑
        asset: { cmd: 'query', pattern: 'db://assets/**/*' },
        prefab: probeAssets.prefab ? { cmd: 'diff', a: probeAssets.prefab, b: probeAssets.prefab } : null,
        build: { cmd: 'targets' },
        project_settings: { cmd: 'get' },
        runtime: { cmd: 'info' },
        preview: { cmd: 'control', action: 'status' },
        editor: { cmd: 'log', lines: 3 }
    };
}

function toolMcpAudit(args) {
    var only = (args && args.only && args.only.length) ? args.only : null;
    var deep = !!(args && args.deep);

    var probes = buildAuditProbes();

    var results = [];
    var skipped = [];

    var names = TOOLS.map(function (t) { return t.name; });
    if (only) {
        names = names.filter(function (n) { return only.indexOf(n) >= 0; });
    }

    // 串行执行，避免并发把编辑器搞乱
    var chain = Promise.resolve();
    names.forEach(function (name) {
        chain = chain.then(function () {
            // 先查"有没有这一项"，再查"值是不是 null"。
            // 以前把两者混在一个判断里，漏登记的工具会被当成"有副作用"静默跳过 ——
            // 工具白做了一块验证，而且没人知道。这个顺序是刻意的。
            if (!Object.prototype.hasOwnProperty.call(probes, name)) {
                results.push({
                    name: name,
                    ok: false,
                    missingProbe: true,
                    issue: '体检表（buildAuditProbes）里没有这个工具，自检覆盖不到它'
                });
                return;
            }
            var args = probes[name];
            if (args === 'self') {
                skipped.push({ name: name, why: '自检工具不能自检自己（会无限递归）' });
                return;
            }
            if (args === null || args === undefined) {
                skipped.push({ name: name, why: '有副作用，自动体检不跑（要跑请改用 sideEffects:true 的完整自检）' });
                return;
            }
            return Promise.resolve()
                .then(function () { return callTool(name, args); })
                .then(function (r) {
                    var item = { name: name, ok: true };
                    if (typeof r === 'string') {
                        item.shape = 'text';
                        item.length = r.length;
                        item.empty = r.trim().length === 0;
                    } else if (r && typeof r === 'object') {
                        item.shape = 'json';
                        item.status = r.__status || '(没有 __status —— 包装漏了)';
                        item.emptyFields = r.__emptyFields || [];
                        // 检查：声明了 empty 但没给 reason
                        if (item.status !== 'ok' && !r.__reason) {
                            item.issue = '__status 不是 ok 但没给 __reason';
                        }
                        // 检查：null 字段没被列进 emptyFields
                        var nulls = Object.keys(r).filter(function (k) {
                            // __ 开头是约定字段；EMPTY_IS_OK / EXPECTED_NULL 认的
                            // 为 null 是「正常状态」，不算漏标
                            return r[k] === null && k.indexOf('__') !== 0 && !isExpectedEmpty(name, r, k);
                        });
                        if (nulls.length && (!item.emptyFields || !item.emptyFields.length)) {
                            item.issue = (item.issue ? item.issue + '；' : '') +
                                '有 null 字段但没列进 __emptyFields: ' + nulls.join(', ');
                        }
                    } else {
                        item.shape = 'other';
                    }
                    results.push(item);
                })
                .catch(function (e) {
                    var msg = String(e && e.message ? e.message : e);
                    var item = { name: name, ok: false, error: msg };
                    if (deep) {
                        // 错误信息该说「怎么办」
                        var hasHow = errorHasGuidance(msg);
                        item.errorHasGuidance = hasHow;
                        if (!hasHow) item.issue = '错误信息没说下一步该怎么做';
                    }
                    results.push(item);
                });
        });
    });

    return chain.then(function () {
        // 「有 error 但错误信息合格」不算问题 —— 只要错误信息说清了怎么办就行。
        var problems = results.filter(function (r) {
            return r.issue || (r.ok === false && !r.errorHasGuidance);
        });

        // 三张表（TOOLS / IMPL / 体检表）的一致性，单独报一份
        var regProblems = registryProblems();
        return {
            status: problems.length ? 'partial' : 'ok',
            audited: results.length,
            skipped: skipped.length,
            problems: problems,
            items: results,
            skippedItems: skipped,
            registry: regProblems.length ? regProblems : null,
            note: problems.length
                ? ('有 ' + problems.length + ' 个工具有问题，看 problems 字段')
                : '全部工具返回正常。有副作用的工具（' + skipped.length + ' 个）没自动跑，' +
                  '要连它们一起验就传 sideEffects:true'
        };
    });
}

function toolResolveUuid(args) {
    var q = args.uuid;
    if (!q) throw new Error('缺少 uuid');
    q = String(q).trim();
    var idx = buildUuidIndex(false);

    // 情况一：完整 uuid
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(q)) {
        var rel = idx.byFull[q] || null;
        return {
            input: q,
            uuid: q,
            compressed: compressUuid(q),
            path: rel,
            exists: !!rel,
            kind: rel ? guessKind(rel) : null,
            // 关键：sprite-frame 和 texture 是两回事。
            // prefab 里 Sprite 组件的 _spriteFrame 必须填 sprite-frame 的 uuid，
            // 填 png 的主 uuid（texture）会在渲染时报
            // "spriteFrame.textureLoaded is not a function"。
            resourceType: uuidKind(q),
            usableAsSpriteFrame: uuidKind(q) === 'sprite-frame',
            script: rel && /\.(ts|js)$/i.test(rel) ? readScriptInfo(rel) : null
        };
    }

    // 情况二：压缩 uuid（23 字符）
    if (q.length === 23 && idx.byShort[q]) {
        var full = idx.byShort[q];
        var p2 = idx.byFull[full] || null;
        return {
            input: q,
            uuid: full,
            compressed: q,
            path: p2,
            exists: !!p2,
            kind: p2 ? guessKind(p2) : null,
            resourceType: uuidKind(full),
            usableAsSpriteFrame: uuidKind(full) === 'sprite-frame',
            script: p2 && /\.(ts|js)$/i.test(p2) ? readScriptInfo(p2) : null
        };
    }

    // 情况三：当成路径
    var abs = safePath(q);
    if (!statSafe(abs)) throw new Error('既不是已知 uuid，也找不到这个文件：' + q);
    var u = pathToUuid(q);
    return {
        input: q,
        uuid: u,
        compressed: u ? compressUuid(u) : null,
        path: q,
        exists: true,
        kind: guessKind(q),
        script: /\.(ts|js)$/i.test(q) ? readScriptInfo(q) : null
    };
}

function guessKind(rel) {
    var lower = String(rel).toLowerCase();
    if (lower.slice(-5) === '.fire') return 'scene';
    if (lower.slice(-7) === '.prefab') return 'prefab';
    if (lower.slice(-3) === '.ts' || lower.slice(-3) === '.js') return 'script';
    if (lower.slice(-4) === '.png' || lower.slice(-4) === '.jpg') return 'image';
    if (lower.slice(-5) === '.json') return 'json';
    return 'asset';
}

function toolGetEditorLog(args) {
    var n = typeof args.lines === 'number' ? args.lines : 80;
    if (n < 1) n = 80;
    if (n > 500) n = 500;

    var pick = latestEditorLog();
    var abs = pick.path;
    var skippedNote = pick.skipped && pick.skipped.length
        ? '\n⚠ 以下日志读不到：' + pick.skipped.join('、')
        : '';

    var BLOCKED_HINT =
        'Cocos Creator 2.x 的所有编辑器共用 ~/.CocosCreator/logs/CocosCreator.log，' +
        '先启动的那个进程独占它，后启动的连 stat 都会 EPERM。\n' +
        '看这个编辑器的日志只有两条路：① 只开一个编辑器；② 直接看编辑器里的控制台面板。';

    if (!abs) return '（找不到可读的编辑器日志文件）' + skippedNote + (pick.blocked ? '\n' + BLOCKED_HINT : '');

    // 主日志被独占、只剩很旧的日志可读时，不要把旧内容当成结果给出去
    var pickedAgeHours = 0;
    var pickedStat = statSafe(abs);
    if (pickedStat) pickedAgeHours = (Date.now() - pickedStat.mtimeMs) / 3600000;
    if (pick.blocked && pickedAgeHours > 24) {
        return '（读不到主日志，无法显示编辑器日志）' + skippedNote + '\n' + BLOCKED_HINT;
    }

    // 只读末尾 2MB，日志动辄几百 MB，整读会卡死扩展主进程
    var text = readTail(abs, 2 * 1024 * 1024);
    var all = text.split(/\r?\n/);

    var level = args.level ? String(args.level).toLowerCase() : 'all';
    var kw = args.keyword ? String(args.keyword).toLowerCase() : null;

    var filtered = [];
    for (var i = 0; i < all.length; i++) {
        var line = all[i];
        if (kw && line.toLowerCase().indexOf(kw) < 0) continue;
        if (level === 'error' && !/error|exception|失败|异常/i.test(line)) continue;
        if (level === 'warn' && !/warn|警告/i.test(line)) continue;
        filtered.push(line);
    }

    var tail = filtered.slice(Math.max(0, filtered.length - n));

    return '文件：' + abs +
        '\n总行数：' + all.length +
        (filtered.length !== all.length ? '（过滤后 ' + filtered.length + ' 行）' : '') +
        skippedNote +
        '\n--- 末尾 ' + tail.length + ' 行 ---\n' + tail.join('\n');
}

function toolExecuteScript(args) {
    if (!args.code) throw new Error('缺少 code');
    var fn;
    try {
        // AsyncFunction：让 code 里可以直接写 await
        fn = new Function('Editor', 'require', 'return (async function () {\n' + args.code + '\n})();');
    } catch (e) {
        throw new Error('语法错误：' + e.message);
    }

    return fn(typeof Editor !== 'undefined' ? Editor : null, require).then(function (result) {
        var out = { result: typeof result === 'undefined' ? null : result, type: typeof result };
        return out;
    });
}

/**
 * 从文件读一段 JS 来执行。
 *
 * 为什么需要这个：execute_script 的 code 是 JSON 字符串，
 * 长脚本里带引号、反斜杠、正则会层层转义 —— 转义错了报错信息还完全对不上真因。
 * 从文件读就没有这层地狱。
 *
 * 路径限制在项目内（和 read_file 一致），也允许读 temp 下的临时脚本。
 */
function toolExecuteScriptFile(args) {
    if (!args.path) throw new Error('缺少 path');
    var abs = safePath(args.path);
    if (!statSafe(abs)) {
        throw new Error('文件不存在：' + args.path +
            '。用 write_file 先写进去，或 list_dir 看目录结构。');
    }
    var code;
    try {
        code = fs.readFileSync(abs, 'utf8');
    } catch (e) {
        throw new Error('读文件失败：' + (e.message || e));
    }
    if (code.length > 512 * 1024) throw new Error('脚本太大（' + code.length + ' 字节），上限 512KB');

    var fn;
    try {
        fn = new Function('Editor', 'require', 'return (async function () {\n' + code + '\n})();');
    } catch (e) {
        throw new Error('语法错误：' + e.message);
    }

    return fn(typeof Editor !== 'undefined' ? Editor : null, require).then(function (result) {
        return {
            result: typeof result === 'undefined' ? null : result,
            type: typeof result,
            file: relPath(abs)
        };
    });
}

/**
 * 让编辑器重新导入资源。
 *
 * 三种用法：
 *   {}                      刷「写过但还没刷」的目录（dirty 追踪），没有记录就刷 db://assets/
 *   {"path":"db://..."}     刷单个路径
 *   {"paths":[...]}         刷多个路径（跨目录改资源时必须用这个，漏一个就"编辑器里还是旧的"）
 *
 * 多个目录是并行刷的，任何一个失败都不算整体失败 —— 文件早就写到磁盘了。
 */
function toolRefreshAssets(args) {
    args = args || {};
    if (typeof Editor === 'undefined' || !Editor.assetdb) {
        throw new Error('Editor.assetdb 不可用');
    }

    // 索引失效，下次查询重新扫
    uuidlib.invalidateCache();

    var urls = [];
    function addUrl(u) {
        var s = String(u || '').trim();
        if (!s) return;
        if (s.charAt(s.length - 1) !== '/') {
            var last = s.split('/').pop() || '';
            // C 类修复：只有最后一段确实像文件名（带扩展名）才剥掉取父目录，
            // 否则当作目录直接补 '/'。原实现对 "db://assets" 会把 assets
            // 一起削掉变成 "db://"，assetdb 收到后抛 ERR_INVALID_ARG_TYPE。
            if (/\.[A-Za-z0-9]+$/.test(last)) s = s.replace(/\/[^/]*$/, '') + '/';
            else s += '/';
        }
        if (urls.indexOf(s) < 0) urls.push(s);
    }

    var explicit = false;
    if (args.path) { explicit = true; addUrl(args.path); }
    if (Array.isArray(args.paths)) {
        for (var i = 0; i < args.paths.length; i++) { explicit = true; addUrl(args.paths[i]); }
    }

    var fromDirty = [];
    if (!explicit) {
        fromDirty = dirtyList();
        for (var d = 0; d < fromDirty.length; d++) addUrl('db://' + fromDirty[d]);
    }

    if (!urls.length) {
        addUrl('db://assets/');
        return refreshAssetUrl('db://assets/').then(function (err) {
            return {
                refreshed: ['db://assets/'],
                sources: 'default',
                fromDirty: [],
                done: !err,
                error: err ? String(err.message || err) : null
            };
        });
    }

    var tasks = urls.map(function (u) {
        return refreshAssetUrl(u).then(function (err) {
            return { url: u, error: err ? String(err.message || err) : null };
        });
    });

    return Promise.all(tasks).then(function (res) {
        var failed = res.filter(function (r) { return r.error; });

        // 刷成功的目录，把对应的 dirty 记录清掉；刷失败的留着，下次还能自动补
        var covered = {};
        for (var j = 0; j < res.length; j++) {
            if (!res[j].error) covered[res[j].url.replace(/^db:\/\//, '').replace(/\/$/, '')] = true;
        }
        if (Object.keys(covered).length) clearDirty(covered);

        var out = {
            refreshed: res.filter(function (r) { return !r.error; }).map(function (r) { return r.url; }),
            sources: explicit ? 'path' : 'dirty',
            fromDirty: fromDirty,
            done: failed.length === 0,
            error: failed.length
                ? (failed.map(function (r) { return r.url + '：' + r.error; }).join('；'))
                : null
        };
        if (!explicit && fromDirty.length) {
            out.note = '按写入记录自动刷新了 ' + out.refreshed.length + ' 个目录（write_file / edit_file 记下来的）';
        }
        return out;
    });
}

function toolListOpenProjects() {
    var dir = registryDir();
    var all = readRegistryAll();
    var names = Object.keys(all);

    var cur = projectRoot();
    var target = resolveTarget();
    var out = [];

    for (var i = 0; i < names.length; i++) {
        var o = all[names[i]];
        var st = statSafe(o.file || '');
        o.url = 'http://127.0.0.1:' + o.port + '/mcp';
        o.isCurrent = cur === o.project;
        // 目标标记按项目路径判定，不靠端口 —— 端口会随重启变
        o.isTarget = !!(target && target.project && sameProjectPath(target.project, o.project));
        o.updatedAt = st ? new Date(st.mtimeMs).toISOString() : (o.startedAt || null);
        delete o.file;
        out.push(o);
    }
    out.sort(function (a, b) { return a.port - b.port; });

    return {
        dir: dir,
        count: out.length,
        current: cur,
        currentPort: listeningPort,
        target: target,
        projects: out,
        hint: out.length > 1
            ? '多个项目同时开着。用 set_target_project 指定要操作哪个，之后所有调用都会转发过去，' +
              '客户端连的是哪个端口就不重要了'
            : '只有一个项目注册过',
        forwardError: lastForwardError
    };
}

/**
 * 浏览器侧运行时上报的接收端。
 * 注入到 web 构建产物里的脚本会定时 POST 过来。
 * 注意：这是**浏览器里跑的那个游戏**的状态，和场景进程（编辑器内的）是两回事。
 */
var browserReports = {
    count: 0,
    lastAt: null,
    last: null,
    history: []
};

/**
 * Web 预览桥接状态。
 *
 * 预览页里跑着引擎的 Web 预览（走 __quick_compile__.js 即时编译，不需要 build）。
 * 注入的 bridge.js 通过 HTTP 跟这里通信：
 *   POST /bridge/report   —— 上报运行时状态 + console 日志
 *   GET  /bridge/commands —— 拉取待执行指令
 *   POST /bridge/result   —— 回报指令执行结果
 *   POST /bridge/bye      —— 页面关闭
 */
var bridgeState = {
    connected: false,
    lastAt: null,
    lastReport: null,
    logs: [],            // 带序号的 console 日志
    logSeq: 0,
    commands: [],        // 待执行队列
    cmdSeq: 0,
    results: {},         // id -> 执行结果
    resultOrder: [],     // 结果的到达顺序（用于「取最新一条」）
    errors: [],          // console.error / 未捕获异常
    seenLogKeys: {},     // 日志去重（文本+时间戳）
    seenLogKeyList: [],
    byeAt: null
};

// 保留多少条日志和结果
var BRIDGE_MAX_LOGS = 500;
var BRIDGE_MAX_RESULTS = 100;

/** 记录一条来自预览页的日志 */
function bridgePushLog(entry) {
    if (!entry || !entry.text) return;

    // 去重不能只看 seq —— bridge 重启后 seq 从 1 重新开始，
    // 主进程这边的 logSeq 还停在旧值，新日志会被误判成重复而丢掉。
    // 用「文本+时间戳」判断，才对得起「同一条日志只收一次」。
    var key = String(entry.level || 'log') + '|' + String(entry.text).slice(0, 200) + '|' + (entry.at || 0);
    if (bridgeState.seenLogKeys[key]) return;
    bridgeState.seenLogKeys[key] = true;
    // 已见过的 key 限量，防止无限增长
    bridgeState.seenLogKeyList.push(key);
    if (bridgeState.seenLogKeyList.length > 2000) {
        delete bridgeState.seenLogKeys[bridgeState.seenLogKeyList.shift()];
    }

    bridgeState.logSeq++;
    var item = {
        seq: bridgeState.logSeq,
        level: entry.level || 'log',
        text: String(entry.text).slice(0, 4000),
        at: entry.at || Date.now()
    };
    bridgeState.logs.push(item);
    if (bridgeState.logs.length > BRIDGE_MAX_LOGS) bridgeState.logs.shift();
    if (item.level === 'error') {
        bridgeState.errors.push(item);
        if (bridgeState.errors.length > 100) bridgeState.errors.shift();
    }
}

/** 排队一条待执行的指令，返回它的 id */
function bridgeQueueCommand(cmd) {
    bridgeState.cmdSeq++;
    var item = {
        id: 'cmd_' + bridgeState.cmdSeq + '_' + Date.now().toString(36),
        seq: bridgeState.cmdSeq,
        action: cmd.action,
        path: cmd.path,
        expr: cmd.expr,
        method: cmd.method,
        handler: cmd.handler,
        arg: cmd.arg,
        args: cmd.args,
        module: cmd.module,
        code: cmd.code,
        type: cmd.type,
        index: cmd.index,
        depth: cmd.depth,
        filter: cmd.filter,
        createdAt: Date.now()
    };
    bridgeState.commands.push(item);
    return item;
}

/** 取执行结果（没结果就返回 null） */
function bridgeTakeResult(id) {
    var key = id || null;
    if (!key) {
        // 没指定 id 就取最新一条
        if (!bridgeState.resultOrder.length) return null;
        key = bridgeState.resultOrder[bridgeState.resultOrder.length - 1];
    }
    var r = bridgeState.results[key];
    if (!r) return null;
    // 取过就删（避免读到旧结果）
    delete bridgeState.results[key];
    var idx = bridgeState.resultOrder.indexOf(key);
    if (idx >= 0) bridgeState.resultOrder.splice(idx, 1);
    return r;
}

/**
 * 场景进程能力探针。
 *
 * 为什么要单独做这个工具：v0.3.0 判定"场景脚本只收不回"时，四种回传机制
 * （HTTP / 文件信箱 / sendToMain / 日志）实测全部失败，但**没查清是哪一环断的**。
 * 可能性有两个，处置方式完全相反：
 *   a) 场景进程是沙箱的，没有 require / 没有网络 → 那就没辙，只能走文件层
 *   b) 场景进程有这些能力，只是我用的回传格式不对 → 那就能修好
 *
 * 这个工具同时从**三条独立证据链**取证，不依赖场景进程自己回传：
 *   1. 文件系统痕迹：探针在场景进程里写一个标记文件，主进程去读
 *   2. 回传计数：HTTP 端点的收包统计
 *   3. 场景脚本自身的探测结果（如果回传恰好通了就能拿到）
 */
function toolSceneProbe(args) {
    var wait = (args && args.timeout) ? args.timeout : 8000;
    var dir = ensureBridgeDir();
    var marker = path.join(dir, 'probe-marker-' + Date.now() + '.json');

    // 先清掉旧痕迹
    try {
        var old = fs.readdirSync(dir);
        for (var i = 0; i < old.length; i++) {
            if (old[i].indexOf('probe-marker-') === 0) {
                try { fs.unlinkSync(path.join(dir, old[i])); } catch (e) { /* 忽略 */ }
            }
        }
    } catch (e) { /* 忽略 */ }

    var before = {
        total: sceneCallbackHits.total,
        unknown: sceneCallbackHits.unknown
    };

    // payload 里带上标记文件路径 —— 场景进程能写文件就说明有 fs 能力
    return callSceneScript('probe', {
        __probeMarker: marker,
        __probePosix: marker.replace(/\\/g, '/')
    }, wait).then(function (data) {
        return finishProbe(data, marker, before, '场景脚本回传成功');
    }, function (err) {
        return finishProbe(null, marker, before, err.message);
    });
}

function finishProbe(data, marker, before, note) {
    var out = {
        note: note,
        sceneScriptResult: data,
        callbackDelta: {
            total: sceneCallbackHits.total - before.total,
            unknown: sceneCallbackHits.unknown - before.unknown
        }
    };

    // 证据链 1：文件痕迹
    var st = statSafe(marker);
    if (st) {
        out.fileEvidence = { written: true, bytes: st.size };
        try {
            var txt = fs.readFileSync(marker, 'utf8');
            out.fileEvidence.content = txt.slice(0, 400);
        } catch (e) {
            out.fileEvidence.readError = e.message;
        }
        try { fs.unlinkSync(marker); } catch (e) { /* 忽略 */ }
    } else {
        out.fileEvidence = { written: false, note: '场景进程没写出标记文件' };
    }

    // 证据链 2：HTTP 回传
    out.httpEvidence = {
        received: out.callbackDelta.total > 0,
        delta: out.callbackDelta.total
    };

    // 证据链 3：场景脚本自己的探测结果
    if (data && data.modules) {
        out.capabilities = data;
    }

    // 结论
    var canFs = !!(out.fileEvidence && out.fileEvidence.written);
    var canHttp = out.callbackDelta.total > 0;
    out.verdict = canHttp
        ? '场景进程能发 HTTP —— 回传通道可用，之前是格式问题'
        : (canFs
            ? '场景进程能写文件但发不出 HTTP —— 文件信箱可用，HTTP 被限制了'
            : '场景进程既不能写文件也不能发 HTTP —— 沙箱化，没有 require/网络能力');

    return out;
}

function toolScenePing(args) {
    var abs = (args && args.path) ? safePath(args.path) : currentSceneFile();
    var ss = Editor.sceneScripts || {};

    var out = {
        sceneScriptRegistered: !!ss[PKG_NAME],
        sceneScriptEntry: ss[PKG_NAME] || null,
        writeRoute: 'file（直改 .fire / .prefab 的 JSON，不依赖场景脚本）',
        sceneFile: abs ? path.relative(projectRoot(), abs).replace(/\\/g, '/') : null,
        sceneCallbackHits: sceneCallbackHits
    };

    if (abs && statSafe(abs)) {
        try {
            var arr = loadSerialized(abs);
            var root = findRootForEdit(arr);
            out.objectCount = arr.length;
            out.rootKind = root.kind;
            out.sceneRootId = root.rootId;
            out.rootNodeName = root.rootId >= 0 && arr[root.rootId] ? (arr[root.rootId]._name || '') : '';
            out.templateFound = pickNodeTemplate(arr, root.rootId) >= 0;
            out.sceneWritable = root.rootId >= 0;
        } catch (e) {
            out.parseError = e.message;
        }
    }

    // 顺带探一下场景进程通道通不通。
    // 文件层一切正常不代表场景脚本可用——这是两套独立机制，
    // scene_* 里凡是走场景脚本的工具都依赖这条回传。
    if (args.skipSceneScript !== true) {
        return callSceneScript('ping', {}, 5000).then(function (data) {
            out.sceneScriptOk = true;
            out.sceneScriptResult = data;
            return out;
        }, function (err) {
            out.sceneScriptOk = false;
            out.sceneScriptError = err && err.message ? err.message : String(err);
            return out;
        });
    }

    return out;
}

/**
 * 所有工具共享的返回约定。
 *
 * 这段话会追加到每个工具的描述后面（见 tools/list）。
 * 目的：即使隔了很久、或者换了 AI 来用，光看工具描述就知道
 * 「返回里的空值是什么意思」「该看哪个字段」「下一步做什么」。
 */
/**
 * 某些字段为 null / 空数组是**正常状态**，不该被算成"空"。
 * 这些字段名本身就是"占位"语义：
 *   error / lastError / forwardError —— 没错误
 *   hint / reason                      —— 没提示
 *   changed / injected / warnings       —— 没有变更（操作成功但无变化）
 *   outOfBounds / overlaps / …          —— 布局检查没发现问题（空数组是好消息）
 */
var EMPTY_IS_OK = {
    error: 1, lastError: 1, forwardError: 1,
    hint: 1, reason: 1,
    changed: 1, injected: 1, warnings: 1, skipped: 1, registry: 1, skippedItems: 1,
    outOfBounds: 1, overlaps: 1, outsideParent: 1, inactiveHidden: 1,
    diagnostics: 1, leftover: 1, problems: 1
};

/**
 * 按工具+结果类型判断"这个字段本来就该是空的"。
 *
 * 为什么不能只靠 EMPTY_IS_OK：`resolve_uuid` 对**所有**资源都返回 `script` 字段，
 * 查预制体/图片时必然是 null —— 那是设计如此，不是半个失败。
 * 但同一个工具有时候 script 真该有值（查的就是 .ts），那种情况还是要标出来。
 */
var EXPECTED_NULL = {
    // prefab{cmd:"diff"} 的四类差异里，没有的那类是空数组 —— 这是正常结果，不是"半个失败"。
    // v0.8.0 起 annotateResult 拿到的是合并后的名字 prefab，所以键也跟着改。
    prefab: function (r, k) {
        if (k === 'added' || k === 'removed' || k === 'changed' || k === 'renamed') return true;
        return false;
    },
    // editor_sync 的 ledger / advice / diff / live 在"没历史、没风险、没开编辑器"时本来就该空，
    // 那是正常状态，不能算成"半个失败"（否则每次干净的检查都报 partial，噪音）。
    editor_sync: function (r, k) {
        if (k === 'ledger') return !r.ledger;
        if (k === 'advice') return !r.advice;
        if (k === 'diff' || k === 'live') return !r.diff;
        return false;
    },
    resolve_asset: function (r, k) {
        if (k === 'script') return r.kind !== 'script';
        // 图片才有 spriteFrameUuid；查的是 prefab/脚本时它本来就该是空的
        if (k === 'spriteFrameUuid') return r.kind !== 'image';
        return false;
    }
};

/**
 * 这个字段为空算不算"正常"。
 * 两个来源：全局白名单（EMPTY_IS_OK）+ 按工具细判（EXPECTED_NULL）。
 * annotateResult 和 mcp_audit 的自洽性检查必须用同一套判断，否则自检会误报。
 */
function isExpectedEmpty(toolName, result, key) {
    if (EMPTY_IS_OK[key]) return true;
    var fn = EXPECTED_NULL[toolName];
    if (fn && fn(result, key)) return true;
    return false;
}

/**
 * 统一返回约定。
 *
 * 背景：不同工具的"空"含义不一样 —— build_status 没构建时一堆 null，
 * runtime_browser_report 没上报时 report=null，refresh_assets 成功时 error=null。
 * 调用方（尤其是隔一段时间再用的 AI）分不清「这是正常空状态」还是「工具坏了」，
 * 只能靠试。这套约定把这件事说清楚：
 *
 *   __status: 'ok'      —— 有数据
 *          'empty'   —— 正常但没数据（附 reason 说明为什么空、hint 说明该做什么）
 *          'partial' —— 部分为空
 *
 * 顶层 null / 空数组的字段会被列进 emptyFields。
 */
function annotateResult(toolName, result) {
    if (result === null || result === undefined) {
        return { __status: 'empty', __tool: toolName, __reason: '工具没有返回任何内容', __emptyFields: [] };
    }
    // 纯文本返回（read_file 之类）不加包装 —— 那是有意的，AI 直接读原文更方便
    if (typeof result !== 'object' || Array.isArray(result)) {
        return result;
    }
    // 已经有 status 的（工具自己说明过了）不覆盖
    if (result.__status) return result;

    var emptyFields = [];
    Object.keys(result).forEach(function (k) {
        if (k.indexOf('__') === 0) return;      // 约定字段本身
        if (isExpectedEmpty(toolName, result, k)) return;  // null/空是正常状态
        var v = result[k];
        if (v === null || v === undefined) emptyFields.push(k);
        else if (Array.isArray(v) && v.length === 0) emptyFields.push(k + '[]');
    });

    if (!emptyFields.length) {
        result.__status = 'ok';
        result.__tool = toolName;
        return result;
    }

    // 有工具自己写的 note/hint 就用，没有就生成一句通用说明
    var reason = result.__reason || result.reason ||
        ('这些字段是空的：' + emptyFields.join(', ') +
         '。空值一般表示"当前没有这项数据"，不是调用失败。');

    result.__status = emptyFields.length >= Object.keys(result).length * 0.6 ? 'empty' : 'partial';
    result.__tool = toolName;
    result.__emptyFields = emptyFields;
    result.__reason = reason;
    if (!result.__hint) {
        result.__hint = '工具本身没给提示。看工具描述里"什么时候会空"的说明。';
    }
    return result;
}

function callTool(name, args) {
    args = args || {};

    // 旧名兼容：v0.4.0 合并过一批、v0.8.0 又合并了一批。
    // 有些 v0.4.0 旧名指向的"中继名"自己也被合并了（如 prefab_instantiate →
    // scene_add_node → scene_edit），所以沿 RENAMED 链一路解析到最终工具名。
    // 最多 4 跳，防止表里哪天写出环来把调用卡死。
    var legacy = null;
    var hops = 0;
    while (RENAMED[name] && hops < 4) {
        if (!legacy) legacy = name;
        var hop = RENAMED[name];
        args = migrateLegacyArgs(name, args);
        name = hop.to;
        hops++;
    }

    function finish(v) {
        var out = annotateResult(name, v);
        if (legacy && out && typeof out === 'object' && !Array.isArray(out)) {
            out.__renamedFrom = legacy;
            out.__hops = hops;
            out.__hint = '旧工具名 ' + legacy + ' 已并入 ' + name +
                '（自动转发 ' + hops + ' 跳' + (args.cmd ? '，cmd=' + args.cmd : '') +
                '），请改用新名；本次已自动转发。';
        }
        return out;
    }

    var r = dispatchTool(name, args);
    if (r && typeof r.then === 'function') {
        return r.then(finish, function (e) { throw e; });
    }
    return finish(r);
}

/**
 * 资源引用查询：谁引用了我 / 我引用了谁。
 *
 * 这是"敢不敢删这张图"的唯一依据。以前只能靠人工猜，
 * 现在把 .fire/.prefab/.anim/.json 里的 __uuid__ 全部抠出来反转成索引。
 */
function toolAssetRefs(args) {
    args = args || {};
    var q = args.input || args.path || args.uuid;
    if (!q) throw new Error('缺少 input（资源路径 / 完整 uuid / 压缩 uuid）');

    var idx = buildUuidIndex(false);
    var str = String(q).trim();
    var rel = null;
    var uuid = null;

    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str)) {
        uuid = str;
        rel = idx.byFull[uuid] || null;
    } else if (str.length === 23 && idx.byShort[str]) {
        uuid = idx.byShort[str];
        rel = idx.byFull[uuid] || null;
    } else {
        rel = str.replace(/\\/g, '/');
        var abs = safePath(rel);
        if (!statSafe(abs)) {
            throw new Error('找不到这个资源：' + rel + '。用 list_dir / search_files 确认真实路径。');
        }
        var metaAbs = abs + '.meta';
        if (statSafe(metaAbs)) {
            var m = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(fs.readFileSync(metaAbs, 'utf8'));
            uuid = m ? m[1] : null;
        }
    }

    if (!rel && !uuid) throw new Error('这个 uuid 在 assets 的 .meta 索引里找不到：' + str);

    // 同一份资源的所有 uuid（主 uuid + subMetas），引用可能落在任意一个上
    var allUuids = [];
    if (uuid) allUuids.push(uuid);
    if (rel) {
        for (var u in idx.byFull) {
            if (!Object.prototype.hasOwnProperty.call(idx.byFull, u)) continue;
            if (idx.byFull[u] !== rel) continue;
            if (allUuids.indexOf(u) < 0) allUuids.push(u);
        }
    }

    var dir = String(args.direction || 'in').toLowerCase();
    if (['in', 'out', 'both'].indexOf(dir) < 0) {
        throw new Error('direction 只能是 in / out / both，收到：' + args.direction);
    }

    var limit = typeof args.limit === 'number' ? args.limit : 50;
    var out = {
        path: rel,
        uuid: uuid,
        uuidCount: allUuids.length
    };

    // ── 谁引用我 ──
    if (dir === 'in' || dir === 'both') {
        var merged = {};
        var order = [];
        for (var i = 0; i < allUuids.length; i++) {
            var list = graphlib.refsTo(allUuids[i]);
            for (var j = 0; j < list.length; j++) {
                var f = list[j].file;
                if (!merged[f]) { merged[f] = 0; order.push(f); }
                merged[f] += list[j].count;
            }
        }
        // 自己引用自己不算（预制体里可能出现），但要标出来
        var selfRefs = 0;
        var referrers = [];
        for (var k = 0; k < order.length; k++) {
            if (order[k] === rel) { selfRefs = merged[order[k]]; continue; }
            referrers.push({ file: order[k], count: merged[order[k]] });
        }
        referrers.sort(function (a, b) { return b.count - a.count; });
        out.referrers = referrers.slice(0, limit);
        out.referrerCount = referrers.length;
        out.truncated = referrers.length > limit;
        if (selfRefs) out.selfReferences = selfRefs;
        // "没人引用"对场景/预制体不适用（它们本来就是入口），只对图片这类资源有意义
        out.unused = referrers.length === 0;
    }

    // ── 我引用了谁 ──
    if (dir === 'out' || dir === 'both') {
        if (!rel) {
            out.outgoing = [];
            out.outgoingNote = '只有 uuid 没有路径，读不出它引用了谁';
        } else {
            var from = graphlib.refsFrom(rel) || [];
            out.outgoing = from.slice(0, limit).map(function (x) {
                return {
                    uuid: x.uuid,
                    path: idx.byFull[x.uuid] || null,
                    count: x.count,
                    missing: !idx.byFull[x.uuid]
                };
            });
            out.outgoingCount = from.length;
        }
    }

    out.note = dir === 'out'
        ? '这是"我引用了谁"：改/删这些资源会影响当前文件'
        : (out.referrerCount === 0
            ? ('没有任何 .fire/.prefab/.anim/.json 引用它' +
               (rel && /\.(png|jpg|jpeg)$/i.test(rel) ? ' —— 大概率可以安全删除（asset_delete）' : ''))
            : ('有 ' + out.referrerCount + ' 个文件引用它；删之前先确认这些引用'));
    return out;
}

/**
 * 引擎内置资源的 uuid —— 它们**不在项目的 assets 里**，所以索引里查不到，
 * 但绝对不能当成"悬空引用"报出来（否则每个项目都会有一堆假问题）。
 *
 * 这三个是在三个真实项目里都出现、且都不存在于 assets 的材质 uuid（2d-sprite 那套）。
 * 判定方法：如果某个 uuid 在项目的所有 .meta 里都找不到，但在多个不同项目的
 * prefab 里都被引用 —— 它就是内置资源。
 */
var BUILTIN_UUIDS = {
    'eca5d2f2-8ef6-41c2-bbe6-f9c79d09c432': 'builtin 2d-sprite 材质',
    '3a7bb79f-32fd-422e-ada2-96f518fed422': 'builtin 2d 材质（B）',
    '7afd064b-113f-480e-b793-8817d19f63c3': 'builtin 2d 材质（C）'
};

/**
 * texture uuid → 同一资源下的 sprite-frame uuid。
 *
 * 只处理"一个资源只有一个 frame"的情况（普通 png 就是这种）。
 * 图集（plist）一个资源下有多个 frame，猜不出原来想用哪个 —— 返回 null，让 doctor 别动它。
 */
function spriteFrameForTexture(texUuid, idx) {
    var assetRel = idx.byFull[texUuid];
    if (!assetRel) return null;
    var frames = [];
    for (var u in idx.byKind) {
        if (!Object.prototype.hasOwnProperty.call(idx.byKind, u)) continue;
        if (idx.byKind[u] !== 'sprite-frame') continue;
        if (idx.byFull[u] === assetRel) frames.push(u);
    }
    return frames.length === 1 ? frames[0] : null;
}

/**
 * 执行体检出的修复计划。
 *
 * 只做三类安全修复，每一类都能说清"为什么不会更糟"：
 *   wrong-sprite-frame —— 把 texture 的 uuid 换成同资源的 sprite-frame uuid，这是唯一正确的值
 *   orphan-meta        —— 移到隔离区（**不是删除**），随时能搬回去
 *   missing-meta       —— 交给编辑器 refresh 生成（不手写 uuid / importer）
 *
 * 返回 {fixed, failed, quarantine}，调用方据此如实报告，不掩盖失败。
 */
function applyDoctorPlan(plan) {
    var fixed = [];
    var failed = [];
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    var quarantineDir = path.join(projectRoot(), 'temp', 'mcp-state', 'quarantine', stamp);
    var refreshDirs = {};

    // ── 1) spriteFrame 类型修正（按文件聚合，一个文件只写一次）──
    var byFile = {};
    plan.forEach(function (p) {
        if (p.kind !== 'wrong-sprite-frame') return;
        if (!byFile[p.file]) byFile[p.file] = [];
        byFile[p.file].push(p);
    });

    Object.keys(byFile).forEach(function (rel) {
        var abs = safePath(rel);
        try {
            var arr = loadSerialized(abs);
            var map = {};
            byFile[rel].forEach(function (p) { map[p.from] = p.to; });
            var hits = 0;
            for (var i = 0; i < arr.length; i++) {
                var o = arr[i];
                if (!o || o.__type__ !== 'cc.Sprite') continue;
                if (!o._spriteFrame || typeof o._spriteFrame.__uuid__ !== 'string') continue;
                if (!map[o._spriteFrame.__uuid__]) continue;
                o._spriteFrame.__uuid__ = map[o._spriteFrame.__uuid__];
                hits++;
            }
            if (hits) {
                writeJsonPreserving(abs, arr);
                markDirty(rel);
                fixed.push({ file: rel, kind: 'wrong-sprite-frame', changed: hits });
                var dir = rel.replace(/\/[^/]*$/, '');
                refreshDirs[dir] = 1;
            } else {
                failed.push({ file: rel, kind: 'wrong-sprite-frame', error: '定位到问题但没替换成功（文件可能刚被改过）' });
            }
        } catch (e) {
            failed.push({ file: rel, kind: 'wrong-sprite-frame', error: String((e && e.message) || e) });
        }
    });

    // ── 2) 孤儿 .meta 移到隔离区 ──
    plan.forEach(function (p) {
        if (p.kind !== 'orphan-meta') return;
        var fromAbs = safePath(p.file);
        var toAbs = path.join(quarantineDir, p.file);
        try {
            fs.mkdirSync(path.dirname(toAbs), { recursive: true });
            fs.renameSync(fromAbs, toAbs);
            fixed.push({ file: p.file, kind: 'orphan-meta', movedTo: relPath(toAbs) });
        } catch (e) {
            // rename 跨盘会失败，退化成"复制 + 删原文件"
            try {
                fs.writeFileSync(toAbs, fs.readFileSync(fromAbs));
                fs.unlinkSync(fromAbs);
                fixed.push({ file: p.file, kind: 'orphan-meta', movedTo: relPath(toAbs), viaCopy: true });
            } catch (e2) {
                failed.push({ file: p.file, kind: 'orphan-meta', error: String((e2 && e2.message) || e2) });
            }
        }
    });

    // ── 3) 缺 .meta：让编辑器自己导入 ──
    plan.forEach(function (p) {
        if (p.kind !== 'missing-meta') return;
        // 只有 assets 下的东西才归编辑器管。temp/ 里的副本没有 .meta 是正常的，
        // 对它 refresh 也没意义 —— 跳过，别在报告里制造假失败。
        if (p.file.indexOf('assets/') !== 0) return;
        var dir = p.file.replace(/\/[^/]*$/, '');
        refreshDirs[dir] = 1;
    });

    var dirs = Object.keys(refreshDirs);
    var chain = Promise.resolve();
    dirs.forEach(function (dir) {
        chain = chain.then(function () {
            return refreshAssetUrl('db://' + (dir || 'assets') + '/').then(function (err) {
                if (err) {
                    failed.push({ file: dir + '/', kind: 'missing-meta', error: 'refresh 失败：' + String((err && err.message) || err) });
                } else {
                    fixed.push({ file: dir + '/', kind: 'refresh' });
                }
            }, function (e) {
                failed.push({ file: dir + '/', kind: 'missing-meta', error: 'refresh 抛错：' + String((e && e.message) || e) });
            });
        });
    });

    return chain.then(function () {
        return {
            fixed: fixed,
            failed: failed,
            quarantine: fixed.some(function (x) { return x.kind === 'orphan-meta'; })
                ? relPath(quarantineDir)
                : null
        };
    });
}

/**
 * 项目体检：检查的是**项目**，不是 MCP（那是 mcp_selftest 的活）。
 *
 * 为什么需要：AI 改完一批文件，最容易留下"编辑器能打开、运行时才炸"的坑 ——
 * 悬空 __uuid__、缺 _prefab、fileId 重复、spriteFrame 填成 texture。
 * 这些错误引擎导入时一律不报。跑一遍这个，比让用户去打游戏发现黑图快得多。
 *
 * 默认只读。`fix: "preview"` 列出能自动修什么，`fix: true` 才真的修。
 *
 * 只修**三类不会把事情弄更糟**的：
 *   1. spriteFrame 填成 texture → 换成同资源的 sprite-frame uuid（一定比原来对）
 *   2. 孤儿 .meta → 移到 temp/mcp-state/quarantine/（可还原，不是删）
 *   3. 缺 .meta → 对所在目录 refresh_assets，让编辑器自己生成（**不手写**：
 *      uuid 和 importer 默认值只有编辑器知道，手写等于给项目换身份）
 * 悬空 __uuid__ 一律不修 —— 修它得先知道原来想引什么，猜不出来。
 */
function toolProjectDoctor(args) {
    args = args || {};
    var root = projectRoot();
    if (!root) throw new Error('项目未打开');

    var limit = typeof args.limit === 'number' ? args.limit : 120;
    if (limit < 1) limit = 120;
    if (limit > 500) limit = 500;
    var includeLayout = args.includeLayout === true || args.include_layout === true;

    // fix 三态：false/缺省 = 只报告；'preview' = 列出计划；true = 真修
    var fixMode = args.fix === true ? 'apply' : (String(args.fix) === 'preview' ? 'preview' : null);
    var plan = [];

    // 目标文件：指定了就只查它，否则扫 assets 下的场景/预制体
    var targets = [];
    if (args.path) {
        var absOne = safePath(args.path);
        if (!statSafe(absOne)) throw new Error('文件不存在：' + args.path + '。用 list_dir 看目录结构。');
        targets.push(relPath(absOne));
    } else {
        var assetsDir = path.join(root, 'assets');
        walkFiles(assetsDir, { maxDepth: 30, skip: SKIP_DIRS }, function (full, name) {
            if (targets.length >= limit) return;
            var low = name.toLowerCase();
            if (low.slice(-7) !== '.prefab' && low.slice(-5) !== '.fire') return;
            targets.push(relPath(full));
        });
    }

    var idx = buildUuidIndex(false);
    var problems = [];
    var scanned = 0;
    var kindCount = { scene: 0, prefab: 0 };

    function add(file, issue, extra) {
        if (problems.length >= 200) return;
        var item = { file: file, issue: issue };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) item[k] = extra[k];
        problems.push(item);
    }

    for (var i = 0; i < targets.length; i++) {
        var rel = targets[i];
        var abs = safePath(rel);
        if (!statSafe(abs)) { add(rel, '文件读不到（可能刚被删）'); continue; }
        scanned++;

        // .meta 必须在
        if (!statSafe(abs + '.meta')) {
            add(rel, '缺 .meta —— 编辑器不会导入它');
            plan.push({ kind: 'missing-meta', file: rel });
        }

        var arr;
        try {
            arr = loadSerialized(abs);
        } catch (e) {
            add(rel, 'JSON 解析失败：' + (e && e.message ? e.message : e));
            continue;
        }

        var rootInfo = findRootForEdit(arr);
        if (rootInfo.rootId < 0) {
            add(rel, '找不到根对象（既没有 cc.Scene，也没有 cc.Prefab.data 指向的 cc.Node）');
            continue;
        }
        kindCount[rootInfo.kind] = (kindCount[rootInfo.kind] || 0) + 1;

        // 结构完整性（父子互指、__id__ 范围；预制体还查 PrefabInfo/fileId）
        var structProblems = doclib.validateDocArray(arr, rootInfo.kind);
        for (var sp = 0; sp < structProblems.length; sp++) add(rel, structProblems[sp]);

        // 悬空 __uuid__ + spriteFrame 填错类型
        var missing = {};
        var wrongSprite = [];

        function noteUuid(u) {
            if (!u) return;
            if (BUILTIN_UUIDS[u]) return;     // 内置材质不在 assets 里，不算悬空
            if (idx.byFull[u]) return;
            missing[u] = (missing[u] || 0) + 1;
        }

        for (var j = 0; j < arr.length; j++) {
            var o = arr[j];
            if (!o || typeof o !== 'object') continue;

            // Sprite 用错了 uuid 类型（texture 而不是 sprite-frame）—— 这条要单独判，
            // 因为 uuid 存在、只是类型不对
            if (o.__type__ === 'cc.Sprite' && o._spriteFrame && typeof o._spriteFrame.__uuid__ === 'string') {
                var sf = o._spriteFrame.__uuid__;
                if (idx.byFull[sf] && idx.byKind && idx.byKind[sf] && idx.byKind[sf] !== 'sprite-frame') {
                    wrongSprite.push({ uuid: sf, kind: idx.byKind[sf], path: idx.byFull[sf] });
                }
            }

            // 通用的 __uuid__ 扫描。
            // 注意：数组元素本身可能就是 {__uuid__: "..."}（比如 _materials），
            // 所以必须先判"这个对象自己是不是引用"，再往里走 —— 否则漏掉材质这类引用。
            (function scan(obj, depth) {
                if (depth > 8 || obj === null || typeof obj !== 'object') return;
                if (typeof obj.__uuid__ === 'string') { noteUuid(obj.__uuid__); return; }
                if (Array.isArray(obj)) {
                    for (var m = 0; m < obj.length; m++) scan(obj[m], depth + 1);
                    return;
                }
                for (var k in obj) {
                    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                    scan(obj[k], depth + 1);
                }
            })(o, 0);
        }

        var missKeys = Object.keys(missing);
        if (missKeys.length) {
            add(rel, '有 ' + missKeys.length + ' 个 uuid 在资源索引里找不到（悬空引用，运行时会变白图/丢失）', {
                missingUuids: missKeys.slice(0, 10),
                occurrences: missKeys.reduce(function (n, k) { return n + missing[k]; }, 0)
            });
        }

        if (wrongSprite.length) {
            add(rel, 'Sprite._spriteFrame 填了非 sprite-frame 的 uuid（' + wrongSprite.length +
                ' 处）—— 渲染时报 textureLoaded is not a function', {
                samples: wrongSprite.slice(0, 5)
            });
            // 能修：同一张图一定有对应的 sprite-frame uuid，换过去就对了
            var plannedUuid = {};
            for (var ws = 0; ws < wrongSprite.length; ws++) {
                var bad = wrongSprite[ws];
                if (plannedUuid[bad.uuid]) continue;
                var good = spriteFrameForTexture(bad.uuid, idx);
                if (!good) continue;             // 图集里多个 frame → 猜不出该用哪个，不动
                plannedUuid[bad.uuid] = good;
                plan.push({ kind: 'wrong-sprite-frame', file: rel, from: bad.uuid, to: good, path: bad.path });
            }
        }

        // 布局（可选，只对预制体；噪声大，默认关）
        if (includeLayout && rootInfo.kind === 'prefab') {
            try {
                var lay = prefabLayoutCheck(arr, rootInfo.rootId, {});
                if (lay.outOfBounds.length) {
                    add(rel, '布局：' + lay.outOfBounds.length + ' 个节点越出画布', {
                        samples: lay.outOfBounds.slice(0, 3).map(function (x) { return x.node; })
                    });
                }
                if (lay.overlaps.length) {
                    var bad = lay.overlaps.filter(function (x) { return x.ratio !== null && x.ratio < 0.95; });
                    if (bad.length) {
                        add(rel, '布局：' + bad.length + ' 处同级重叠（ratio < 0.95，可能是压字）', {
                            samples: bad.slice(0, 3).map(function (x) { return x.a + ' × ' + x.b; })
                        });
                    }
                }
            } catch (e2) { /* 布局自检失败不影响其他检查 */ }
        }
    }

    // 孤儿 .meta（有 meta 没资源）—— 只在全项目扫描时查
    var orphanMetas = [];
    if (!args.path) {
        var assetsDir2 = path.join(root, 'assets');
        var metaCount = 0;
        walkFiles(assetsDir2, { maxDepth: 30, skip: SKIP_DIRS }, function (full, name) {
            if (name.slice(-5) !== '.meta') return;
            metaCount++;
            if (metaCount > 6000) return;
            var base = full.slice(0, -5);
            if (!statSafe(base)) orphanMetas.push(relPath(full));
        });
        if (orphanMetas.length) {
            add('(项目级)', '有 ' + orphanMetas.length + ' 个孤儿 .meta（对应资源已删）—— 会在库里留下幽灵资源', {
                samples: orphanMetas.slice(0, 10)
            });
            for (var om = 0; om < orphanMetas.length; om++) {
                plan.push({ kind: 'orphan-meta', file: orphanMetas[om] });
            }
        }
    }

    var byType = {};
    for (var p2 = 0; p2 < problems.length; p2++) {
        var key = String(problems[p2].issue).replace(/[：:].*$/, '').slice(0, 24);
        byType[key] = (byType[key] || 0) + 1;
    }

    var scannedAll = targets.length;
    var out = {
        scanned: scanned,
        truncated: !args.path && scannedAll >= limit,
        kinds: kindCount,
        problemCount: problems.length,
        problems: problems,
        summary: byType,
        scanScope: args.path || ('assets 下前 ' + limit + ' 个 .fire/.prefab'),
        fixable: plan.slice(0, 30),
        fixableCount: plan.length
    };

    if (!problems.length) {
        out.note = '扫了 ' + scanned + ' 个文件，没发现问题。' +
            (includeLayout ? '' : '（布局检查默认关闭，需要时传 includeLayout:true）');
        return out;
    }

    out.note = '体检出 ' + problems.length + ' 个问题。这些错误**编辑器导入时不报**，要到运行时才显形；' +
        '先按 problems 逐条修，再用 asset_refs 确认引用关系。';
    out.nextStep = '悬空引用先用 asset_refs({direction:"out"}) 定位是哪个文件少了资源；结构问题用 query_scene_tree 复核';

    if (plan.length) {
        out.fixHint = '其中 ' + plan.length + ' 项可以自动修（spriteFrame 类型错 / 孤儿 .meta / 缺 .meta）：' +
            '先 fix:"preview" 看清单，确认后 fix:true 执行。悬空 __uuid__ 不在可修范围（猜不出原来想引什么）。';
    }

    if (!fixMode || !plan.length) return out;

    if (fixMode === 'preview') {
        out.fixPreview = plan;
        out.note = '这是修复计划，**还没有动任何文件**。确认后传 fix:true 执行。';
        return out;
    }

    return applyDoctorPlan(plan).then(function (res) {
        out.fixed = res.fixed;
        out.fixFailed = res.failed;
        out.quarantine = res.quarantine;
        out.note = '已修 ' + res.fixed.length + ' 项' +
            (res.failed.length ? ('，' + res.failed.length + ' 项失败（看 fixFailed，不掩盖）') : '') +
            (res.quarantine ? ('。挪走的 .meta 在 ' + res.quarantine + '，要还原就搬回去') : '') +
            '。修完再跑一次体检确认（fix 默认是关的）。';
        out.nextStep = '重新跑一次 project_doctor 确认问题数下降；然后 editor_sync 看编辑器要不要重载';
        return out;
    });
}

//#region 节点级差异（v0.7.0）

/**
 * 两份 `.fire` / `.prefab` 的**节点级**差异，而不是整文件字节 diff。
 *
 * 字节 diff 在序列化文件上基本没法读：加一个节点会让后面所有 `__id__` 平移，
 * 整份文件从头到尾都算"变了"。这个工具按节点路径配对，只说三件事：
 * 加了谁、删了谁、谁的哪个属性变了。
 *
 * 典型用法：改之前 `cp` 一份到 temp/，改完拿原文件来比。
 */
function toolPrefabDiff(args) {
    args = args || {};
    var aRel = args.a || args.path;
    var bRel = args.b || args.against;

    if (!aRel) throw new Error('缺少 a（或 path）：要对比的新文件，如 "assets/ui/Foo.prefab"。');
    if (!bRel) {
        throw new Error('缺少 b（或 against）：对比基准文件。' +
            '常见做法是先 cp 一份到 temp/xxx.prefab 再改，改完用它比；' +
            '或者用 git 取出旧版写到 temp/ 里。');
    }

    var aAbs = safePath(aRel);
    var bAbs = safePath(bRel);
    if (!statSafe(aAbs)) throw new Error('a 不存在：' + aRel + '。用 list_dir 确认路径。');
    if (!statSafe(bAbs)) throw new Error('b 不存在：' + bRel + '。用 list_dir 确认路径。');

    var A, B;
    try {
        A = loadSerialized(aAbs);
    } catch (e) {
        throw new Error('a 解析失败（' + aRel + '）：' + (e && e.message ? e.message : e));
    }
    try {
        B = loadSerialized(bAbs);
    } catch (e) {
        throw new Error('b 解析失败（' + bRel + '）：' + (e && e.message ? e.message : e));
    }

    var diff = doclib.diffDocs(B, A);   // 基准在前、新文件在后
    var limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : 50;

    var out = {
        a: relPath(aAbs),
        b: relPath(bAbs),
        before: diff.before,
        after: diff.after,
        summary: diff.summary,
        added: diff.added.slice(0, limit),
        removed: diff.removed.slice(0, limit),
        changed: diff.changed.slice(0, limit),
        renamed: diff.renamed.slice(0, limit),
        truncated: (diff.added.length > limit || diff.removed.length > limit ||
            diff.changed.length > limit || diff.renamed.length > limit)
    };

    var s1 = diff.summary;
    out.note = (s1.added || s1.removed || s1.changed || s1.renamed)
        ? ('相对 ' + out.b + '：新增 ' + s1.added + '、删除 ' + s1.removed +
           '、改动 ' + s1.changed + '、改名 ' + s1.renamed + ' 个节点。' +
           '属性字段用 [旧值, 新值] 表示；组件的 added/removed 只列类型，不含字段值。')
        : ('两个文件的节点结构和关键属性完全一致（各 ' + diff.before.nodes + ' 个节点）。' +
           '注意：只比结构/位置/尺寸/显隐/颜色/组件类型，不比组件内部字段值（那是整文件字节 diff 的活）。');
    return out;
}

//#endregion

//#region 编辑器内存状态（v0.6.0）

/**
 * 拿到场景面板的 webContents。
 *
 * 为什么能这么做：`Editor` 在扩展主进程里虽然有 `currentSceneUuid` 这类字段，
 * 但**没有**任何查询/重载场景的接口（2.4.15 的面板消息里既没有 query-dirty 也没有 reload，
 * 这两条是拿 20 多个候选名字一个个试出来「不存在」的）。
 * 而 `Editor.Panel.findWindow('scene').nativeWin.webContents` 是主进程能直接操作的，
 * `executeJavaScript` 可以在场景面板的渲染进程里跑代码 —— 那里有完整的 cc 和面板实例。
 *
 * 所以「读活节点」「重载场景」都从这条路走。拿不到就如实返回原因，不假装成功。
 */
function scenePanelWebContents() {
    try {
        if (typeof Editor === 'undefined' || !Editor.Panel) return null;
        if (typeof Editor.Panel.findWindow !== 'function') return null;
        var win = Editor.Panel.findWindow('scene');
        var wc = win && win.nativeWin && win.nativeWin.webContents;
        return wc && !wc.isDestroyed() ? wc : null;
    } catch (e) {
        return null;
    }
}

function evalInScenePanel(code) {
    var wc = scenePanelWebContents();
    if (!wc) {
        return Promise.resolve({ ok: false, reason: '拿不到场景面板（编辑器没开？场景窗口被关了？）' });
    }
    return wc.executeJavaScript(code, true).then(function (v) {
        return { ok: true, value: v };
    }, function (e) {
        return { ok: false, reason: String((e && e.message) || e) };
    });
}

/**
 * 截一张场景面板的图。
 *
 * 为什么需要：`prefab_layout_check` 算的是"几何上不重叠"，那是**算出来的对**；
 * 截图给的是**看起来的对**。两者不能互相替代 —— 九宫格切边画错、字体没生效、
 * 图片尺寸不对，几何全都"对"，但肉眼一看就废。
 *
 * 实现走 `webContents.capturePage(rect)`，rect 是场景面板在页面里的位置
 * （从渲染进程 getBoundingClientRect 拿）。所以截出来只有场景视图，
 * 不带层级面板/属性面板。
 *
 * 注意：截的是**编辑器里当前显示的样子**，包括网格和 gizmo。
 * 场景没打开 / 面板被关掉时直接报错，不返回空白图。
 */
/**
 * 关掉 / 恢复编辑器装饰节点的代码（在场景进程里跑）。
 *
 * 网格和设计分辨率框不是"渲染在画布上的东西"，它们是场景里的真实节点：
 *   Editor Scene Background → Scene Grid（网格）
 *   Editor Scene Foreground → Design Resolution / gizmoRoot
 * 两个都带 HideInHierarchy 标志，正常游戏相机看不到，但编辑器视图能看到。
 * 临时 active=false 就能让截图变干净，截完再打开 —— 不碰文件，也不改用户设置。
 */
var DECO_OFF_CODE =
    'var s=cc.director.getScene(); if(!s) return { skipped: "no scene" };' +
    'var NAMES={"Editor Scene Background":1,"Editor Scene Foreground":1}; var hit=[];' +
    '(function walk(n){ if(NAMES[n.name]){ hit.push(n.name); n.active=false; }' +
    ' (n.children||[]).forEach(walk); })(s);' +
    'return { hidden: hit };';

var DECO_ON_CODE =
    'var s=cc.director.getScene(); if(!s) return { skipped: "no scene" };' +
    'var NAMES={"Editor Scene Background":1,"Editor Scene Foreground":1}; var hit=[];' +
    '(function walk(n){ if(NAMES[n.name]){ hit.push(n.name); n.active=true; }' +
    ' (n.children||[]).forEach(walk); })(s);' +
    'return { shown: hit };';

/**
 * 关掉 / 恢复场景视图里的 DOM 叠加层（在渲染进程里跑，和上面那两条不是同一个进程）。
 *
 * 上面两条管的是 cc 节点（网格、设计分辨率框、gizmoRoot）；编辑器还有一层 HTML
 * 叠加物，它们根本不在场景里，是浮在画布上的 DOM：
 *   #editButtons  预制体编辑态的「PREFAB 保存 关闭」悬浮条（z-index 991）
 *   #helpText     「使用鼠标右键平移视窗焦点…」提示文字
 *   #grid         坐标刻度与数字标尺
 *   #gizmosView   节点名 / gizmo 的 SVG 标签
 * 这些都在 #editor-scene → #border → scene-view#sceneView 的 shadow DOM 里，
 * 裁 rect 躲不掉 —— #editButtons 浮在画布内部，不在顶部的 #editor-toolbar 里。
 *
 * 把原来的 display 记在元素自身属性上，恢复时按标记遍历找回：不依赖 window 全局，
 * 就算 executeJavaScript 换了上下文 / 元素引用变了，也照样能还原，不会把编辑器改坏。
 */
var DECO_DOM_FIND =
    ' function byId(root,id,d){' +
    '  if(d>10||!root) return null;' +
    '  var ks=root.children||[];' +
    '  for(var i=0;i<ks.length;i++){' +
    '   if(ks[i].id===id) return ks[i];' +
    '   var g=byId(ks[i],id,d+1); if(g) return g;' +
    '   if(ks[i].shadowRoot){ g=byId(ks[i].shadowRoot,id,d+1); if(g) return g; }' +
    '  }' +
    '  return null;' +
    ' }';

var DECO_DOM_OFF_CODE =
    '(function(){' + DECO_DOM_FIND +
    ' var host=byId(document,"editor-scene",0);' +
    ' if(!host) return { skipped:"no #editor-scene" };' +
    ' var ids=["editButtons","helpText","grid","gizmosView"]; var hit=[];' +
    ' ids.forEach(function(id){' +
    '  var e=byId(host,id,0); if(!e) return;' +
    '  if(e.getAttribute("data-mcp-deco-off")==="1") return;' +
    '  e.setAttribute("data-mcp-deco-prev", e.style.display||"");' +
    '  e.setAttribute("data-mcp-deco-off","1");' +
    '  e.style.display="none"; hit.push(id);' +
    ' });' +
    ' return { hidden: hit };' +
    '})()';

var DECO_DOM_ON_CODE =
    '(function(){' + DECO_DOM_FIND +
    ' var host=byId(document,"editor-scene",0);' +
    ' if(!host) return { skipped:"no #editor-scene" };' +
    ' var shown=[];' +
    ' function walk(n,d){' +
    '  if(!n||d>10) return; var ks=n.children||[];' +
    '  for(var i=0;i<ks.length;i++){' +
    '   var e=ks[i]; if(!e||!e.getAttribute) continue;' +
    '   if(e.getAttribute("data-mcp-deco-off")==="1"){' +
    '    e.style.display=e.getAttribute("data-mcp-deco-prev")||"";' +
    '    e.removeAttribute("data-mcp-deco-off");' +
    '    e.removeAttribute("data-mcp-deco-prev");' +
    '    shown.push(e.id||e.tagName.toLowerCase());' +
    '   }' +
    '   walk(e,d+1); if(e.shadowRoot) walk(e.shadowRoot,d+1);' +
    '  }' +
    ' }' +
    ' walk(host,0); return { shown: shown };' +
    '})()';

function toolSceneCapture(args) {
    args = args || {};

    var wc = scenePanelWebContents();
    if (!wc) {
        throw new Error('拿不到场景面板 —— 编辑器没开，或者场景窗口被关掉了。' +
            '先确认编辑器开着、场景面板在；这个工具截的是编辑器里的场景视图，' +
            '不是游戏运行画面 —— 要游戏截图用 preview_command。');
    }

    var wantUuid = null;
    if (args.path) {
        var wantAbs = safePath(args.path);
        if (!statSafe(wantAbs)) throw new Error('文件不存在：' + args.path);
        wantUuid = fileUuid(wantAbs);
    }

    var openUuid = null;
    try {
        openUuid = (typeof Editor !== 'undefined' && Editor.currentSceneUuid) || null;
    } catch (e) { /* 不在编辑器里 */ }

    // 校验"编辑器里显示的是不是这个文件"。
    //
    // 不能用 currentSceneUuid 判：预制体编辑态下它还是原场景的 uuid。
    // 只能看场景进程里活场景的 _id（异步，见下面的 checkTarget）。
    // .prefab 跳过这项校验 —— 预制体在编辑态下根本没有对应的 uuid。
    var wantIsScene = !!(wantUuid && String(args.path || '').toLowerCase().slice(-5) === '.fire');

    // clean 默认开：把网格 / 设计分辨率框 / gizmo 临时关掉再截。
    // 它们是场景里的普通节点（Editor Scene Background / Foreground），
    // 关掉不影响文件，截完立刻恢复。
    var clean = args.clean !== false;

    var out = { clean: clean };

    var hideDeco = function () {
        if (!clean) return Promise.resolve();

        // 1) 场景进程里的 cc 节点：网格 / 设计分辨率框 / gizmoRoot
        var ccPart = Promise.resolve().then(function () {
            return toolSceneEval({ code: DECO_OFF_CODE });
        }).then(function (v) {
            // toolSceneEval 的返回是 { ok, source, value }，装饰节点在 value.hidden 里
            var hidden = (v && v.value && v.value.hidden) || [];
            out.cleanApplied = hidden.length > 0;
            if (hidden.length) out.cleanHidden = hidden;
        }, function (e) {
            // 场景进程不可用（预制体态 / 没加载场景）→ 关不掉，如实说，不假装干净
            out.cleanSkipped = String((e && e.message) || e);
        });

        // 2) 渲染进程里的 DOM 叠加层：预制体「保存/关闭」条、提示文字、标尺、gizmo 标签
        var domPart = Promise.resolve().then(function () {
            return evalInScenePanel(DECO_DOM_OFF_CODE);
        }).then(function (r) {
            if (!r.ok) { out.cleanDomSkipped = r.reason; return; }
            var hidden = (r.value && r.value.hidden) || [];
            if (hidden.length) out.cleanDomHidden = hidden;
        }, function (e) {
            out.cleanDomSkipped = String((e && e.message) || e);
        });

        return Promise.all([ccPart, domPart]);
    };

    var showDeco = function () {
        if (!clean) return Promise.resolve();
        var ccPart = Promise.resolve().then(function () {
            return toolSceneEval({ code: DECO_ON_CODE });
        }).then(function () { }, function () { });
        var domPart = Promise.resolve().then(function () {
            return evalInScenePanel(DECO_DOM_ON_CODE);
        }).then(function () { }, function () { });
        return Promise.all([ccPart, domPart]).then(function () { });
    };

    var rectCode =
        '(function(){' +
        ' function findById(root,id,d){' +
        '  if(d>8||!root) return null;' +
        '  var ks=root.children||[];' +
        '  for(var i=0;i<ks.length;i++){' +
        '   if(ks[i].id===id) return ks[i];' +
        '   var g=findById(ks[i],id,d+1); if(g) return g;' +
        '   if(ks[i].shadowRoot){ g=findById(ks[i].shadowRoot,id,d+1); if(g) return g; }' +
        '  }' +
        '  return null;' +
        ' }' +
        ' var host=findById(document,"editor-scene",0);' +
        ' if(!host){' +
        '   var p=Editor.Panel.find("scene");' +
        '   if(!p) return { error: "找不到场景视图元素" };' +
        '   var pb=p.getBoundingClientRect();' +
        '   return { x: Math.round(pb.left), y: Math.round(pb.top),' +
        '     width: Math.round(pb.width), height: Math.round(pb.height), fallback: true };' +
        ' }' +
        ' var hb=host.getBoundingClientRect();' +
        ' var bar=findById(host,"editor-toolbar",0);' +
        ' var barH=bar?bar.getBoundingClientRect().height:0;' +
        ' return { x: Math.round(hb.left), y: Math.round(hb.top+barH),' +
        '   width: Math.round(hb.width), height: Math.round(hb.height-barH),' +
        '   toolbar: Math.round(barH) };' +
        '})()';

    var checkTarget = function () {
        if (!wantIsScene) return Promise.resolve();
        return liveSceneNodes().then(function (lr) {
            if (!lr.ok) return;                      // 读不到活场景就不拦，让截图自己报错
            if (lr.sceneUuid === wantUuid) return;
            throw new Error('编辑器里显示的不是这个场景（当前活场景：「' + lr.sceneName +
                '」，_id=' + lr.sceneUuid + '）。先让它打开：editor_sync {action:"reload", path:"' +
                args.path + '"}，或者在编辑器里双击打开它。' +
                '注意：如果你正在编辑某个预制体，编辑器不会显示场景文件。');
        });
    };

    var doCapture = function () {
        return evalInScenePanel(rectCode).then(function (r) {
            if (!r.ok) throw new Error('读不到场景面板的位置：' + r.reason +
                '。先确认编辑器开着、场景面板可见，再试一次。');
            var rect = r.value || {};
            if (rect.error) throw new Error('读不到场景面板的位置：' + rect.error +
                '。先在编辑器里把场景面板切到前台，再试一次。');
            if (!(rect.width > 50) || !(rect.height > 50)) {
                throw new Error('场景面板太小了（' + rect.width + '×' + rect.height + '），' +
                    '可能被折叠了。先在编辑器里把它展开，再调一次。');
            }
            out.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            if (rect.toolbar) out.toolbarCropped = rect.toolbar;
            if (rect.fallback) out.rectFallback = '没找到 #editor-scene，退回整个面板区域（会带工具栏）';

            // 关掉装饰后要等一帧让场景重绘，否则截到的还是带网格的旧画面
            return new Promise(function (res) { setTimeout(res, 120); }).then(function () {
                return wc.capturePage({
                    x: rect.x, y: rect.y,
                    width: rect.width, height: rect.height
                });
            });
        }).then(function (img) {
            var size = img.getSize();
            var png = img.toPNG();

            if (!png || png.length < 800) {
                throw new Error('截出来是空图（' + (png ? png.length : 0) + ' 字节），场景可能还没渲染完。' +
                    '等一秒再试，或者先 editor_sync {action:"reload"}。');
            }

            var dir = path.join(projectRoot(), 'temp', 'mcp-state', 'shots');
            fs.mkdirSync(dir, { recursive: true });

            try {
                var olds = fs.readdirSync(dir).filter(function (n) { return n.slice(-4) === '.png'; });
                olds.sort();
                for (var i = 0; i < olds.length - 19; i++) {
                    try { fs.unlinkSync(path.join(dir, olds[i])); } catch (e) { /* 忽略 */ }
                }
            } catch (e) { /* 忽略 */ }

            var name = 'scene-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
            var abs = path.join(dir, name);
            fs.writeFileSync(abs, png);

            out.file = relPath(abs);
            out.width = size.width;
            out.height = size.height;
            out.bytes = png.length;
            out.sceneUuid = openUuid;
            var domHidden = out.cleanDomHidden || [];
            var cleaned = !!(out.cleanApplied || domHidden.length);
            var skipped = [];
            if (out.cleanSkipped) skipped.push('场景装饰：' + out.cleanSkipped);
            if (out.cleanDomSkipped) skipped.push('界面叠加层：' + out.cleanDomSkipped);
            out.note = (cleaned
                    ? '已临时关掉编辑器装饰再截（截完已恢复）—— 场景节点'
                        + (out.cleanApplied ? ' ' + (out.cleanHidden || []).join('、') : ' 未能关闭')
                        + '；界面叠加层'
                        + (domHidden.length ? ' ' + domHidden.join('、') : ' 未能关闭')
                        + '（含预制体模式的「保存/关闭」悬浮条）。'
                    : '截的是编辑器场景视图原样（clean:false），会带网格和工具栏。')
                + (skipped.length ? ' 没关掉的部分：' + skipped.join('；') + '。' : '')
                + ' 用它看"看起来对不对"：文字压图、图片拉伸、九宫格切边错位，这些几何自检查不出来。'
                + ' 几何问题还是用 prefab_layout_check，那个不用截图也能定位到节点名。';
            return out;
        });
    };

    return checkTarget().then(hideDeco).then(doCapture).then(function (res) {
        return showDeco().then(function () { return res; });
    }, function (err) {
        return showDeco().then(function () { throw err; });
    });
}

/**
 * 读场景进程里活着的节点。
 *
 * **必须过滤编辑器辅助节点**（Editor Scene Background / Scene Grid / Design Resolution / gizmoRoot…）
 * —— 它们由编辑器注入，不在 .fire 里，不过滤的话每次比对都会误报"编辑器有未保存改动"。
 * 判据用 `cc.Object.Flags.HideInHierarchy`（2.4.15 实测 = 1024）：辅助节点带这个位，
 * 而且它的整棵子树都不该参与比对。
 */
var LIVE_NODES_CODE = '(function(){' +
    ' try {' +
    '  if (typeof cc === "undefined" || !cc.director) return { error: "场景进程里没有 cc.director" };' +
    '  var s = cc.director.getScene();' +
    '  if (!s) return { noScene: true };' +
    '  var HIDDEN = (cc.Object && cc.Object.Flags && cc.Object.Flags.HideInHierarchy) || 1024;' +
    '  var out = [];' +
    '  function walk(n, p) {' +
    '   if (((n._objFlags || 0) & HIDDEN) !== 0) return;' +
    '   var name = n.name || "";' +
    '   var here = p ? (p + "/" + name) : name;' +
    '   out.push({ id: n._id || "", name: name, path: here });' +
    '   var kids = n.children || [];' +
    '   for (var i = 0; i < kids.length; i++) walk(kids[i], here);' +
    '  }' +
    '  walk(s, "");' +
    '  var prefabAsset = null;' +
    '  try {' +
    '   if (s._prefab && s._prefab.asset && s._prefab.asset._uuid) prefabAsset = s._prefab.asset._uuid;' +
    '  } catch (e0) {}' +
    '  return { sceneUuid: s._id, sceneName: s.name, prefabAsset: prefabAsset, nodes: out };' +
    ' } catch (e) { return { error: String(e && e.message || e) }; }' +
    '})()';

/**
 * 最近一次读到的活场景。写盘路径（commitDoc）是同步的，没法现读，
 * 就靠这份缓存给个"刚才编辑器的状态" —— 2 分钟内的数据还算新鲜。
 */
var lastLiveScene = null;

function liveSceneNodes() {
    return evalInScenePanel(LIVE_NODES_CODE).then(function (r) {
        if (!r.ok) return { ok: false, reason: r.reason };
        var v = r.value || {};
        if (v.error) return { ok: false, reason: v.error };
        if (v.noScene) return { ok: false, reason: '场景进程里没有加载场景' };
        lastLiveScene = { id: v.sceneUuid, name: v.sceneName, at: Date.now() };
        return { ok: true, sceneUuid: v.sceneUuid, sceneName: v.sceneName, prefabAsset: v.prefabAsset, nodes: v.nodes || [] };
    });
}

/** 磁盘上这个文件的节点清单（只取 id/name/path，够比对了） */
function fileNodeList(abs) {
    var arr = loadSerialized(abs);
    var info = findRootForEdit(arr);
    var out = [];
    (function walk(id, parentPath) {
        var n = arr[id];
        if (!n || (n.__type__ !== 'cc.Node' && n.__type__ !== 'cc.Scene')) return;
        var name = n._name || (n.__type__ === 'cc.Scene' ? 'Scene' : '');
        var here = parentPath ? (parentPath + '/' + name) : name;
        out.push({ id: n._id || '', name: name, path: here });
        var kids = n._children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i].__id__, here);
    })(info.rootId, '');
    return { kind: info.kind, nodes: out };
}

function fileUuid(abs) {
    try {
        return pathToUuid(relPath(abs));
    } catch (e) {
        return null;
    }
}

/**
 * 轻量版：只回答"编辑器是不是正开着这个文件" + "盘上有没有被外部改过"。
 *
 * 每次写盘后都会调它（写进返回值），所以**必须便宜** —— 不碰场景进程，
 * 只读 .meta 里的 uuid 和台账。真正要对比内容用 editor_sync。
 */
function describeEditorState(abs) {
    try {
        var rel = relPath(abs);
        var uuid = fileUuid(abs);
        var isPrefab = rel.toLowerCase().slice(-7) === '.prefab';
        var openUuid = null;
        try {
            openUuid = (typeof Editor !== 'undefined' && Editor.currentSceneUuid) || null;
        } catch (e) { /* 不在编辑器里 */ }

        // 有新鲜的活场景数据就用它判（准确），没有才退回 uuid 比（可能误判，见下）
        var live = lastLiveScene && (Date.now() - lastLiveScene.at) < 120000 ? lastLiveScene : null;
        var liveIsRealUuid = live && /^[0-9a-fA-F-]{36}$/.test(String(live.id || ''));
        var inTempScene = live ? (!liveIsRealUuid || live.id !== openUuid) : null;

        var ledger = editorState.checkFile(abs);
        var out = {
            uuid: uuid || null,
            rel: rel,
            openInEditor: null,
            externalChange: !!(ledger.tracked && ledger.changed && !ledger.missing)
        };

        if (isPrefab) {
            // 预制体没有"自己的 uuid 就是活场景 uuid"这回事，只能靠 editor_sync 的内容比对。
            // 这里最多给个"编辑器在不在预制体编辑态"的提示。
            out.openInEditor = null;
            if (inTempScene === true) {
                out.editorInTempScene = true;
                out.hint = '编辑器正处在预制体编辑态 —— 不确定是不是这个预制体，' +
                    '调 editor_sync {action:"status", path:"' + rel + '"} 会用节点结构比对确认';
            } else if (inTempScene === false) {
                out.openInEditor = false;
            }
        } else {
            out.openInEditor = live
                ? (live.id === uuid)
                : ((uuid && openUuid) ? (uuid === openUuid) : null);
            if (!live) out.confidence = 'uuid-only';
        }
        if (out.openInEditor) {
            // 注意：这里只是"uuid 对得上"，**不代表活场景就是它** ——
            // 预制体编辑态下 currentSceneUuid 也指向原场景。所以这里只给提示，
            // 真正要不要 reload 由 editor_sync 用活场景 _id 复核后再决定。
            out.needsReload = true;
            out.reloadWith = 'editor_sync {action:"reload"}';
            out.rel = rel;
            out.confidence = 'uuid-only';
        }
        return out;
    } catch (e) {
        return null;
    }
}

/** 写盘后记账：记下这一刻的 mtime/size，下次写之前才能知道中间有没有人动过 */
function noteFileWrite(abs, meta) {
    meta = meta || {};
    var ed = describeEditorState(abs) || {};
    editorState.recordWrite(abs, {
        tool: meta.tool || null,
        openInEditor: ed.openInEditor,
        uuid: ed.uuid,
        ids: meta.ids || null,
        removed: meta.removed || null
    });
    return ed;
}

/**
 * 编辑器内存状态：**磁盘和编辑器内存是不是一回事**。
 *
 * 这个工具解决的是这套 MCP 最根本的矛盾 —— 我们直接改文件，编辑器内存是旧值。
 * 以前只能在返回值里印一句"请重新打开场景"，AI 不知道到底要不要重开、重开会丢什么。
 *
 * - action: status（默认）—— 报状态，不改任何东西
 * - action: reload         —— 让场景面板重新从磁盘加载，然后**验证**节点集合是否对齐
 * - action: clear          —— 清台账
 */
function toolEditorSync(args) {
    args = args || {};
    var action = String(args.action || 'status').toLowerCase();

    if (action === 'clear') {
        var cleared = editorState.clearLedger(args.missingOnly === true);
        return {
            cleared: cleared.cleared,
            removed: cleared.removed || 0,
            ledger: relPath(editorState.ledgerAbs()),
            note: cleared.cleared === 'all'
                ? '台账已清空。之后的写入会重新开始记账，之前的历史比对不出来了。'
                : '只删掉了「文件已经不存在」的条目。'
        };
    }

    if (action !== 'status' && action !== 'reload') {
        throw new Error('action 只能是 status / reload / clear，收到：' + args.action);
    }

    var abs;
    if (args.path) {
        abs = safePath(args.path);
        if (!statSafe(abs)) {
            throw new Error('文件不存在：' + args.path + '。用 list_dir 确认路径。');
        }
    } else {
        abs = currentSceneFile();
        if (!abs) {
            throw new Error('定位不到当前场景文件：编辑器里没打开场景，项目里又有多个 .fire，猜不出该用哪个。' +
                '用 path 参数直接指定，或者先 list_dir 看看项目里有哪些 .fire。');
        }
    }

    var rel = relPath(abs);
    var lower = rel.toLowerCase();
    var kind = lower.slice(-7) === '.prefab' ? 'prefab' : (lower.slice(-5) === '.fire' ? 'scene' : 'other');
    var uuid = fileUuid(abs);

    var openUuid = null;
    try {
        openUuid = (typeof Editor !== 'undefined' && Editor.currentSceneUuid) || null;
    } catch (e) { /* 不在编辑器里 */ }

    var openInEditor = (uuid && openUuid) ? (uuid === openUuid) : null;
    var ledger = editorState.checkFile(abs);

    var out = {
        path: rel,
        kind: kind,
        uuid: uuid,
        openInEditor: openInEditor,
        editorSceneUuid: openUuid,
        ledger: ledger.tracked ? {
            lastWriteAt: ledger.lastWrite.at ? new Date(ledger.lastWrite.at).toISOString() : null,
            lastWriteTool: ledger.lastWrite.tool,
            ageMs: ledger.ageMs,
            changedSinceLastWrite: ledger.changed,
            mtimeDeltaMs: ledger.mtimeDeltaMs,
            sizeDelta: ledger.sizeDelta
        } : null
    };

    var fileInfo = null;
    try {
        fileInfo = fileNodeList(abs);
        out.fileNodes = fileInfo.nodes.length;
    } catch (e) {
        out.fileParseError = String((e && e.message) || e);
    }

    // 只有"编辑器正开着它"时才值得去问场景进程 —— 否则问了也是白问
    var diff = null;
    var live = null;

    function statusWithLive(liveRes) {
        if (!liveRes.ok) {
            out.liveError = liveRes.reason;
            return out;
        }
        live = liveRes;
        out.live = {
            sceneName: liveRes.sceneName,
            sceneUuid: liveRes.sceneUuid,
            nodes: liveRes.nodes.length,
            prefabAsset: liveRes.prefabAsset || null
        };
        if (fileInfo) {
            // 预制体按 path 比（里面节点的 _id 全是空串），场景按 id 比
            diff = editorState.diffNodes(fileInfo.nodes, liveRes.nodes, kind === 'prefab' ? 'path' : 'id');
            out.diff = {
                matched: diff.matched,
                fileOnly: diff.fileOnly,
                liveOnly: diff.liveOnly,
                inSync: diff.inSync
            };
        }
        return out;
    }

    // ── 判定"编辑器里到底显示着什么" ──
    //
    // 关键事实（2.4.15 实测）：进入预制体编辑态时 `Editor.currentSceneUuid`
    // **不会变**，还是原来那个场景的 uuid；变的是场景进程里活场景的 `_id`
    // （临时场景拿到一个 22 位短 id，名字通常是 "New Node"）。
    // 所以只看 currentSceneUuid 会误判 —— 明明在编预制体，却报告"场景开着"，
    // 那时让它 reload 会把用户从预制体编辑态里踢出去。
    //
    // 真正的判据：活场景的 `_id` 必须等于文件的 uuid。
    var ready = liveSceneNodes().then(function (liveRes) {
        out.liveReadable = liveRes.ok;
        if (!liveRes.ok) {
            out.liveError = liveRes.reason;
            out.openInEditor = null;
            out.detectNote = '读不到场景进程的活节点（' + liveRes.reason + '），判断不了编辑器里显示的是什么。';
            return out;
        }

        out.live = {
            sceneName: liveRes.sceneName,
            sceneUuid: liveRes.sceneUuid,
            nodes: liveRes.nodes.length,
            prefabAsset: liveRes.prefabAsset || null
        };

        var liveIsThisFile = !!(uuid && liveRes.sceneUuid === uuid);
        var uuidLooksReal = /^[0-9a-fA-F-]{36}$/.test(String(liveRes.sceneUuid || ''));
        out.editorInTempScene = !uuidLooksReal || liveRes.sceneUuid !== openUuid;

        if (kind === 'scene') {
            out.openInEditor = liveIsThisFile;
            if (!liveIsThisFile) {
                if (openUuid === uuid) {
                    out.detectNote = 'Editor.currentSceneUuid 是它，但场景进程里的活场景是「' +
                        liveRes.sceneName + '」—— 编辑器正处在预制体编辑态或临时场景，这个场景其实没在显示。' +
                        '（这也是为什么 reload 必须用活场景 _id 校验，否则会把你从预制体里踢出去。）';
                } else {
                    out.detectNote = '编辑器当前显示的是「' + liveRes.sceneName + '」，不是这个文件。';
                }
                return out;
            }
            if (fileInfo) {
                diff = editorState.diffNodes(fileInfo.nodes, liveRes.nodes, 'id');
                out.diff = {
                    matched: diff.matched,
                    fileOnly: diff.fileOnly,
                    liveOnly: diff.liveOnly,
                    inSync: diff.inSync
                };
            }
            return out;
        }

        // ── 预制体 ──
        if (!out.editorInTempScene) {
            out.openInEditor = false;
            out.detectNote = '编辑器当前在普通场景「' + liveRes.sceneName + '」里，没在编辑预制体。';
            return out;
        }

        // 临时场景里找"和这个预制体完全同构"的子树。
        // 预制体编辑态下活场景是「New Node」，预制体根是它的子节点，
        // 所以按相对路径签名比，而不是按绝对路径。
        var match = fileInfo ? editorState.findMatchingSubtree(fileInfo.nodes, liveRes.nodes) : null;
        if (match) {
            out.openInEditor = true;
            out.openInEditorGuess = '编辑器处在临时场景（活场景 _id=' + liveRes.sceneUuid + '），' +
                '里面有一棵和这个预制体高度重合的子树（' + match.nodes + ' 个节点，根路径 ' + match.path +
                '，重合度 ' + Math.round(match.score * 100) + '%）';
            if (fileInfo) {
                // 路径要"换基准"：活节点在 New Node/CircleView 下面，
                // 预制体文件里是 CircleView 开头。不换基准两边一条都对不上，
                // 会误报"32 个节点全是编辑器里新加的"。
                var liveBase = match.path;
                var fileBase = fileInfo.nodes[0].path;
                var inSub = function (p) {
                    return p === liveBase || String(p).indexOf(liveBase + '/') === 0;
                };
                var rebased = liveRes.nodes.filter(function (n) { return inSub(n.path); })
                    .map(function (n) {
                        return { id: n.id, name: n.name, path: fileBase + n.path.slice(liveBase.length) };
                    });
                diff = editorState.diffNodes(fileInfo.nodes, rebased, 'path');
                out.diff = {
                    matched: diff.matched,
                    fileOnly: diff.fileOnly,
                    liveOnly: diff.liveOnly,
                    inSync: diff.inSync
                };
            }
            return out;
        }

        out.openInEditor = false;
        out.detectNote = '编辑器处在临时场景「' + liveRes.sceneName + '」，但没有和这个预制体同构的子树 ' +
            '→ 判断为没在编辑它（可能在编辑别的预制体，或是个没保存的新场景）。';
        return out;
    });

    return ready.then(function () {
        var cls = editorState.classify({
            ledger: ledger,
            diff: diff,
            openInEditor: out.openInEditor
        });
        out.risk = cls.risk;
        out.needsReload = cls.needsReload;
        out.losesOnReload = cls.losesOnReload;
        out.advice = cls.advice;

        if (action !== 'reload') {
            out.note = out.risk === 'none'
                ? '磁盘和编辑器内存一致，没有需要处理的。'
                : 'risk=' + out.risk + '：' + out.advice;
            return out;
        }

        // ── reload ──
        // 预制体编辑态没法从外部重载：`_loadScene(uuid)` 只认场景，传预制体 uuid 什么也不会发生；
        // 唯一"重载"整窗（webContents.reload）会把用户的整个编辑会话打掉，代价太大。
        // 与其假装成功，不如把该怎么做说清楚。
        if (kind === 'prefab' && out.openInEditor) {
            throw new Error('预制体编辑态没法从外部重载（2.4.15 的编辑器没有对外接口，' +
                '唯一能做到的是重载整个编辑器窗口，代价太大）。' +
                '请在编辑器里**不要保存**，直接关掉这个预制体再重新打开 —— ' +
                '保存会用编辑器内存里的旧版本覆盖掉刚才的改动。' +
                '或者告诉我"丢弃编辑器里的改动"，我们再想别的办法。');
        }
        if (!out.openInEditor) {
            throw new Error('编辑器里没开着这个文件，不需要重载。' +
                (kind === 'prefab' ? '（预制体编辑模式判断不出来时，请手动关掉预制体再打开。）' : ''));
        }
        if (!uuid) {
            throw new Error('这个文件没有 uuid（没有 .meta？先 refresh_assets 让编辑器导入）。');
        }
        // 只有"用户真在编辑器里新建的节点"才需要 force —— 我们自己删掉的节点
        // 在内存里还留着是正常现象，重载掉它正是目的。
        if (out.losesOnReload > 0 && args.force !== true) {
            throw new Error('编辑器内存里有 ' + out.losesOnReload + ' 个磁盘上从来没有过的节点（' +
                (out.unexpectedLive || []).slice(0, 5).map(function (x) { return x.name; }).join(', ') +
                '）。重载会把它们丢掉。确认要丢就传 force:true，否则先在编辑器里保存。');
        }

        var doReload = function () {
            return evalInScenePanel(
                '(function(){' +
                ' var p = Editor.Panel.find("scene");' +
                ' if (!p) return { error: "找不到 scene 面板实例" };' +
                ' if (typeof p._loadScene !== "function") return { error: "面板上没有 _loadScene" };' +
                ' p._loadScene(' + JSON.stringify(uuid) + ');' +
                ' return { called: true };' +
                '})()'
            );
        };

        // 先让编辑器把新文件导进 library —— _loadScene 读的是导入后的资源
        var pre = Promise.resolve();
        if (lower.indexOf('assets/') === 0 && args.refresh !== false) {
            pre = refreshAssetUrl('db://' + rel).then(function (err) {
                out.refreshed = !err;
                if (err) out.refreshError = String((err && err.message) || err);
            }, function () { /* 刷新失败也继续试重载 */ });
        }

        var t0 = Date.now();
        var waitMs = typeof args.waitMs === 'number' ? Math.min(args.waitMs, 30000) : 8000;

        return pre.then(doReload).then(function (r) {
            if (!r.ok) throw new Error('调不动场景面板：' + r.reason +
                '。先确认编辑器开着、场景面板可见，再试一次。');
            var v = r.value || {};
            if (v.error) throw new Error('重载失败：' + v.error);

            function poll() {
                if (Date.now() - t0 > waitMs) {
                    return {
                        reloaded: false,
                        timedOut: true,
                        waitedMs: Date.now() - t0,
                        note: '已发出重载指令但 ' + waitMs + 'ms 内没等到节点集合对齐。' +
                            '场景可能在加载中，也可能 _loadScene 被别的东西挡住了 —— 再调一次 status 看看。'
                    };
                }
                return new Promise(function (r2) { setTimeout(r2, 350); }).then(liveSceneNodes).then(function (lr) {
                    if (lr.ok && fileInfo) {
                        var d2 = editorState.diffNodes(fileInfo.nodes, lr.nodes, kind === 'prefab' ? 'path' : 'id');
                        if (d2.inSync) {
                            // 顶层 live/diff 也要换成重载后的值 —— 否则调用方看到的是
                            // "reloaded:true" 旁边挂着重载前那份旧 diff，很容易误判
                            return {
                                reloaded: true,
                                verified: true,
                                waitedMs: Date.now() - t0,
                                losesOnReload: 0,
                                nodes: lr.nodes.length,
                                live: {
                                    sceneName: lr.sceneName,
                                    sceneUuid: lr.sceneUuid,
                                    nodes: lr.nodes.length,
                                    prefabAsset: lr.prefabAsset || null
                                },
                                diff: {
                                    matched: d2.matched,
                                    fileOnly: d2.fileOnly,
                                    liveOnly: d2.liveOnly,
                                    inSync: true
                                },
                                note: '重载完成并已验证：磁盘和编辑器内存的节点集合一致（' + lr.nodes.length + ' 个节点）。'
                            };
                        }
                        out._lastDiff = d2;
                    }
                    return poll();
                });
            }
            return poll();
        }).then(function (res) {
            for (var k in res) {
                if (Object.prototype.hasOwnProperty.call(res, k)) out[k] = res[k];
            }
            if (out.reloaded) {
                out.risk = 'none';
                out.needsReload = false;
                out.advice = null;
            }
            return out;
        });
    });
}

//#endregion

//#region 合并工具的转发层（v0.4.0）

/**
 * v0.4.0 把 9 组"同一个动作、不同输入形态"的工具合并了。
 * 这个表是**旧名 → 新名**的翻译，保证老脚本/老提示词不会突然报"未知工具"。
 * 命中时会自动补参数（比如 detail / sideEffects / source），并在返回里
 * 带 __renamedFrom，让调用方知道该改口了。
 */
var RENAMED = {
    read_scene_node: { to: 'query_scene_tree', detail: true },
    mcp_audit: { to: 'mcp_selftest', sideEffects: false },
    mcp_verify_all: { to: 'mcp_selftest', sideEffects: true },
    resolve_uuid: { to: 'resolve_asset', fromUuid: true },
    resolve_sprite_frame: { to: 'resolve_asset', fromPath: true },
    execute_script: { to: 'run_script' },
    execute_script_file: { to: 'run_script' },
    prefab_instantiate: { to: 'scene_add_node', fromPrefab: true },
    prefab_create_from_node: { to: 'prefab_create', fromNode: true },
    scene_ping: { to: 'scene_diagnose' },
    scene_probe: { to: 'scene_diagnose', probe: true },
    runtime_console: { to: 'runtime_report', source: 'scene' },
    preview_report: { to: 'runtime_report', source: 'preview' },
    runtime_browser_report: { to: 'runtime_report', source: 'build' },
    runtime_eval: { to: 'eval_scene' },
    scene_eval: { to: 'eval_scene' },

    // ---- v0.8.0：30 个"同一动作域"的工具并入 8 个 cmd 型入口 ----
    // 注意：v0.4.0 的旧名有些指向这里的中继名（如 prefab_instantiate → scene_add_node），
    // callTool 会沿着链一路解析到最终的新名，所以那批老名字不用改。
    scene_add_node: { to: 'scene_edit', cmd: 'add-node' },
    scene_remove_node: { to: 'scene_edit', cmd: 'remove-node' },
    scene_move_node: { to: 'scene_edit', cmd: 'move-node' },
    scene_set_props: { to: 'scene_edit', cmd: 'set-props' },
    scene_add_component: { to: 'scene_edit', cmd: 'add-component' },
    scene_remove_component: { to: 'scene_edit', cmd: 'remove-component' },
    scene_set_component_props: { to: 'scene_edit', cmd: 'set-component-props' },
    scene_apply: { to: 'scene_edit', cmd: 'apply' },

    asset_query: { to: 'asset', cmd: 'query' },
    asset_move: { to: 'asset', cmd: 'move' },
    asset_delete: { to: 'asset', cmd: 'delete' },
    asset_meta_get: { to: 'asset', cmd: 'meta-get' },
    asset_meta_set: { to: 'asset', cmd: 'meta-set' },

    prefab_create: { to: 'prefab', cmd: 'create' },
    prefab_layout_check: { to: 'prefab', cmd: 'check-layout' },
    prefab_diff: { to: 'prefab', cmd: 'diff' },

    build_targets: { to: 'build', cmd: 'targets' },
    build_project: { to: 'build', cmd: 'start' },
    build_status: { to: 'build', cmd: 'status' },

    project_settings_get: { to: 'project_settings', cmd: 'get' },
    project_settings_set: { to: 'project_settings', cmd: 'set' },

    runtime_info: { to: 'runtime', cmd: 'info' },
    runtime_read: { to: 'runtime', cmd: 'read' },
    runtime_inject: { to: 'runtime', cmd: 'inject' },
    runtime_report: { to: 'runtime', cmd: 'report' },
    eval_scene: { to: 'runtime', cmd: 'eval' },

    preview_control: { to: 'preview', cmd: 'control' },
    preview_command: { to: 'preview', cmd: 'command' },

    get_editor_log: { to: 'editor', cmd: 'log' },
    script_compile_status: { to: 'editor', cmd: 'compile-status' }
};

/** 旧名参数 → 新名参数（只补默认值，不改调用方显式给的东西） */
function migrateLegacyArgs(oldName, args) {
    var r = RENAMED[oldName];
    var out = {};
    for (var k in (args || {})) {
        if (Object.prototype.hasOwnProperty.call(args, k)) out[k] = args[k];
    }
    if (r.cmd && out.cmd === undefined) out.cmd = r.cmd;
    if (r.detail) out.detail = true;
    if (r.sideEffects !== undefined) out.sideEffects = r.sideEffects;
    if (r.probe) out.probe = true;
    if (r.source) out.source = r.source;
    if (r.fromPrefab) out.from = 'prefab';
    if (r.fromNode) out.from = 'node';
    if (r.fromPath && out.input === undefined) out.input = out.path;
    if (r.fromUuid && out.input === undefined) out.input = out.uuid;
    return out;
}

/** 自检：默认只跑无副作用的；sideEffects:true 跑完整版（原 mcp_verify_all） */
function toolMcpSelftest(args) {
    args = args || {};
    if (args.sideEffects === true) {
        return toolMcpVerifyAll({ only: args.only, cleanup: args.cleanup });
    }
    return toolMcpAudit({ only: args.only, deep: args.deep });
}

/**
 * 资源解析：不传 input 时退化成"列出所有 sprite-frame"（原 resolve_sprite_frame 的用法），
 * 传了就做 uuid/路径互转，图片顺带把 spriteFrames 一起给出来。
 */
function toolResolveAsset(args) {
    args = args || {};
    var q = args.input || args.uuid || args.path;

    if (!q) return toolResolveSpriteFrame({});

    var out = toolResolveUuid({ uuid: String(q).trim() });
    var relPath = out.path || String(q).trim();

    // 图片：直接给 sprite-frame，省掉第二次调用（也顺手避免填错 texture uuid）
    if (out.exists && (out.kind === 'image' || out.resourceType === 'sprite-frame')) {
        try {
            var sf = toolResolveSpriteFrame({ path: relPath });
            out.spriteFrames = sf.spriteFrames || [];
            out.spriteFrameUuid = sf.spriteFrameUuid || null;
            out.mainUuid = sf.mainUuid || null;
            out.mainUuidIsTexture = true;
        } catch (e) {
            out.spriteFrameError = String(e.message || e);
        }
    }

    if (args.parts) {
        try {
            var metaAbs = safePath(relPath) + '.meta';
            if (statSafe(metaAbs)) {
                var meta = JSON.parse(fs.readFileSync(metaAbs, 'utf8'));
                out.subMetas = meta.subMetas || {};
                out.parts = Object.keys(out.subMetas);
            } else {
                out.parts = [];
            }
        } catch (e2) {
            out.partsError = String(e2.message || e2);
        }
    }

    return out;
}

/** 跑 JS：给 path 从文件读（长脚本），给 code 直接执行 */
function toolRunScript(args) {
    args = args || {};
    if (args.path) return toolExecuteScriptFile({ path: args.path });
    if (args.code) return toolExecuteScript({ code: args.code });
    throw new Error('缺少 path 或 code：长脚本用 path（项目内 .js 文件），短脚本用 code');
}

/** 场景进程求值：code 多语句 / expr 单表达式（原 scene_eval 与 runtime_eval） */
function toolEvalScene(args) {
    args = args || {};
    if (args.code) return toolSceneEval({ code: args.code });
    if (args.expr) return toolRuntimeEval({ expr: args.expr });
    throw new Error('缺少 code 或 expr：多语句用 code（可 return），单个表达式用 expr');
}

/** 诊断：默认看文件层与通道；probe:true 探场景进程能力 */
function toolSceneDiagnose(args) {
    args = args || {};
    if (args.probe === true) return toolSceneProbe({ timeout: args.timeout });
    return toolScenePing({ path: args.path, skipSceneScript: args.skipSceneScript });
}

/**
 * 运行时报告：三个来源共用一个入口。
 * 不在这里做归一化 —— 三个来源的字段本来就不同（硬凑成一套会丢信息），
 * 靠返回里的 source 字段标明来源即可。
 */
function toolRuntimeReport(args) {
    args = args || {};
    var source = String(args.source || 'scene').toLowerCase();
    var out;

    if (source === 'scene') out = toolRuntimeConsole(args);
    else if (source === 'preview') out = toolPreviewReport(args);
    else if (source === 'build') out = toolRuntimeBrowserReport(args);
    else throw new Error('source 只能是 scene / preview / build，收到：' + args.source);

    if (out && typeof out === 'object' && !Array.isArray(out)) out.source = source;
    return out;
}

//#endregion

//#region 聚合工具分发（v0.8.0）

/**
 * 8 个 cmd 型入口共用的转发器。
 *
 * 只做两件事：按 cmd 挑原来的实现函数；把 cmd 从参数里摘掉再传下去
 * （原实现不认识 cmd，多余字段一般无害，但别给它机会被误当成业务参数）。
 * 原来的实现一行没改 —— 合并只动"入口"，不动"行为"，回归测试才能证明等价。
 */
function dispatchByCmd(args, map, toolName) {
    args = args || {};
    var cmd = args.cmd;
    if (!cmd || !Object.prototype.hasOwnProperty.call(map, cmd)) {
        throw new Error(toolName + ' 的 cmd 只能是 ' + Object.keys(map).join(' / ') +
            '，收到：' + (cmd === undefined ? '（没传）' : JSON.stringify(cmd)) +
            '。看 tools/list 里这个工具的 description 查每个 cmd 需要哪些参数。');
    }
    var a = {};
    for (var k in args) {
        if (Object.prototype.hasOwnProperty.call(args, k) && k !== 'cmd') a[k] = args[k];
    }
    return map[cmd](a);
}

function toolSceneEdit(args) {
    return dispatchByCmd(args, {
        'add-node': toolSceneAddNode,
        'remove-node': toolSceneRemoveNode,
        'move-node': toolSceneMoveNode,
        'set-props': toolSceneSetProps,
        'add-component': toolSceneAddComponent,
        'remove-component': toolSceneRemoveComponent,
        'set-component-props': toolSceneSetComponentProps,
        'apply': toolSceneApply
    }, 'scene_edit');
}

function toolAsset(args) {
    return dispatchByCmd(args, {
        'query': toolAssetQuery,
        'move': toolAssetMove,
        'delete': toolAssetDelete,
        'meta-get': toolAssetMetaGet,
        'meta-set': toolAssetMetaSet
    }, 'asset');
}

function toolPrefab(args) {
    return dispatchByCmd(args, {
        'create': toolPrefabCreate,
        'check-layout': toolPrefabLayoutCheck,
        'diff': toolPrefabDiff
    }, 'prefab');
}

function toolBuild(args) {
    return dispatchByCmd(args, {
        'targets': toolBuildTargets,
        'start': toolBuildProject,
        'status': toolBuildStatus
    }, 'build');
}

function toolProjectSettings(args) {
    return dispatchByCmd(args, {
        'get': toolProjectSettingsGet,
        'set': toolProjectSettingsSet
    }, 'project_settings');
}

function toolRuntime(args) {
    return dispatchByCmd(args, {
        'info': toolRuntimeInfo,
        'read': toolRuntimeRead,
        'eval': toolEvalScene,
        'report': toolRuntimeReport,
        'inject': toolRuntimeInject
    }, 'runtime');
}

function toolPreview(args) {
    return dispatchByCmd(args, {
        'control': toolPreviewControl,
        'command': toolPreviewCommand
    }, 'preview');
}

function toolEditor(args) {
    return dispatchByCmd(args, {
        'log': toolGetEditorLog,
        'compile-status': toolScriptCompileStatus
    }, 'editor');
}

//#endregion

/**
 * 工具名 → 实现函数。
 *
 * 为什么不用 switch：以前加一个工具要改 schema、switch、probes、test、两份文档；
 * switch 里少一个 case 的报错是"未知工具"，跟真实原因对不上。
 * 现在这张表 + tools/list 的表会在启动时互相比对，缺哪个直接点名。
 * v0.8.0 起旧工具名不在这张表里 —— 它们由 callTool 的 RENAMED 链转发，
 * 所以 TOOLS 与 IMPL 仍然是严格一一对应的 28 项。
 */
var IMPL = {
    get_project_info: toolGetProjectInfo,
    list_dir: toolListDir,
    search_files: toolSearchFiles,
    read_file: toolReadFile,
    write_file: toolWriteFile,
    edit_file: toolEditFile,
    query_scene_tree: toolQuerySceneTree,
    mcp_selftest: toolMcpSelftest,
    resolve_asset: toolResolveAsset,
    asset_refs: toolAssetRefs,
    run_script: toolRunScript,
    refresh_assets: toolRefreshAssets,
    list_open_projects: toolListOpenProjects,
    set_target_project: toolSetTargetProject,
    hub_control: toolHubControl,
    scene_diagnose: toolSceneDiagnose,
    project_doctor: toolProjectDoctor,
    editor_sync: toolEditorSync,
    scene_capture: toolSceneCapture,
    scene_create: toolSceneCreate,
    // v0.8.0 的 8 个聚合入口
    scene_edit: toolSceneEdit,
    asset: toolAsset,
    prefab: toolPrefab,
    build: toolBuild,
    project_settings: toolProjectSettings,
    runtime: toolRuntime,
    preview: toolPreview,
    editor: toolEditor
};

function dispatchTool(name, args) {
    var fn = IMPL[name];
    if (!fn) {
        throw new Error('未知工具：' + name + '。v0.8.0 把 30 个工具并进了 8 个 cmd 型入口：' +
            'scene_edit / asset / prefab / build / project_settings / runtime / preview / editor，' +
            '旧名（含 v0.4.0 那批）仍可调用，callTool 会自动转发并带上 __renamedFrom。' +
            '不确定用哪个就看 tools/list；聚合工具别忘了传 cmd。');
    }
    return fn(args);
}

/**
 * 三张表的一致性校验（启动时跑一次）。
 *
 * 以前 probes 漏登记 = 自检里静默跳过，工具等于白做了一块验证。
 * 现在漏了直接告警 + 在 mcp_selftest 的 problems 里点名。
 */
function registryProblems() {
    var problems = [];
    var seen = {};
    TOOLS.forEach(function (t) {
        seen[t.name] = true;
        if (typeof IMPL[t.name] !== 'function') problems.push('TOOLS 里有 ' + t.name + '，但 IMPL 里没有实现');
    });
    Object.keys(IMPL).forEach(function (k) {
        if (!seen[k]) problems.push('IMPL 里有 ' + k + '，但 TOOLS 里没声明（客户端看不到它）');
    });
    return problems;
}

//#endregion

//#region MCP 协议

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id: id, result: result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
}

/**
 * 返回值可能是对象，也可能是 Promise（execute_script / refresh_assets）。
 * 调用方统一 Promise.resolve 包一层。
 */
function handleRpc(msg) {
    var id = msg.id;
    var method = msg.method;

    // 通知类消息没有 id，不需要回复
    if (id === undefined || id === null) return null;

    if (method === 'initialize') {
        return rpcResult(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: PKG_NAME, version: VERSION, instanceId: INSTANCE_ID },
            instructions: 'Cocos Creator 2.x 项目操作入口。文件读写限制在项目目录内。' +
                '读代码先 search_files，看场景先 query_scene_tree，改完 .fire/.prefab 记得 refresh_assets（不传参即可）。\n\n' +
                TOOL_CONTRACT
        });
    }

    if (method === 'tools/list') {
        // 每个描述后面只追加**一行**脚注（__status 怎么读）。
        // 完整契约在 initialize.instructions 里说一次 —— 拼 44 遍等于把
        // tools/list 撑到 150KB+，客户端每会话都要付这个成本。
        var tools = TOOLS.map(function (t) {
            return {
                name: t.name,
                description: t.description + TOOL_FOOTER,
                inputSchema: t.inputSchema
            };
        });
        return rpcResult(id, { tools: tools });
    }

    if (method === 'tools/call') {
        var params = msg.params || {};
        var name = params.name;
        var args = params.arguments || {};
        return Promise.resolve()
            .then(function () { return callTool(name, args); })
            .then(function (out) {
                var text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
                return rpcResult(id, { content: [{ type: 'text', text: text }] });
            })
            .catch(function (e) {
                return rpcResult(id, {
                    content: [{ type: 'text', text: '错误：' + (e && e.message ? e.message : String(e)) }],
                    isError: true
                });
            });
    }

    if (method === 'ping') {
        return rpcResult(id, {});
    }

    return rpcError(id, -32601, '未实现的方法：' + method);
}

//#endregion

//#region HTTP 服务

function startServer(port, attempt) {
    attempt = attempt || 0;
    if (attempt >= PORT_RETRY) {
        Editor.error(LOG, '端口 ' + BASE_PORT + '~' + (BASE_PORT + PORT_RETRY) + ' 都被占用，服务启动失败');
        return;
    }

    var s = http.createServer(function (req, res) {
        // 场景进程回传专用端点。
        // 场景窗口是渲染进程，sendToMain 不保证路由到我们（实测会丢），
        // 但只要能 require('http')，直接 POST 回自己的服务是最可靠的一条路。
        // 浏览器侧运行时上报端点。
        // 注入到 web 构建里的脚本会定时 POST 运行时状态到这里。
        // 和 /scene-result 分开：那个是编辑器内的场景进程，这个是浏览器里的游戏。
        // ── Web 预览桥接 ────────────────────────────────────────────
        // 预览页里的 bridge.js 用这些端点和扩展通信。
        // 和 /runtime-report 分开：那个是 build 产物里的注入脚本，
        // 这个是引擎自己的 Web 预览（即时编译，不���要 build）。

        if (req.method === 'POST' && req.url && req.url.indexOf('/bridge/report') === 0) {
            var brBody = '';
            req.on('data', function (chunk) {
                brBody += chunk;
                if (brBody.length > 8 * 1024 * 1024) req.destroy();
            });
            req.on('end', function () {
                var rep = null;
                try { rep = JSON.parse(brBody); } catch (e) { /* 忽略 */ }
                if (rep) {
                    bridgeState.connected = true;
                    bridgeState.lastAt = Date.now();
                    bridgeState.lastReport = rep;
                    if (rep.logs && rep.logs.length) {
                        for (var li = 0; li < rep.logs.length; li++) {
                            bridgePushLog(rep.logs[li]);
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            });
            return;
        }

        if (req.method === 'GET' && req.url && req.url.indexOf('/bridge/commands') === 0) {
            var since = 0;
            var m = /since=(\d+)/.exec(req.url);
            if (m) since = parseInt(m[1], 10) || 0;
            var pending = bridgeState.commands.filter(function (c) { return c.seq > since; });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ commands: pending }));
            return;
        }

        if (req.method === 'POST' && req.url && req.url.indexOf('/bridge/result') === 0) {
            var bresBody = '';
            req.on('data', function (chunk) {
                bresBody += chunk;
                if (bresBody.length > 1024 * 1024) req.destroy();
            });
            req.on('end', function () {
                var r = null;
                try { r = JSON.parse(bresBody); } catch (e) { /* 忽略 */ }
                if (r && r.id) {
                    bridgeState.results[r.id] = r;
                    bridgeState.resultOrder.push(r.id);
                    if (bridgeState.resultOrder.length > BRIDGE_MAX_RESULTS) {
                        var old = bridgeState.resultOrder.shift();
                        delete bridgeState.results[old];
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            });
            return;
        }

        if (req.method === 'POST' && req.url && req.url.indexOf('/bridge/bye') === 0) {
            bridgeState.connected = false;
            bridgeState.byeAt = Date.now();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }

        if (req.method === 'POST' && req.url && req.url.indexOf('/runtime-report') === 0) {
            var rbBody = '';
            req.on('data', function (chunk) {
                rbBody += chunk;
                if (rbBody.length > 8 * 1024 * 1024) req.destroy();
            });
            req.on('end', function () {
                var report = null;
                try {
                    report = JSON.parse(rbBody);
                } catch (e) { /* 忽略 */ }

                if (report) {
                    browserReports.count++;
                    browserReports.lastAt = Date.now();
                    browserReports.last = report;
                    // 只留最近几份，AI 可以对比前后变化
                    browserReports.history.push({ at: browserReports.lastAt, report: report });
                    if (browserReports.history.length > 20) browserReports.history.shift();
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            });
            return;
        }

        if (req.method === 'POST' && req.url && req.url.indexOf('/scene-result') === 0) {
            var cbBody = '';
            req.on('data', function (chunk) {
                cbBody += chunk;
                if (cbBody.length > 1024 * 1024) req.destroy();
            });
            req.on('end', function () {
                var env = null;
                try {
                    env = JSON.parse(cbBody);
                } catch (e) {
                    // 忽略非法 JSON
                }
                sceneCallbackHits.total++;
                sceneCallbackHits.lastId = env && env.__id ? env.__id : null;
                sceneCallbackHits.lastAt = Date.now();

                var settle = env && env.__id ? pendingSceneCalls[env.__id] : null;
                if (!settle) sceneCallbackHits.unknown++;
                if (settle) {
                    settle(env);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                    return;
                }
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end('{"ok":false,"reason":"unknown request id"}');
            });
            return;
        }

        // 只接受 POST /mcp
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('Method Not Allowed');
            return;
        }

        var body = '';
        req.on('data', function (chunk) {
            body += chunk;
            // 防止超大请求打爆内存
            if (body.length > 8 * 1024 * 1024) {
                req.destroy();
            }
        });

        req.on('end', function () {
            var msg;
            try {
                msg = JSON.parse(body);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(rpcError(null, -32700, 'JSON 解析失败')));
                return;
            }

            Promise.resolve()
                .then(function () { return maybeForward(msg); })
                .then(function (reply) {
                    // null = 本地处理
                    if (reply === null || reply === undefined) return handleRpc(msg);
                    return reply;
                })
                .then(function (reply) {
                    // 通知类消息返回 202 空体
                    if (reply === null) {
                        res.writeHead(202);
                        res.end();
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(reply));
                })
                .catch(function (e) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(rpcError(msg && msg.id, -32603, e && e.message ? e.message : String(e))));
                });
        });
    });

    s.on('error', function (err) {
        if (err && err.code === 'EADDRINUSE') {
            Editor.warn(LOG, '端口 ' + port + ' 被占用，尝试 ' + (port + 1));
            startServer(port + 1, attempt + 1);
        } else {
            Editor.error(LOG, '服务异常：' + (err && err.message));
        }
    });

    s.listen(port, '127.0.0.1', function () {
        server = s;
        listeningPort = port;
        var regFile = writeRegistry(port);

        // 启动即自动注入运行时上报（静默）。端口这会儿才确定，注入配置里要写对。
        ensureRuntimeInjected();

        Editor.success(LOG, 'MCP 已启动 → http://127.0.0.1:' + port + '/mcp');
        Editor.log(LOG, '项目：' + projectRoot());
        if (regFile) Editor.log(LOG, '端口已登记：' + regFile);
        Editor.log(LOG, '把这行加进 ~/.workbuddy/mcp.json：');
        Editor.log(LOG, '  "cocos-mcp-2x": { "type": "http", "url": "http://127.0.0.1:' + port + '/mcp" }');
    });
}

function stopServer() {
    clearRegistry();
    if (!server) return;
    try {
        server.close();
    } catch (e) { /* 忽略 */ }
    server = null;
    listeningPort = 0;
}

//#endregion

module.exports = {

    load: function () {
        Editor.log(LOG, 'v' + VERSION + ' 扩展加载中，项目路径 = ' + projectRoot());

        // 三张表（TOOLS / IMPL / 体检表）对不上就是 bug，启动时就说，
        // 别等用到那个工具才发现"未知工具"或"自检跳过了它"
        var regProblems = registryProblems();
        if (regProblems.length) {
            Editor.error(LOG, '工具登记不一致（' + regProblems.length + ' 处）：' + regProblems.join('；'));
        }

        // Package.load() 对已在运行的包会再调一次 load，这时旧 server 还占着端口，
        // 不先停掉就会开到 25901 → 25902，注册表跟着漂移
        stopServer();
        ensureSceneListener();
        ensureHubRunning();
        startServer(BASE_PORT);
    },

    unload: function () {
        stopServer();
        Editor.log(LOG, '扩展已卸载，服务已停止');
    },

    messages: {

        // 场景进程回传通道。场景脚本里调 Editor.Ipc.sendToMain('cocos-mcp-2x:scene-result', env)，
        // 编辑器会剥掉包名前缀，路由到这里。
        'scene-result': function (event, envelope) {
            if (!envelope || !envelope.__id) return;
            var settle = pendingSceneCalls[envelope.__id];
            if (settle) settle(envelope);
        },

        'status': function () {
            if (server && listeningPort) {
                Editor.log(LOG, '运行中 v' + VERSION + ' → http://127.0.0.1:' + listeningPort + '/mcp');
                Editor.log(LOG, '配置片段：');
                Editor.log(LOG, '  "cocos-mcp-2x": { "type": "http", "url": "http://127.0.0.1:' + listeningPort + '/mcp" }');
            } else {
                Editor.warn(LOG, '未运行');
            }
        },

        'restart': function () {
            Editor.log(LOG, '正在重启服务…');
            stopServer();
            setTimeout(function () {
                startServer(BASE_PORT);
            }, 300);
        },

        'projects': function () {
            var r = toolListOpenProjects();
            Editor.log(LOG, '注册表：' + r.dir);
            if (!r.count) {
                Editor.log(LOG, '（没有其他项目登记过）');
                return;
            }
            for (var i = 0; i < r.projects.length; i++) {
                var p = r.projects[i];
                Editor.log(LOG, '  ' + p.port + '  ' + p.name +
                    (p.isCurrent ? '  ← 当前项目' : '') + (p.isTarget ? '  ★ 目标项目' : ''));
                Editor.log(LOG, '      ' + p.project);
            }
            if (r.target) Editor.log(LOG, 'AI 现在操作的是：' + r.target.name);
            else Editor.log(LOG, '还没设目标项目，AI 操作的是它连上的那个实例');
        },

        'hub-start': function () {
            Editor.log(LOG, '正在开启中继服务…');
            toolHubControl({ action: 'start' }).then(function (r) {
                if (r.started) {
                    Editor.success(LOG, '中继已开启 → ' + r.url);
                    Editor.log(LOG, '把 mcp.json 的 url 指到 ' + r.url + '，之后用 set_target_project 决定操作哪个项目');
                } else {
                    Editor.error(LOG, '中继启动失败：' + (r.error || '未知原因'));
                }
            }, function (e) {
                Editor.error(LOG, '中继启动失败：' + (e && e.message));
            });
        },

        'hub-stop': function () {
            var r = toolHubControl({ action: 'stop' });
            if (r.stopped) Editor.success(LOG, '中继已停止');
            else Editor.warn(LOG, r.note || '没找到运行中的中继');
        },

        'next-target': function () {
            var all = readRegistryAll();
            var names = Object.keys(all);
            if (!names.length) {
                Editor.warn(LOG, '没有已登记的项目');
                return;
            }
            names.sort(function (a, b) { return all[a].port - all[b].port; });

            // 按项目身份找当前目标，不靠端口 —— 端口会随重启互换
            var cur = resolveTarget();
            var idx = -1;
            for (var i = 0; i < names.length; i++) {
                if (cur && cur.project && all[names[i]].project === cur.project) {
                    idx = names.indexOf(names[i]);
                    break;
                }
            }
            var next = names[(idx + 1) % names.length];

            try {
                toolSetTargetProject({ name: all[next].name });
                Editor.success(LOG, '目标项目已切到：' + all[next].name + '（端口 ' + all[next].port + '）');
                Editor.log(LOG, '之后 AI 的所有调用都会转发到它，客户端连哪个端口都无所谓');
            } catch (e) {
                Editor.error(LOG, '切换目标失败：' + (e && e.message));
            }
        }
    }
};
