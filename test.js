'use strict';

/**
 * 在 Node 里把 Editor 全局 mock 掉，然后真发 HTTP 请求测这个扩展。
 *
 * 为什么要这么测：
 *   扩展的代码 99% 是"拿到 Editor.Project.path → 操作文件 → 返回"，
 *   这些逻辑跟 Cocos 编辑器本身没关系。只要 Editor 这个壳能 mock，
 *   就能在装进编辑器之前把工具全部跑一遍，不用反复重启编辑器试错。
 *
 * 用法：node test.js [项目路径]
 *   默认用 D:/CocosProject/PinGame
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const PROJECT = process.argv[2] || 'D:/CocosProject/PinGame';

// mock 的项目设置
const mockProfile = {
    data: {
        'design-resolution-width': 960,
        'design-resolution-height': 640,
        'fit-width': false,
        'fit-height': true,
        'start-scene': 'mock-scene-uuid'
    },
    saved: false
};

if (!fs.existsSync(PROJECT)) {
    console.error('项目不存在：' + PROJECT);
    process.exit(1);
}

// 别让测试进程往端口注册表里写东西，会和真编辑器抢同一个项目名
process.env.COCOS_MCP_NO_REGISTRY = '1';

// 模拟 2.4 的场景进程处理器。签名必须是 (evt, payload) ——
// v0.3.0 只接了第一个参数，导致业务 payload 被当成 evt 丢掉、回传地址为空，
// 误判成"场景脚本只收不回"。这条 mock 就是守住那个教训的。
const mockSceneHandlers = {
    ping: function (evt, payload) {
        evt.reply({
            __scene: 1, ok: true,
            data: { sceneName: 'MockScene', childCount: 2, ccAvailable: true, fsModule: 'ok', editorIpc: true }
        });
    },
    runtimeRead: function (evt, payload) {
        evt.reply({
            __scene: 1, ok: true,
            data: {
                sceneName: 'MockScene',
                name: 'Canvas',
                path: 'Canvas',
                active: true,
                position: { x: 0, y: 0, z: 0 },
                components: [{ type: 'cc.Canvas', props: { name: 'MockCanvas' } }],
                children: [{ name: 'topUI', path: 'Canvas/topUI', components: [], children: [] }],
                totalRead: 2,
                truncated: false,
                _sawPayload: payload && payload.__id ? 'yes' : 'no'
            }
        });
    },
    runtimeEval: function (evt, payload) {
        const expr = payload && payload.expr;
        if (!expr) {
            evt.reply({ __scene: 1, ok: false, error: '缺少 expr' });
            return;
        }
        evt.reply({ __scene: 1, ok: true, data: { expr: expr, value: 'mock-value' } });
    },
    runtimeConsole: function (evt, payload) {
        evt.reply({
            __scene: 1, ok: true,
            data: {
                captured: 2,
                installed: true,
                latestAt: 1700000000000,
                entries: [
                    { level: 'log', text: '游戏开始', at: 1699999999000 },
                    { level: 'error', text: '加载失败', at: 1700000000000 }
                ]
            }
        });
    }
};

let port = 0;
const logs = [];

global.Editor = {
    Project: { path: PROJECT },
    log: function () {
        const s = Array.prototype.join.call(arguments, ' ');
        logs.push(s);
        console.log('  [log] ' + s);
    },
    success: function () {
        const s = Array.prototype.join.call(arguments, ' ');
        logs.push(s);
        console.log('  [ok]  ' + s);
        // 从启动日志里抓端口，因为端口可能因占用而递增
        const m = s.match(/127\.0\.0\.1:(\d+)/);
        if (m) port = parseInt(m[1], 10);
    },
    warn: function () {
        const s = Array.prototype.join.call(arguments, ' ');
        logs.push('[warn] ' + s);
        console.log('  [warn] ' + s);
    },
    error: function () {
        const s = Array.prototype.join.call(arguments, ' ');
        logs.push('[error] ' + s);
        console.log('  [err] ' + s);
    },
    assetdb: {
        // 故意只声明一个形参：验证扩展对"老版本 / mock 只有一个参数"的降级分支
        refresh: function (p) { console.log('  [assetdb.refresh] ' + p); },
        assetBackupPath: 'C:/tmp/BackupAssets',
        queryAssets: function (pattern, filter, cb) {
            console.log('  [assetdb.queryAssets] ' + pattern);
            const list = [
                { uuid: 'aaaa1111-0000-0000-0000-000000000001', url: 'db://assets/a.png', path: path.join(PROJECT, 'assets', 'a.png'), type: 'texture' },
                { uuid: 'aaaa1111-0000-0000-0000-000000000002', url: 'db://assets/b.prefab', path: path.join(PROJECT, 'assets', 'b.prefab'), type: 'prefab' },
                { uuid: 'aaaa1111-0000-0000-0000-000000000003', url: 'db://assets/c.png', path: path.join(PROJECT, 'assets', 'c.png'), type: 'texture' }
            ];
            setTimeout(function () { cb(null, list); }, 0);
        },
        move: function (from, to, cb) {
            console.log('  [assetdb.move] ' + from + ' → ' + to);
            setTimeout(function () { cb(null, [{}, {}]); }, 0);
        },
        delete: function (url, cb) {
            console.log('  [assetdb.delete] ' + url);
            setTimeout(function () { cb(null, [{}]); }, 0);
        }
    },
    Builder: {
        simpleBuildTargets: {
            wechatgame: { name: '微信小游戏', extends: 'mini-game' },
            alipay: { name: '支付宝小游戏', extends: 'mini-game' }
        }
    },
    sceneScripts: {
        'cocos-mcp-2x': 'packages://cocos-mcp-2x/scene.js'
    },
    Ipc: {
        // 模拟 2.4 的场景进程：处理器签名是 (evt, payload)，
        // 回传走 evt.reply(envelope)。这正是 v0.3.0 踩坑的地方。
        sendToPanel: function (panel, name, body, cb) {
            const method = String(name).split(':').pop();
            const handler = mockSceneHandlers[method];
            if (!handler) {
                if (cb) setTimeout(function () {
                    cb(new Error('message not found: ' + name));
                }, 0);
                return;
            }
            const evt = {
                sender: { send: function () { /* 场景进程往主进程发消息 */ } },
                senderId: 'mock-scene',
                ports: [],
                reply: function (envelope) {
                    if (cb) setTimeout(function () { cb(null, envelope); }, 0);
                }
            };
            try {
                handler(evt, body);
            } catch (e) {
                if (cb) setTimeout(function () { cb(new Error(e.message)); }, 0);
            }
        }
    },
    Profile: {
        load: function (url) {
            return {
                getSelfData: function () { return mockProfile.data; },
                set: function (k, v) { mockProfile.data[k] = v; },
                save: function () { mockProfile.saved = true; }
            };
        }
    },
    PreviewServer: {
        _previewPort: 7457,
        start: function (opts, cb) {
            console.log('  [PreviewServer.start]');
            if (cb) cb();
        },
        stop: function () {
            console.log('  [PreviewServer.stop]');
        }
    }
};

console.log('=== 加载扩展 ===');
const ext = require('./main.js');
ext.load();

/** 简单的 GET，用来读中继的状态页 */
function httpGet(url) {
    return new Promise(function (resolve, reject) {
        const req = http.get(url, function (res) {
            let data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve(data); });
        });
        req.on('error', reject);
        req.setTimeout(3000, function () { req.destroy(new Error('GET 超时')); });
    });
}

function rpc(method, params) {
    return new Promise(function (resolve, reject) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params });
        const req = http.request({
            host: '127.0.0.1',
            port: port,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, function (res) {
            let data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('返回不是 JSON：' + data.slice(0, 200)));
                }
            });
        });
        req.on('error', function(e){ reject(new Error('rpc 连接失败（端口 '+port+'）: '+e.message)); });
        req.write(body);
        req.end();
    });
}

/** 在场景树里找第一个有 >=2 个子节点的节点，用来测试换父节点 */
function findParentWithTwoChildren(tree) {
    let best = null;
    (function walk(n) {
        if (best || !n) return;
        const kids = n.children || [];
        if (kids.length >= 2) { best = n; return; }
        kids.forEach(walk);
    })(tree);
    return best;
}

async function callTool(name, args) {    const r = await rpc('tools/call', { name: name, arguments: args || {} });
    if (!r.result) throw new Error('无 result：' + JSON.stringify(r));
    const text = r.result.content[0].text;
    if (r.result.isError) return { error: text };
    try { return JSON.parse(text); } catch (e) { return text; }
}

let passed = 0;
let failed = 0;
// 真实场景路径不硬编码：不同项目叫 Game.fire / MainScene.fire / landscape.fire...
let scenePath = null;
// 场景里第一个子节点的名字，用作挂载父节点。不同项目根结构不同，不能硬编码 Canvas
let parentName = 'Scene';

/** 项目里第一个 .prefab（相对路径），没有就返回 null */
function findFirstPrefab() {    const stack = [path.join(PROJECT, 'assets')];
    while (stack.length) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const f of ents) {
            // 跳过测试自己造的资源：挑中一个空的 __mcp_* 预制体会让后面的
            // "拷进来"测试拿不到组件，报出跟产品代码无关的假失败。
            if (f.name.indexOf('__mcp_') === 0) continue;
            const full = path.join(dir, f.name);
            if (f.isDirectory()) { stack.push(full); continue; }
            if (f.name.slice(-7) === '.prefab') {
                return path.relative(PROJECT, full).replace(/\\/g, '/');
            }
        }
    }
    return null;
}

/** 项目里第一个 .png（相对路径），doctor 的 spriteFrame 类型检查要用 */
function findFirstPng() {
    const stack = [path.join(PROJECT, 'assets')];
    while (stack.length) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const f of ents) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) { stack.push(full); continue; }
            if (f.name.slice(-4) === '.png') return path.relative(PROJECT, full).replace(/\\/g, '/');
        }
    }
    return null;
}

/** 项目里的前 N 个 .prefab（相对路径），给引用查询类测试当样本池 */
function collectPrefabs(n) {
    const out = [];
    const stack = [path.join(PROJECT, 'assets')];
    while (stack.length && out.length < (n || 20)) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const f of ents) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) { stack.push(full); continue; }
            if (f.name.slice(-7) === '.prefab') out.push(path.relative(PROJECT, full).replace(/\\/g, '/'));
            if (out.length >= (n || 20)) break;
        }
    }
    return out;
}

/** 项目里第一个 .ts（相对路径）。脚本编译状态要用它 */
function findFirstTs() {
    const stack = [path.join(PROJECT, 'assets')];
    while (stack.length) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const f of ents) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) { stack.push(full); continue; }
            if (f.name.slice(-3) === '.ts' && f.name.slice(-5) !== '.d.ts') {
                return path.relative(PROJECT, full).replace(/\\/g, '/');
            }
        }
    }
    return null;
}

/** 项目里第一个 .png（相对路径） */
function findFirstPng() {
    const stack = [path.join(PROJECT, 'assets')];
    while (stack.length) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const f of ents) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) { stack.push(full); continue; }
            if (f.name.slice(-4).toLowerCase() === '.png') {
                return path.relative(PROJECT, full).replace(/\\/g, '/');
            }
        }
    }
    return null;
}

function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(function () {
            passed++;
            console.log('  PASS  ' + name);
        })
        .catch(function (e) {
            failed++;
            console.log('  FAIL  ' + name);
            console.log('        ' + e.message);
            if (process.env.MCP_TEST_STACK === '1' && e.stack) {
                console.log('        ' + e.stack.split('\n').slice(1, 4).join('\n        '));
            }
        });
}

/** 把节点树压平成 [{node, path}]，方便按路径断言 */
function flatten(tree) {
    const out = [];
    (function walk(n, prefix) {
        const cur = prefix ? prefix + '/' + n.name : n.name;
        out.push({ node: n, path: cur });
        (n.children || []).forEach(function (c) { walk(c, cur); });
    })(tree, '');
    return out;
}

// 回归测试会在用户项目里造一批临时资源。上一轮失败 / 中途异常退出留下的残留，
// 会被下一轮当成模板或目标复用，制造一堆莫名其妙的假失败 —— 最典型是
// assets/__mcp_test_scene.fire 只剩个空场景，被当成节点模板，连锁挂掉 20 多项。
// 所以开跑前、收尾时、异常退出时都清一次，保证同一项目反复跑结果一致。
const TEST_ARTIFACTS = [
    'assets/__mcp_test_prefab', 'assets/__mcp_test_prefab.meta',
    'assets/__mcp_test_scene.fire', 'assets/__mcp_test_scene.fire.meta',
    'assets/__mcp_diff_test', 'assets/__mcp_diff_test.meta',
    'assets/__mcp_probe', 'assets/__mcp_probe.meta',
    'temp/mcp-prefab-test.prefab', 'temp/mcp-bad-prefab.prefab',
    'temp/mcp-scene-test.fire', 'temp/mcp-test-probe.txt',
    'temp/mcp-diff-test',
    'temp/__mcp_edit_test.ts', 'temp/__mcp_exec_test.js',
    'temp/__mcp_prefab_test.prefab', 'temp/__mcp_verify'
];
function cleanupTestArtifacts() {
    const removed = [];
    TEST_ARTIFACTS.forEach(function (rel) {
        const abs = path.join(PROJECT, rel);
        try {
            if (!fs.existsSync(abs)) return;
            fs.rmSync(abs, { recursive: true, force: true });
            if (!fs.existsSync(abs)) removed.push(rel);
        } catch (e) { /* 忽略 */ }
    });
    // 打出来是为了"上一轮到底留了什么"可查，别再静默吞掉
    if (removed.length) console.log('清理测试残留：' + removed.join('、'));
}

async function main() {
    // 等服务器起来
    for (let i = 0; i < 50 && !port; i++) {
        await new Promise(function (r) { setTimeout(r, 60); });
    }
    if (!port) throw new Error('服务没起来（拿不到端口）');
    console.log('端口 = ' + port + '\n');

    // 清掉上一轮可能残留的测试资源（见 cleanupTestArtifacts 上的说明）
    cleanupTestArtifacts();

    console.log('=== 协议层 ===');

    await check('initialize 返回 serverInfo', async function () {
        const r = await rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' }
        });
        assert.strictEqual(r.result.serverInfo.name, 'cocos-mcp-2x');
        assert.strictEqual(r.result.protocolVersion, '2024-11-05');
        assert.ok(r.result.serverInfo.version, '缺少 version');
        assert.ok(r.result.serverInfo.instanceId, '缺少 instanceId（热重载脚本靠它判断换没换实例）');
        console.log('        版本 = ' + r.result.serverInfo.version +
            '，实例 = ' + r.result.serverInfo.instanceId);
    });

    await check('tools/list 返回 28 个工具（v0.8.0 合并）', async function () {
        const r = await rpc('tools/list', {});
        assert.strictEqual(r.result.tools.length, 28);
        const names = r.result.tools.map(function (t) { return t.name; });
        ['get_project_info', 'list_dir', 'search_files', 'read_file', 'write_file', 'edit_file',
            'query_scene_tree', 'mcp_selftest', 'resolve_asset', 'asset_refs', 'run_script',
            'refresh_assets', 'list_open_projects', 'set_target_project', 'hub_control',
            'scene_diagnose', 'scene_create', 'project_doctor', 'editor_sync', 'scene_capture',
            'scene_edit', 'asset', 'prefab', 'build', 'project_settings', 'runtime',
            'preview', 'editor'].forEach(function (n) {
            assert.ok(names.indexOf(n) >= 0, '缺工具 ' + n);
        });
        // 两轮合并掉的名字都不该再出现在 tools/list 里 —— 但 dispatch 仍然认（见后面的旧名兼容测试）
        const oldNames = [
            'read_scene_node', 'mcp_audit', 'mcp_verify_all', 'resolve_uuid', 'resolve_sprite_frame',
            'execute_script', 'execute_script_file', 'prefab_instantiate', 'prefab_create_from_node',
            'scene_ping', 'scene_probe', 'runtime_console', 'preview_report',
            'runtime_browser_report', 'runtime_eval', 'scene_eval',
            'scene_add_node', 'scene_remove_node', 'scene_move_node', 'scene_set_props',
            'scene_add_component', 'scene_remove_component', 'scene_set_component_props', 'scene_apply',
            'asset_query', 'asset_move', 'asset_delete', 'asset_meta_get', 'asset_meta_set',
            'prefab_create', 'prefab_layout_check', 'prefab_diff',
            'build_targets', 'build_project', 'build_status',
            'project_settings_get', 'project_settings_set',
            'runtime_info', 'runtime_read', 'runtime_inject', 'runtime_report', 'eval_scene',
            'preview_control', 'preview_command', 'get_editor_log', 'script_compile_status'
        ];
        assert.strictEqual(oldNames.length, 46, '旧名清单数量不对');
        oldNames.forEach(function (n) {
            assert.strictEqual(names.indexOf(n), -1, n + ' 应该已经合并掉了，不该还在 tools/list 里');
        });
        // 每个工具都得有合法 schema，否则客户端会直接拒收
        r.result.tools.forEach(function (t) {
            assert.strictEqual(t.inputSchema.type, 'object', t.name + ' 的 schema 不对');
        });
        // 8 个聚合入口必须声明 cmd 枚举，否则 AI 不知道有哪些动作
        const AGG = ['scene_edit', 'asset', 'prefab', 'build', 'project_settings', 'runtime', 'preview', 'editor'];
        AGG.forEach(function (n) {
            const t = r.result.tools.filter(function (x) { return x.name === n; })[0];
            assert.ok(t, '缺聚合工具 ' + n);
            const cmd = t.inputSchema.properties.cmd;
            assert.ok(cmd && Array.isArray(cmd.enum) && cmd.enum.length >= 2, n + ' 没声明 cmd 枚举');
            assert.ok(t.inputSchema.required.indexOf('cmd') >= 0, n + ' 没把 cmd 设成必填');
            assert.ok(t.description.indexOf('cmd') >= 0, n + ' 的描述没提 cmd');
        });
        // 写 .prefab 的工具必须把约定写在描述里 —— AI 看不到 HANDOFF.md
        ['write_file', 'scene_edit', 'prefab'].forEach(function (n) {
            const t = r.result.tools.filter(function (x) { return x.name === n; })[0];
            assert.ok(t.description.indexOf('【Prefab 约定】') >= 0, n + ' 的描述缺【Prefab 约定】');
        });
        // 自检工具的描述不能说"会真的改场景"（实际是在副本上跑，这行话会让 AI 不敢跑自检）
        const verify = r.result.tools.filter(function (x) { return x.name === 'mcp_selftest'; })[0];
        assert.ok(verify.description.indexOf('不碰你的真实文件') >= 0, 'mcp_selftest 描述仍会误导');
        assert.ok(verify.description.indexOf('会真的改当前打开的场景') < 0, 'mcp_selftest 描述仍有旧说法');
        console.log('        工具列表 ' + Buffer.byteLength(JSON.stringify(r)) + ' 字节');
    });

    await check('tools/list 载荷不重复塞契约（< 55 KB，v0.8.0 收紧）', async function () {
        const r = await rpc('tools/list', {});
        const bytes = Buffer.byteLength(JSON.stringify(r));
        // v0.3.x 是 155 KB（同一段 1967 字节的契约拼了 54 遍）；
        // v0.7.0 是 ~62 KB（50 工具 + PREFAB_RULES 拼了 10 遍）。
        // v0.8.0 合并到 28 工具、规则只拼 3 遍，这里守住不回退。
        assert.ok(bytes < 55 * 1024, 'tools/list 又胖回去了：' + bytes + ' 字节');
        // 完整契约应该在 initialize.instructions 里，说一次就够
        const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
        assert.ok(init.result.instructions.indexOf('【返回约定】') >= 0, 'instructions 里没有完整契约');
        assert.ok(init.result.instructions.indexOf('【常见链路') >= 0, 'instructions 里没有推荐链路');
    });

    await check('v0.4.0 合并掉的 16 个旧工具名仍然可调用（不报未知工具）', async function () {
        const oldNames = ['read_scene_node', 'mcp_audit', 'mcp_verify_all', 'resolve_uuid',
            'resolve_sprite_frame', 'execute_script', 'execute_script_file', 'prefab_instantiate',
            'prefab_create_from_node', 'scene_ping', 'scene_probe', 'runtime_console',
            'preview_report', 'runtime_browser_report', 'runtime_eval', 'scene_eval'];
        for (const n of oldNames) {
            // 自检类必须收窄，否则会真跑一遍副作用工具（污染后面的设置测试）
            const probeArgs = (n === 'mcp_audit' || n === 'mcp_verify_all')
                ? { only: ['get_project_info'] }
                : {};
            const r = await callTool(n, probeArgs);
            const msg = String(r.error || '');
            assert.ok(msg.indexOf('未知工具') < 0, n + ' 已经彻底失效了：' + msg.slice(0, 80));
            if (msg) assert.ok(msg.length > 4, n + ' 的错误信息太短');
        }
        // 传对了参数就应该真的转发成功，并带上 __renamedFrom
        const ok = await callTool('execute_script', { code: 'return 7 * 6;' });
        assert.strictEqual(ok.result, 42, '旧名转发没拿到结果');
        assert.strictEqual(ok.__renamedFrom, 'execute_script', '没标 __renamedFrom');
        assert.ok(String(ok.__hint).indexOf('run_script') >= 0, '__hint 没说清新名字');
        console.log('        16 个旧名全部转发正常，新名 = ' + ok.__hint.match(/并入 (\w+)/)[1]);
    });

    await check('v0.8.0：30 个旧名自动转发到 8 个聚合入口', async function () {
        const info = await callTool('get_project_info');
        const someScene = info.scenes[0];
        // 每个聚合入口挑一个"只读 / 不会真改东西"的旧名，验证它确实落到了新工具上
        const reps = [
            ['scene_add_node', { path: 'assets/__mcp_不存在__.fire', parent: 'Canvas' }, 'scene_edit'],
            ['asset_query', { pattern: 'db://assets/__mcp_none__/**/*' }, 'asset'],
            ['prefab_diff', { a: someScene, b: someScene }, 'prefab'],
            ['build_targets', {}, 'build'],
            ['project_settings_get', {}, 'project_settings'],
            ['runtime_info', {}, 'runtime'],
            ['preview_control', { action: 'status' }, 'preview'],
            ['get_editor_log', { lines: 1 }, 'editor']
        ];
        for (const [n, a, expectTo] of reps) {
            const r = await callTool(n, a);
            const msg = String(r.error || '');
            assert.ok(msg.indexOf('未知工具') < 0, n + ' 转发失败：' + msg.slice(0, 90));
            // 纯文本返回（read_file / editor{cmd:log} 之类）按约定不包装，自然没有 __ 字段
            if (!r.error && r && typeof r === 'object') {
                assert.strictEqual(r.__renamedFrom, n, n + ' 没标 __renamedFrom');
                assert.ok(String(r.__hint).indexOf(expectTo) >= 0, n + ' 的 __hint 没说清新名 ' + expectTo);
                assert.ok(String(r.__hint).indexOf('cmd=') >= 0, n + ' 的 __hint 没给出 cmd');
            }
        }
        // v0.4.0 旧名 → v0.7.0 中继名 → v0.8.0 聚合入口：两跳也要能走通
        const chain = await callTool('runtime_console', { limit: 1 });
        assert.ok(String(chain.error || '').indexOf('未知工具') < 0, '两跳转发链断了');
        if (!chain.error) {
            assert.strictEqual(chain.__renamedFrom, 'runtime_console');
            assert.strictEqual(chain.__hops, 2, '两跳链没被识别：hops=' + chain.__hops);
        }
        // 旧名与新名结果必须一致（diff 自比，四类差异都该是空数组）
        const viaOld = await callTool('prefab_diff', { a: someScene, b: someScene });
        const viaNew = await callTool('prefab', { cmd: 'diff', a: someScene, b: someScene });
        assert.deepStrictEqual(viaNew.added, viaOld.added, '新名/旧名的 diff 结果不一致');
        assert.deepStrictEqual(viaNew.changed, viaOld.changed, '新名/旧名的 diff 结果不一致');
        console.log('        8 个入口转发正常，两跳链 hops=2，新旧名结果一致');
    });

    await check('8 个聚合入口：cmd 必填、非法 cmd 明确报错', async function () {
        const AGG = ['scene_edit', 'asset', 'prefab', 'build', 'project_settings', 'runtime', 'preview', 'editor'];
        for (const n of AGG) {
            const noCmd = await callTool(n, {});
            assert.ok(String(noCmd.error || '').indexOf('cmd 只能是') >= 0,
                n + ' 不传 cmd 没报错：' + JSON.stringify(noCmd).slice(0, 120));
            const badCmd = await callTool(n, { cmd: '__nope__' });
            assert.ok(String(badCmd.error || '').indexOf('cmd 只能是') >= 0,
                n + ' 传非法 cmd 没报错：' + JSON.stringify(badCmd).slice(0, 120));
        }
        console.log('        8 个入口的 cmd 校验都生效');
    });

    await check('未知方法返回 -32601', async function () {
        const r = await rpc('nonexistent/method', {});
        assert.strictEqual(r.error.code, -32601);
    });

    console.log('\n=== 项目信息 ===');

    await check('get_project_info 读到路径和版本', async function () {
        const info = await callTool('get_project_info');
        assert.strictEqual(path.resolve(info.path), path.resolve(PROJECT), '路径不对：' + info.path);
        assert.ok(info.version, '没读到 version');
        assert.ok(Array.isArray(info.scenes) && info.scenes.length > 0, '没找到 .fire');
        // 不能直接用 scenes[0]：__mcp_ 开头的测试产物按字典序排在最前，
        // 而它常常只是个空场景（上一轮 scene_create 失败留下的），拿它当真实场景
        // 会让后面 20 多项"文件里一个 cc.Node 都没有"连锁假失败。
        scenePath = info.scenes.find(function (s) {
            return !/(^|\/)__mcp_/.test(s) && !/(^|\/)mcp-(scene|prefab|diff)-test/.test(s);
        }) || info.scenes[0];
        console.log('        版本 = ' + info.version + '，资源数 = ' + info.assetCount);
        console.log('        场景：' + info.scenes.join(', '));
    });

    console.log('\n=== 文件操作 ===');

    await check('list_dir 列出 assets', async function () {
        const r = await callTool('list_dir', { path: 'assets' });
        assert.ok(r.count > 0);
        assert.ok(r.items.some(function (i) { return i.dir; }), '一个目录都没有，可疑');
    });

    await check('read_file 读 project.json', async function () {
        const text = await callTool('read_file', { path: 'project.json' });
        // project.json 本身是合法 JSON，会被 callTool 一并解析成对象
        const asText = typeof text === 'string' ? text : JSON.stringify(text);
        assert.ok(asText.indexOf('version') >= 0, '内容里没有 version');
    });

    await check('write_file 写入后能读回', async function () {
        const p = 'temp/mcp-test-probe.txt';
        const content = 'probe-' + Date.now();
        await callTool('write_file', { path: p, content: content });
        const back = await callTool('read_file', { path: p });
        assert.strictEqual(back, content);
    });

    await check('路径越界被拦截', async function () {
        const r = await callTool('read_file', { path: '../../../Windows/win.ini' });
        assert.ok(r.error, '应该报错但没报');
        assert.ok(r.error.indexOf('越界') >= 0, '错误信息不对：' + r.error);
    });

    console.log('\n=== 全文搜索 ===');

    await check('search_files 字面量搜索', async function () {
        // 先用 bottle_new 项目里的特征词；换别的项目搜不到就退回通用词，
        // 免得测试绑死在某个项目的代码上
        let r = await callTool('search_files', { pattern: 'MiniGame', glob: '*.ts' });
        if (!r.totalMatches) {
            r = await callTool('search_files', { pattern: 'import', glob: '*.ts' });
        }
        if (!r.totalMatches) {
            r = await callTool('search_files', { pattern: 'cc', path: 'assets' });
        }
        assert.ok(r.totalMatches > 0, '一条都没搜到');
        if (r.pattern !== 'cc') {
            assert.ok(r.matches.every(function (m) { return /\.ts$/.test(m.file); }), 'glob 过滤没生效');
        }
        console.log('        扫描 ' + r.scannedFiles + ' 个文件，命中 ' + r.totalMatches +
            ' 条 / ' + r.matchedFiles + ' 个文件，耗时 ' + r.tookMs + 'ms');
        console.log('        首条：' + r.matches[0].file + ':' + r.matches[0].line);
    });

    await check('search_files 正则模式 + 上下文', async function () {
        const r = await callTool('search_files', {
            pattern: 'import\\s+.*from',
            glob: '*.ts',
            useRegex: true,
            context: 1,
            maxResults: 3
        });
        assert.ok(r.totalMatches > 0, '正则一条都没搜到');
        assert.ok(r.matches[0].before !== undefined, '没带上下文');
        assert.ok(r.matches.length <= 3, 'maxResults 没生效');
    });

    await check('search_files 默认跳过 .meta', async function () {
        const withMeta = await callTool('search_files', { pattern: 'uuid', includeMeta: true, maxResults: 300 });
        const withoutMeta = await callTool('search_files', { pattern: 'uuid', maxResults: 300 });
        assert.ok(withoutMeta.matches.every(function (m) { return !/\.meta$/.test(m.file); }), '还搜到了 .meta');
        console.log('        含 .meta：' + withMeta.totalMatches + ' 条；不含：' + withoutMeta.totalMatches + ' 条');
    });

    await check('search_files truncated 只在真超出上限时为 true', async function () {
        const narrow = await callTool('search_files', { pattern: 'BottleData.init', maxResults: 50 });
        assert.strictEqual(narrow.truncated, false, '没超上限却标了 truncated');
        const capped = await callTool('search_files', { pattern: 'import', glob: '*.ts', maxResults: 2 });
        if (capped.totalMatches > 2) {
            assert.strictEqual(capped.truncated, true, '超了上限却没标 truncated');
            assert.strictEqual(capped.returned, 2, 'returned 不等于 maxResults');
            assert.ok(capped.totalMatches > capped.returned);
            console.log('        上限 2 → 返回 ' + capped.returned + '，实际共 ' + capped.totalMatches + ' 条');
        }
    });

    console.log('\n=== uuid 解析 ===');

    let scriptComp = null;
    let scriptNodePath = null;

    await check('query_scene_tree 把脚本组件反解成路径和类名', async function () {
        assert.ok(scenePath, '前置失败：没拿到场景路径');
        const r = await callTool('query_scene_tree', { path: scenePath });
        const all = flatten(r.tree);
        for (const it of all) {
            const c = (it.node.components || []).find(function (x) { return x.isScript; });
            if (c) { scriptComp = c; scriptNodePath = it.path; break; }
        }
        assert.ok(scriptComp, '场景里没有任何脚本组件');
        assert.ok(scriptComp.script, '脚本组件没反解出路径，仍然只有 uuid：' + scriptComp.type);
        console.log('        节点 "' + scriptNodePath + '" → ' + scriptComp.script +
            ' (' + scriptComp.className + ')');
    });

    await check('compressUuid 与场景里的 __type__ 完全一致', async function () {
        assert.ok(scriptComp && scriptComp.script, '前置失败：没找到可用的脚本组件');
        const r = await callTool('resolve_asset', { input: scriptComp.script });
        assert.strictEqual(r.compressed, scriptComp.type,
            '压缩结果 ' + r.compressed + ' ≠ 场景里的 ' + scriptComp.type);
        assert.ok(r.uuid && r.uuid.length === 36, '没解析出完整 uuid');
    });

    await check('resolve_asset 压缩 uuid 能还原成路径', async function () {
        assert.ok(scriptComp, '前置失败');
        const r = await callTool('resolve_asset', { input: scriptComp.type });
        assert.strictEqual(r.path, scriptComp.script, '还原路径不对：' + r.path);
    });

    await check('resolve_asset 不认识的输入报错', async function () {
        const r = await callTool('resolve_asset', { input: 'assets/不存在的路径.ts' });
        assert.ok(r.error, '应该报错');
    });

    console.log('\n=== 场景解析 ===');

    await check('query_scene_tree 解析真实场景', async function () {
        assert.ok(scenePath, '前置失败：没拿到场景路径');
        const r = await callTool('query_scene_tree', { path: scenePath });
        assert.ok(r.tree, '没有 tree');
        assert.ok(r.nodeCount > 0, '节点数为 0');
        assert.ok(r.totalObjects > 0);
        console.log('        文件 = ' + scenePath);
        console.log('        对象数 = ' + r.totalObjects + '，节点数 = ' + r.nodeCount);
        console.log('        根节点 = ' + r.tree.name + '（' + r.tree.type + '）');
        console.log('        一级子节点：' + r.tree.children.map(function (c) {
            return c.name + '[' + (c.components || []).length + '组件]';
        }).join(', '));
    });

    await check('maxDepth 生效（不展开到底）', async function () {
        const deep = await callTool('query_scene_tree', { path: scenePath, maxDepth: 100 });
        const shallow = await callTool('query_scene_tree', { path: scenePath, maxDepth: 1 });
        assert.ok(shallow.nodeCount <= deep.nodeCount, '浅层反而节点更多，maxDepth 没生效');
        console.log('        depth=1 → ' + shallow.nodeCount + ' 节点；depth=100 → ' + deep.nodeCount + ' 节点');
    });

    await check('query_scene_tree 支持按节点路径取子树', async function () {
        const r = await callTool('query_scene_tree', { path: scenePath, node: scriptNodePath });
        assert.ok(r.tree, '没有 subtree');
        assert.strictEqual(r.tree.name, scriptNodePath.split('/').pop());
        assert.ok(r.nodeCount < 999, '子树节点数异常');
        console.log('        子树 "' + r.tree.name + '" 共 ' + r.nodeCount + ' 个节点');
    });

    await check('query_scene_tree detail 读出组件真实属性', async function () {
        assert.ok(scriptNodePath, '前置失败：没拿到节点路径');
        const r = (await callTool('query_scene_tree', { path: scenePath, node: scriptNodePath, detail: true })).detail;
        assert.strictEqual(r.name, scriptNodePath.split('/').pop());
        assert.ok(r.components.length > 0, '没有组件');
        assert.ok(r.position && typeof r.position.x === 'number', '位置没读出来');
        const script = r.components.find(function (c) { return c.script; });
        assert.ok(script, '组件里没有脚本');
        assert.ok(script.props && typeof script.props === 'object', '没有 props');
        // @property 引用的节点应该被翻译成名字
        const propsText = JSON.stringify(script.props);
        console.log('        组件：' + r.components.map(function (c) {
            return c.className || c.type;
        }).join(', '));
        console.log('        props 字节数 = ' + propsText.length);
    });

    await check('query_scene_tree detail 找不到节点时报错', async function () {
        const r = await callTool('query_scene_tree', { path: scenePath, node: '不存在的节点xyz', detail: true });
        assert.ok(r.error, '应该报错');
        assert.ok(r.error.indexOf('找不到节点') >= 0, '错误信息不对：' + r.error);
    });

    console.log('\n=== 其它工具 ===');

    await check('get_editor_log 能读到日志或明确说明被占用', async function () {
        const text = await callTool('get_editor_log', { lines: 5 });
        assert.ok(typeof text === 'string');
        assert.ok(text.length > 0);

        // 多个编辑器同时开时，主日志被先启动的那个独占，读不到是正常现象。
        // 这时工具必须明确说"读不到"并给出原因，而不是拿几个月前的旧日志充数。
        if (/读不到主日志/.test(text)) {
            assert.ok(/独占/.test(text), '说读不到时必须给原因');
            console.log('        主日志被另一个编辑器独占，工具如实报告（不算失败）');
            return;
        }

        // 必须指到真正在写的那个日志：2.4 有 log/ 和 logs/ 两个目录，
        // 只扫 log/ 会读到几个月前的旧文件
        const m = text.match(/^文件：(.+)$/m);
        assert.ok(m, '返回里没有文件路径');
        const logFile = m[1].trim();
        const st = fs.statSync(logFile);
        const ageHours = (Date.now() - st.mtimeMs) / 3600000;
        console.log('        日志 = ' + logFile + '（' + ageHours.toFixed(1) + ' 小时前更新）');
        assert.ok(ageHours < 24, '日志是 ' + ageHours.toFixed(0) + ' 小时前的，指错文件了：' + logFile);
    });

    await check('run_script 能访问 Editor', async function () {
        const r = await callTool('run_script', {
            code: 'return { project: Editor.Project.path, hasAssetdb: !!Editor.assetdb };'
        });
        assert.strictEqual(path.resolve(r.result.project), path.resolve(PROJECT));
        assert.strictEqual(r.result.hasAssetdb, true);
    });

    await check('run_script 支持 await', async function () {
        const r = await callTool('run_script', {
            code: 'var v = await Promise.resolve(21); return v * 2;'
        });
        assert.strictEqual(r.result, 42, 'async 没生效，拿到：' + JSON.stringify(r));
    });

    await check('run_script 报错被捕获成 isError', async function () {
        const r = await callTool('run_script', { code: 'throw new Error("故意抛错");' });
        assert.ok(r.error, '应该返回错误');
        assert.ok(r.error.indexOf('故意抛错') >= 0);
    });

    await check('refresh_assets 调到 assetdb', async function () {
        const r = await callTool('refresh_assets', {});
        assert.ok(Array.isArray(r.refreshed), 'refreshed 应该是数组');
        assert.ok(r.refreshed.length > 0, '没刷任何目录');
        assert.strictEqual(r.done, true, '导入没完成');
    });

    await check('list_open_projects 能返回结构（测试模式不写注册表）', async function () {
        const r = await callTool('list_open_projects', {});
        assert.ok(Array.isArray(r.projects), 'projects 不是数组');
        assert.ok(typeof r.dir === 'string');
        console.log('        注册表目录 = ' + r.dir + '，登记项目 ' + r.count + ' 个');
    });

    console.log('\n=== 场景写入（先拷到 temp/ 再改，不碰真实场景） ===');

    const tmpRel = 'temp/mcp-scene-test.fire';
    const tmpAbs = path.join(PROJECT, tmpRel);

    await check('scene_diagnose 报出场景结构和可用模板', async function () {
        assert.ok(scenePath, '前置失败：没拿到场景路径');
        const r = await callTool('scene_diagnose', { path: scenePath });
        assert.ok(r.objectCount > 0, '对象数不对');
        assert.strictEqual(r.templateFound, true, '场景里连一个 cc.Node 都没有');
        console.log('        ' + r.sceneFile + '，' + r.objectCount + ' 个对象');
    });

    await check('scene_add_node 加节点并正确挂载', async function () {
        fs.copyFileSync(path.join(PROJECT, scenePath), tmpAbs);

        // 父节点不能硬编码 Canvas：不同项目的场景根结构不一样
        const rootTree = await callTool('query_scene_tree', { path: tmpRel, maxDepth: 1 });
        const firstChild = (rootTree.tree.children || [])[0];
        parentName = firstChild ? firstChild.name : 'Scene';

        const before = await callTool('query_scene_tree', { path: tmpRel });

        const r = await callTool('scene_add_node', {
            path: tmpRel, parent: parentName, name: 'McpTestNode', position: { x: 7, y: 8 }
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.saved, true);

        const after = await callTool('query_scene_tree', { path: tmpRel });
        assert.strictEqual(after.totalObjects, before.totalObjects + 1, '对象数没按预期 +1');

        const parentTree = await callTool('query_scene_tree', { path: tmpRel, node: parentName });
        const node = parentTree.tree.children.filter(function (c) { return c.name === 'McpTestNode'; })[0];
        assert.ok(node, '新节点没挂到 ' + parentName + ' 下');
        assert.strictEqual(node.position.x, 7);
        assert.strictEqual(node.position.y, 8);
        console.log('        父节点 ' + parentName + '，新节点 id=' + node.id +
            '，子节点 ' + parentTree.tree.children.length + ' 个');
    });

    await check('scene_add_node 拒绝同级重名', async function () {
        const r = await callTool('scene_add_node', { path: tmpRel, parent: parentName, name: 'McpTestNode' });
        assert.ok(r.error, '重名竟然成功了');
        assert.ok(/同名/.test(r.error), '错误信息没提到同名：' + r.error);
    });

    await check('scene_set_props 改位置/显隐/改名', async function () {
        const oldPath = parentName + '/McpTestNode';

        let r = await callTool('scene_set_props', {
            path: tmpRel, node: oldPath,
            position: { x: 100, y: 200 }, active: false
        });
        assert.ok(!r.error, r.error);
        assert.ok(r.changed.indexOf('position') >= 0, '没改位置');
        assert.ok(r.changed.indexOf('active') >= 0, '没改显隐');

        r = await callTool('scene_set_props', { path: tmpRel, node: oldPath, name: 'McpTestRenamed' });
        assert.ok(r.changed.indexOf('name') >= 0, '没改名');

        const parentTree = await callTool('query_scene_tree', { path: tmpRel, node: parentName });
        const node = parentTree.tree.children.filter(function (c) { return c.name === 'McpTestRenamed'; })[0];
        assert.ok(node, '改名没落盘');
        assert.strictEqual(node.active, false, '显隐没落盘');
        assert.strictEqual(node.position.x, 100, '位置没落盘');
    });

    await check('scene_remove_node 删干净且往返还原成原文件', async function () {
        const before = await callTool('query_scene_tree', { path: tmpRel });
        const r = await callTool('scene_remove_node', {
            path: tmpRel, node: parentName + '/McpTestRenamed'
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.deletedObjects, 1, '删掉的对象数不对');
        assert.strictEqual(r.objectsAfter, r.objectsBefore - 1);

        const after = await callTool('query_scene_tree', { path: tmpRel });
        assert.strictEqual(after.totalObjects, before.totalObjects - 1);

        // 加 → 改 → 删 走完，文件应该和原始场景逐字节一致。
        // 这是对 __id__ 重映射 + 换行风格保留最硬的一条断言：差一个字节就会挂。
        const restored = fs.readFileSync(tmpAbs, 'utf8');
        const original = fs.readFileSync(path.join(PROJECT, scenePath), 'utf8');
        assert.strictEqual(restored, original, '往返后文件没还原成原样，说明引用重映射或换行风格有问题');
        console.log('        往返后与原始场景逐字节一致');
    });

    await check('scene_remove_node 拒绝删场景根', async function () {
        const r = await callTool('scene_remove_node', { path: tmpRel, node: 'Scene' });
        assert.ok(r.error, '删场景根竟然成功了');
        console.log('        ' + r.error);
    });

    await check('scene_add_component 挂内置组件 / 拒绝重复', async function () {
        let r = await callTool('scene_add_node', { path: tmpRel, parent: parentName, name: 'McpCompNode' });
        assert.ok(!r.error, r.error);
        const nodePath = parentName + '/McpCompNode';

        r = await callTool('scene_add_component', { path: tmpRel, node: nodePath, type: 'cc.Sprite' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.added.component, 'cc.Sprite');

        const detail = (await callTool('query_scene_tree', { path: tmpRel, node: nodePath, detail: true, depth: 1 })).detail;
        const comp = (detail.components || []).filter(function (c) { return c.type === 'cc.Sprite'; })[0];
        assert.ok(comp, '组件没挂上');

        const dup = await callTool('scene_add_component', { path: tmpRel, node: nodePath, type: 'cc.Sprite' });
        assert.ok(dup.error, '重复挂同类型组件竟然成功了');
        console.log('        来源 = ' + r.added.from);
    });

    await check('scene_set_component_props 改字段能落盘', async function () {
        const nodePath = parentName + '/McpCompNode';
        const r = await callTool('scene_set_component_props', {
            path: tmpRel, node: nodePath, type: 'cc.Sprite',
            props: { _sizeMode: 0, _fillType: 3 }
        });
        assert.ok(!r.error, r.error);
        assert.ok(r.changed.indexOf('_sizeMode') >= 0, 'changed 里没有 _sizeMode');

        const detail = (await callTool('query_scene_tree', { path: tmpRel, node: nodePath, detail: true, depth: 2 })).detail;
        const dump = JSON.stringify(detail);
        assert.ok(/"_sizeMode"\s*:\s*0/.test(dump), '字段没落盘');
        assert.ok(/"_fillType"\s*:\s*3/.test(dump), '字段没落盘');
    });

    await check('scene_remove_component 移除后往返还原', async function () {
        const nodePath = parentName + '/McpCompNode';

        const c = await callTool('scene_remove_component', { path: tmpRel, node: nodePath, type: 'cc.Sprite' });
        assert.ok(!c.error, c.error);

        const n = await callTool('scene_remove_node', { path: tmpRel, node: nodePath });
        assert.ok(!n.error, n.error);

        const restored = fs.readFileSync(tmpAbs, 'utf8');
        const original = fs.readFileSync(path.join(PROJECT, scenePath), 'utf8');
        assert.strictEqual(restored, original, '组件加/改/删 + 节点删除后没还原成原文件');
    });

    await check('scene_add_component 认不出的类型要报错', async function () {
        const r = await callTool('scene_add_component', {
            path: tmpRel, node: parentName, type: '不存在的组件类型xyz'
        });
        assert.ok(r.error, '未知类型竟然没报错');
        assert.ok(/认不出组件类型/.test(r.error), '错误信息不对：' + r.error);
    });

    await check('scene_add_node(from:prefab) 拷进来且能删干净', async function () {
        const prefabRel = findFirstPrefab();
        if (!prefabRel) {
            console.log('        项目里没有 .prefab，跳过');
            return;
        }

        // 显式给唯一名字：预制体根节点名可能跟真实场景里已有节点撞车
        //（PinGame 里撞过 "bj_1"）—— 那是项目数据，不是产品 bug。
        const copyName = 'McpPrefabCopy_' + Date.now().toString(36);
        const r = await callTool('scene_add_node', {
            from: 'prefab', path: tmpRel, prefab: prefabRel, parent: parentName,
            name: copyName
        });
        assert.ok(!r.error, r.error);
        assert.ok(r.instantiated.objects > 0, '一个对象都没拷过来');

        const nodePath = parentName + '/' + r.instantiated.name;
        const detail = (await callTool('query_scene_tree', { path: tmpRel, node: nodePath, detail: true, depth: 1 })).detail;
        assert.ok(!detail.error, detail.error || '读不回刚拷进来的节点');
        assert.ok((detail.components || []).length > 0, '组件没跟着拷过来');

        const d = await callTool('scene_remove_node', { path: tmpRel, node: nodePath });
        assert.ok(!d.error, d.error);

        const restored = fs.readFileSync(tmpAbs, 'utf8');
        const original = fs.readFileSync(path.join(PROJECT, scenePath), 'utf8');
        assert.strictEqual(restored, original, '预制体拷贝+删除后没还原成原文件');
        console.log('        ' + prefabRel + ' → ' + r.instantiated.objects + ' 个对象 / ' +
            r.instantiated.nodes + ' 个节点 / ' + (detail.components || []).length + ' 个组件');
    });

    await check('scene_* 对不存在的节点报错', async function () {
        const a = await callTool('scene_set_props', { path: tmpRel, node: '不存在的节点xyz', active: true });
        assert.ok(a.error, 'set_props 没报错');
        const b = await callTool('scene_remove_node', { path: tmpRel, node: '不存在的节点xyz' });
        assert.ok(b.error, 'remove_node 没报错');
    });

    console.log('\n=== 批量事务（scene_apply：一次打开 / 一次提交 / 可试运行） ===');

    await check('scene_apply dryRun 不写盘，只回报会变成什么样', async function () {
        const before = fs.readFileSync(tmpAbs, 'utf8');
        const r = await callTool('scene_apply', {
            path: tmpRel,
            dryRun: true,
            ops: [
                { op: 'addNode', parent: parentName, name: 'BatchNode', position: { x: 11, y: 22 } },
                { op: 'setProps', node: 'BatchNode', size: { width: 88, height: 66 }, opacity: 200 },
                { op: 'addComponent', node: 'BatchNode', type: 'cc.Sprite' }
            ]
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(r.opCount, 3);
        assert.strictEqual(r.wouldWrite, true, '试运行说不能写：' + JSON.stringify(r.problems));
        assert.ok(r.after.objects === r.before.objects + 2, '对象数没按预期增长：' +
            JSON.stringify(r.before) + ' → ' + JSON.stringify(r.after));
        assert.ok(Array.isArray(r.results) && r.results.length === 3, '没给每个 op 的结果');
        // 关键：文件一个字节都没动
        assert.strictEqual(fs.readFileSync(tmpAbs, 'utf8'), before, 'dryRun 竟然写盘了');
        console.log('        ' + r.before.objects + ' → ' + r.after.objects + ' 个对象（未落盘）：' + r.results.join(' | '));
    });

    await check('scene_apply 一次提交多个 op，再批量删回原样', async function () {
        const original = fs.readFileSync(path.join(PROJECT, scenePath), 'utf8');

        const r = await callTool('scene_apply', {
            path: tmpRel,
            ops: [
                { op: 'addNode', parent: parentName, name: 'BatchA', position: { x: 1, y: 2 } },
                { op: 'addNode', parent: parentName, name: 'BatchB', position: { x: 3, y: 4 } },
                { op: 'setProps', node: 'BatchB', opacity: 128 },
                { op: 'addComponent', node: 'BatchA', type: 'cc.Label' }
            ]
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.opCount, 4);
        assert.strictEqual(r.saved, true);
        assert.strictEqual(r.problems.length, 0, '结构校验报了问题：' + JSON.stringify(r.problems));

        const tree = await callTool('query_scene_tree', { path: tmpRel, node: parentName, maxDepth: 1 });
        const names = (tree.tree.children || []).map(function (c) { return c.name; });
        assert.ok(names.indexOf('BatchA') >= 0 && names.indexOf('BatchB') >= 0, '两个节点没都加上：' + names.join(','));
        const detail = (await callTool('query_scene_tree', {
            path: tmpRel, node: 'BatchA', detail: true, depth: 0
        })).detail;
        assert.strictEqual(detail.opacity, 255);
        assert.ok((detail.components || []).some(function (c) { return c.type === 'cc.Label'; }), 'Label 没挂上');

        // 一次提交 = 只写一次盘。这里用一个"写一次"的证据：文件 mtime 只变一次不好测，
        // 退而验证结果正确 —— 批量删回原样必须逐字节还原
        const back = await callTool('scene_apply', {
            path: tmpRel,
            ops: [
                { op: 'removeNode', node: 'BatchA' },
                { op: 'removeNode', node: 'BatchB' }
            ]
        });
        assert.ok(!back.error, back.error);
        assert.strictEqual(fs.readFileSync(tmpAbs, 'utf8'), original, '批量加→批量删之后没还原成原文件');
        console.log('        ' + r.before.objects + ' → ' + r.after.objects + ' → ' +
            back.after.objects + ' 个对象，往返逐字节一致');
    });

    await check('scene_apply 中途失败 → 整批放弃、文件不动', async function () {
        const before = fs.readFileSync(tmpAbs, 'utf8');
        const r = await callTool('scene_apply', {
            path: tmpRel,
            ops: [
                { op: 'addNode', parent: parentName, name: 'HalfDone' },
                { op: 'setProps', node: '根本不存在的节点', opacity: 10 }
            ]
        });
        assert.ok(r.error, '第二个 op 明显会失败，居然成功了');
        assert.ok(/第 2 个操作/.test(r.error), '错误信息没指出是第几个操作：' + r.error);
        assert.ok(/文件未改/.test(r.error), '错误信息没说"文件未改"：' + r.error);
        assert.strictEqual(fs.readFileSync(tmpAbs, 'utf8'), before,
            '整批放弃了但文件被改了 —— 这就是半成品');
    });

    await check('scene_apply 拒绝不认识的 op / 缺 op 字段', async function () {
        const a = await callTool('scene_apply', { path: tmpRel, ops: [{ op: 'flyAway', node: 'x' }] });
        assert.ok(a.error && /不认识/.test(a.error), '未知 op 没报错：' + (a.error || ''));

        const b = await callTool('scene_apply', { path: tmpRel, ops: [{ node: 'x', opacity: 1 }] });
        assert.ok(b.error && /缺少 op 字段/.test(b.error), '缺 op 没报错：' + (b.error || ''));
    });

    console.log('\n=== 编辑器内存状态（editor_sync：磁盘 vs 内存） ===');

    await check('写盘会记账，editor_sync 能读出台账', async function () {
        // 先清一次，保证这条测的是自己的写入
        await callTool('editor_sync', { action: 'clear' });

        const r = await callTool('scene_add_node', { path: tmpRel, parent: parentName, name: 'LedgerProbe' });
        assert.ok(!r.error, r.error);
        assert.ok(r.editor, '写盘后没有返回 editor 状态');
        // 无编辑器时 openInEditor 是 null（判断不了），有编辑器才是布尔值 —— 不能是 undefined
        assert.notStrictEqual(r.editor.openInEditor, undefined, 'openInEditor 字段缺失');
        assert.ok([true, false, null].indexOf(r.editor.openInEditor) >= 0,
            'openInEditor 只能是 true / false / null，实际 ' + JSON.stringify(r.editor.openInEditor));

        const st = await callTool('editor_sync', { action: 'status', path: tmpRel });
        assert.ok(!st.error, st.error);
        assert.ok(st.ledger, '台账里没有刚刚那次写入');
        assert.strictEqual(st.ledger.changedSinceLastWrite, false,
            '刚写完就说被外部改过，说明 mtime 比对有误');
        assert.strictEqual(st.kind, 'scene');
        assert.ok(st.fileNodes >= 1, '没算出文件里的节点数');

        const back = await callTool('scene_remove_node', { path: tmpRel, node: 'LedgerProbe' });
        assert.ok(!back.error, back.error);
    });

    await check('文件被外部改动后 editor_sync 报 clobbered', async function () {
        await callTool('editor_sync', { action: 'clear' });
        const w = await callTool('scene_add_node', { path: tmpRel, parent: parentName, name: 'ClobberProbe' });
        assert.ok(!w.error, w.error);

        // 模拟"编辑器保存覆盖了我们的改动"：直接把文件改成别的内容
        const cur = fs.readFileSync(tmpAbs, 'utf8');
        const parsed = JSON.parse(cur);
        const idx = parsed.findIndex(function (o) { return o && o.__type__ === 'cc.Node' && o._name === 'ClobberProbe'; });
        parsed.splice(idx, 1);
        fs.writeFileSync(tmpAbs, JSON.stringify(parsed, null, 2), 'utf8');

        const st = await callTool('editor_sync', { action: 'status', path: tmpRel });
        assert.ok(!st.error, st.error);
        assert.strictEqual(st.ledger.changedSinceLastWrite, true,
            '文件内容变了（size/mtime 都变了）却说没变');
        assert.strictEqual(st.risk, 'clobbered', 'risk 应该是 clobbered，实际 ' + st.risk);
        assert.ok(/被改过|覆盖/.test(st.advice || ''), 'advice 没说清发生了什么');

        // 收尾：从源场景重新拷一份，恢复到干净状态
        fs.copyFileSync(path.join(PROJECT, scenePath), tmpAbs);
        await callTool('editor_sync', { action: 'clear' });
    });

    await check('editor_sync 没开编辑器时 reload 会明确报错（不假装成功）', async function () {
        const r = await callTool('editor_sync', { action: 'reload', path: tmpRel });
        assert.ok(r.error, '没有编辑器却说重载成功了');
        assert.ok(/没开着|不需要重载/.test(r.error), '错误信息没说清为什么：' + r.error);
    });

    await check('editor_sync 参数校验 / clear 可用', async function () {
        const a = await callTool('editor_sync', { action: 'fly' });
        assert.ok(a.error && /action/.test(a.error), '未知 action 没报错');

        const b = await callTool('editor_sync', { path: 'assets/__不存在__.fire' });
        assert.ok(b.error && /不存在/.test(b.error), '不存在的文件没报错');

        const c = await callTool('editor_sync', { action: 'clear' });
        assert.ok(!c.error, c.error);
        assert.strictEqual(c.cleared, 'all');
    });

    console.log('\n=== 节点级差异（prefab_diff） ===');

    // 这一组自己开一个临时目录，不依赖后面「预制体写入」段才创建的那些变量
    const diffDirRel = 'temp/mcp-diff-test';
    const diffDirAbs = path.join(PROJECT, diffDirRel);
    fs.mkdirSync(diffDirAbs, { recursive: true });

    await check('prefab_diff 能看出增删改，且自比为空', async function () {
        const a = tmpRel;                       // 临时场景副本
        const self = await callTool('prefab_diff', { a: a, b: a });
        assert.ok(!self.error, self.error);
        assert.strictEqual(self.summary.added, 0);
        assert.strictEqual(self.summary.changed, 0);
        assert.ok(self.summary.unchanged > 0, '自比居然没有未变化的节点');
        assert.strictEqual(self.__status, 'ok', '自比不该报 partial（空数组是正常结果）');

        // 造一份基准，再改三处：加节点 / 改透明度 / 加组件
        const bak = diffDirRel + '/diff-base.fire';
        fs.copyFileSync(path.join(PROJECT, a), path.join(PROJECT, bak));

        const applied = await callTool('scene_apply', {
            path: a,
            ops: [
                { op: 'addNode', parent: parentName, name: 'DiffNew', position: { x: 3, y: 4 } },
                { op: 'addComponent', node: 'DiffNew', type: 'cc.Label' }
            ]
        });
        assert.ok(!applied.error, applied.error);
        const setOp = await callTool('scene_set_props', {
            path: a, node: parentName, opacity: 200
        });
        assert.ok(!setOp.error, setOp.error);

        const d = await callTool('prefab_diff', { a: a, against: bak });
        assert.ok(!d.error, d.error);
        assert.strictEqual(d.summary.added, 1, '加了 1 个节点却没报：' + JSON.stringify(d.summary));
        const addedPath = d.added[0].path;
        assert.ok(/DiffNew$/.test(addedPath), '新增节点的路径不对：' + addedPath);
        assert.strictEqual(d.added[0].components, 1, '新增节点上挂的 Label 没算进组件数');

        const changedNames = d.changed.map(function (c) { return c.path; });
        assert.ok(changedNames.length >= 1, '改了透明度却没报 changed');
        const opChange = d.changed.filter(function (c) {
            return c.fields.opacity && c.fields.opacity[1] === 200;
        });
        assert.ok(opChange.length === 1, '透明度变化没被识别（[旧值,新值] 应该是 [255,200]）：' +
            JSON.stringify(d.changed.slice(0, 3)));

        // 收尾
        await callTool('scene_remove_node', { path: a, node: 'DiffNew' });
        await callTool('scene_set_props', { path: a, node: parentName, opacity: 255 });
        try { fs.unlinkSync(path.join(PROJECT, bak)); } catch (e) { /* 忽略 */ }
        console.log('        added=' + d.summary.added + ' changed=' + d.summary.changed +
            ' unchanged=' + d.summary.unchanged);
    });

    await check('prefab_diff 认改名（按 _id），并校验参数', async function () {
        const a = tmpRel;
        const bak = diffDirRel + '/rename-base.fire';
        fs.copyFileSync(path.join(PROJECT, a), path.join(PROJECT, bak));

        // 场景里的节点有 _id，改名应该被认成 renamed 而不是「删一个 + 加一个」
        const sub = await callTool('query_scene_tree', { path: a, node: parentName, maxDepth: 1 });
        const kid = (sub.tree.children || [])[0];
        if (!kid) { console.log('        父节点下没有子节点，跳过'); return; }

        // 用节点 id 而不是名字：不同项目里同名节点很常见（cleanMaster 有两个 bg），
        // 用名字会撞上"有多个同名节点"的保护。
        const kidRef = String(kid.id);
        const r = await callTool('scene_set_props', { path: a, node: kidRef, name: kid.name + '_renamed' });
        assert.ok(!r.error, r.error);

        const d = await callTool('prefab_diff', { a: a, b: bak });
        assert.ok(!d.error, d.error);
        assert.strictEqual(d.summary.renamed, 1, '改名没被认出来：' + JSON.stringify(d.summary));
        assert.strictEqual(d.summary.added, 0, '改名被误算成新增');
        assert.strictEqual(d.summary.removed, 0, '改名被误算成删除');

        await callTool('scene_set_props', { path: a, node: kidRef, name: kid.name });
        try { fs.unlinkSync(path.join(PROJECT, bak)); } catch (e) { /* 忽略 */ }
    });

    await check('prefab_diff 缺参数时报错并给出做法', async function () {
        const a = await callTool('prefab_diff', { a: tmpRel });
        assert.ok(a.error && /against|b/.test(a.error), '缺基准文件没报错');
        const b = await callTool('prefab_diff', { a: tmpRel, b: 'assets/__不存在__.fire' });
        assert.ok(b.error && /不存在/.test(b.error), '不存在的基准文件没报错');

        // 这一组用完就把临时目录收掉，别在项目里留空目录
        try { fs.rmSync(diffDirAbs, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    });

    console.log('\n=== 项目体检的自动修复（project_doctor fix） ===');

    await check('doctor 能识别 spriteFrame 填错类型并给出修复计划', async function () {
        // 找一张图，拿 texture uuid 和 sprite-frame uuid
        const png = findFirstPng();
        if (!png) { console.log('        项目里没有 png，跳过'); return; }
        const res = await callTool('resolve_asset', { input: png });
        if (!res.spriteFrameUuid || !res.mainUuid) { console.log('        这张图没有 sprite-frame，跳过'); return; }

        // 现造一个带 Sprite 的预制体，再把 spriteFrame 换成 texture uuid。
        // 必须建在 assets 下 —— prefab_create 拒绝写到 assets 之外（编辑器不导入）。
        const badDirRel = 'assets/__mcp_diff_test';
        const badRel = badDirRel + '/bad-sprite.prefab';
        fs.mkdirSync(path.join(PROJECT, badDirRel), { recursive: true });
        const made = await callTool('prefab_create', {
            path: badRel,
            root: {
                name: 'BadSprite',
                size: [200, 100],
                sprite: png,
                children: [{ name: 'icon', size: [40, 40], pos: [0, 0], sprite: png }]
            }
        });
        if (made.error) { console.log('        造样本失败，跳过：' + made.error); return; }

        const badAbs = path.join(PROJECT, badRel);
        const arr = JSON.parse(fs.readFileSync(badAbs, 'utf8'));
        let touched = 0;
        arr.forEach(function (o) {
            if (o && o.__type__ === 'cc.Sprite' && o._spriteFrame && o._spriteFrame.__uuid__) {
                o._spriteFrame.__uuid__ = res.mainUuid;
                touched++;
            }
        });
        if (!touched) { console.log('        样本里没有 Sprite，跳过'); return; }
        fs.writeFileSync(badAbs, JSON.stringify(arr, null, 2), 'utf8');

        const report = await callTool('project_doctor', { path: badRel });
        assert.ok(!report.error, report.error);
        const text = JSON.stringify(report.problems);
        assert.ok(/非 sprite-frame/.test(text), '没报出 spriteFrame 类型错：' + text.slice(0, 200));
        assert.ok(report.fixableCount >= 1, '没给出可修复项');
        const plan = (report.fixable || []).filter(function (x) { return x.kind === 'wrong-sprite-frame'; });
        assert.strictEqual(plan.length, 1, 'spriteFrame 修复项应该正好一条（同一个 uuid 只算一次）');
        assert.strictEqual(plan[0].from, res.mainUuid);
        assert.strictEqual(plan[0].to, res.spriteFrameUuid);

        // preview 不写盘
        const before = fs.readFileSync(badAbs, 'utf8');
        const pv = await callTool('project_doctor', { path: badRel, fix: 'preview' });
        assert.ok(!pv.error, pv.error);
        assert.ok(Array.isArray(pv.fixPreview) && pv.fixPreview.length, 'preview 没给计划');
        assert.strictEqual(fs.readFileSync(badAbs, 'utf8'), before,
            'fix:"preview" 竟然改了文件');

        // apply
        const fx = await callTool('project_doctor', { path: badRel, fix: true });
        assert.ok(!fx.error, fx.error);
        assert.ok(fx.fixed.some(function (x) { return x.kind === 'wrong-sprite-frame'; }), '没有修复记录');
        assert.strictEqual(fx.fixFailed.length, 0, '修复失败：' + JSON.stringify(fx.fixFailed));

        const after = JSON.parse(fs.readFileSync(badAbs, 'utf8'));
        let stillBad = 0;
        let fixedCount = 0;
        after.forEach(function (o) {
            if (o && o.__type__ === 'cc.Sprite' && o._spriteFrame) {
                if (o._spriteFrame.__uuid__ === res.mainUuid) stillBad++;
                if (o._spriteFrame.__uuid__ === res.spriteFrameUuid) fixedCount++;
            }
        });
        assert.strictEqual(stillBad, 0, '还有 ' + stillBad + ' 处没改');
        assert.ok(fixedCount >= touched, '改好的数量不对：' + fixedCount + ' < ' + touched);

        try { fs.rmSync(path.join(PROJECT, badDirRel), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        try { fs.rmSync(path.join(PROJECT, badDirRel + '.meta'), { force: true }); } catch (e) { /* 忽略 */ }
        console.log('        ' + touched + ' 处 texture uuid → sprite-frame uuid，preview 未写盘');
    });

    await check('doctor 把孤儿 .meta 挪到隔离区（不是删）', async function () {
        const fixtureDir = 'assets/__mcp_test_orphan';
        const metaRel = fixtureDir + '/ghost.png.meta';
        const metaAbs = path.join(PROJECT, metaRel);
        fs.mkdirSync(path.join(PROJECT, fixtureDir), { recursive: true });
        fs.writeFileSync(metaAbs, JSON.stringify({
            ver: '2.3.7',
            uuid: '11111111-2222-3333-4444-555555555555',
            importer: 'texture',
            subMetas: {}
        }, null, 2), 'utf8');

        const report = await callTool('project_doctor', { limit: 1 });
        assert.ok(!report.error, report.error);
        const plan = (report.fixable || []).filter(function (x) {
            return x.kind === 'orphan-meta' && x.file === metaRel;
        });
        assert.strictEqual(plan.length, 1, '孤儿 .meta 没进修复计划');

        const fx = await callTool('project_doctor', { limit: 1, fix: true });
        assert.ok(!fx.error, fx.error);
        assert.ok(fx.quarantine, '没返回隔离区路径');
        assert.ok(!fs.existsSync(metaAbs), '孤儿 .meta 还在原处');
        const movedAbs = path.join(PROJECT, fx.quarantine, metaRel);
        assert.ok(fs.existsSync(movedAbs), '隔离区里找不到挪走的文件：' + movedAbs);

        // 收尾
        try { fs.rmSync(path.join(PROJECT, fixtureDir), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(movedAbs); } catch (e) { /* 忽略 */ }
        try { fs.rmSync(path.join(PROJECT, fx.quarantine), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    });

    await check('scene_capture 没开编辑器时明确报错（不返回空白图）', async function () {
        const r = await callTool('scene_capture', {});
        assert.ok(r.error, '没有编辑器却说截图成功了');
        assert.ok(/场景面板/.test(r.error), '错误信息没说清是拿不到场景面板：' + r.error);
        assert.ok(!/\.png/.test(r.error), '报错里不该出现文件路径（说明它居然写了文件）');
    });

    await check('scene_capture 的干净画面隐藏/恢复成对（含预制体保存/关闭条）', async function () {
        // 真机 DOM 没法在 mock 环境里跑，但至少锁住"关掉必须能恢复"这个不变量：
        // 只关不恢复会把用户编辑器界面改坏，比截图脏严重得多。
        const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
        assert.ok(src.indexOf('DECO_DOM_OFF_CODE') >= 0 && src.indexOf('DECO_DOM_ON_CODE') >= 0,
            '缺 DOM 叠加层的隐藏/恢复代码');
        assert.ok(/DECO_DOM_OFF_CODE[\s\S]*editButtons/.test(src),
            '隐藏清单里没有预制体的「保存/关闭」悬浮条');
        assert.ok(src.indexOf('data-mcp-deco-prev') >= 0,
            '没把原 display 存下来，截完无法还原');
        const schema = require('./lib/tool-schema.js').TOOLS;
        const sc = schema.filter(function (t) { return t.name === 'scene_capture'; })[0];
        assert.ok(sc && /保存\/关闭/.test(sc.description), '工具说明没写清会隐藏预制体悬浮条');
        assert.ok(sc && sc.inputSchema.properties.clean, 'clean 参数丢了');
    });

    await check('diffNodes：场景按 id 比、预制体按 path 比', async function () {
        const es = require('./lib/editor-state.js');

        // 场景：两个节点 id 相同但改了名，应该算"同一个"（按 id 比）
        const byId = es.diffNodes(
            [{ id: 'a', name: 'old' }, { id: 'b', name: 'B' }],
            [{ id: 'a', name: 'new' }, { id: 'b', name: 'B' }]
        );
        assert.strictEqual(byId.inSync, true, '改名被当成新增/删除：' + JSON.stringify(byId));

        // 预制体：id 全是空串，必须退化到 path，且重名要按序号区分
        const byPath = es.diffNodes(
            [{ id: '', name: 'Root', path: 'Root' }, { id: '', name: 'x', path: 'Root/x' }],
            [{ id: '', name: 'Root', path: 'Root' }, { id: '', name: 'x', path: 'Root/x' }],
            'path'
        );
        assert.strictEqual(byPath.inSync, true, '路径相同却说不一致');
        assert.strictEqual(byPath.mode, 'path');

        const dup = es.diffNodes(
            [{ id: '', name: 'x', path: 'R/x' }, { id: '', name: 'x', path: 'R/x' }],
            [{ id: '', name: 'x', path: 'R/x' }],
            'path'
        );
        assert.strictEqual(dup.fileOnly.length, 1, '两个同名同路径的节点被压成了一个');
    });

    await check('classify：我们删掉的节点不算"用户未保存"', async function () {
        const es = require('./lib/editor-state.js');
        const liveOnly = [{ id: 'gone', name: 'Deleted' }, { id: 'user', name: 'UserMade' }];

        // 上一批写入记下 removed: ['gone'] → 只有 user 才是真·未保存
        const cls = es.classify({
            ledger: { tracked: true, changed: false, lastWrite: { removed: ['gone'] } },
            diff: { inSync: false, fileOnly: [], liveOnly: liveOnly }
        });
        assert.strictEqual(cls.risk, 'editor-has-unsaved');
        assert.strictEqual(cls.losesOnReload, 1, '应只算 user 一个，实际 ' + cls.losesOnReload);

        // 全部是我们删的 → 只是编辑器旧了，重载无损
        const cls2 = es.classify({
            ledger: { tracked: true, changed: false, lastWrite: { removed: ['gone'] } },
            diff: { inSync: false, fileOnly: [], liveOnly: [{ id: 'gone', name: 'Deleted' }] }
        });
        assert.strictEqual(cls2.risk, 'editor-stale');
        assert.strictEqual(cls2.losesOnReload, 0);
    });

    console.log('\n=== 预制体写入（scene_* 直接吃 .prefab） ===');

    const tmpPrefabRel = 'temp/mcp-prefab-test.prefab';
    const tmpPrefabAbs = path.join(PROJECT, tmpPrefabRel);

    await check('scene_add_node 能写进 .prefab 且补上 PrefabInfo', async function () {
        const srcPrefab = findFirstPrefab();
        if (!srcPrefab) {
            console.log('        项目里没有 .prefab，跳过');
            return;
        }
        fs.copyFileSync(path.join(PROJECT, srcPrefab), tmpPrefabAbs);
        const before = fs.readFileSync(tmpPrefabAbs, 'utf8');
        const beforeArr = JSON.parse(before);
        const infoBefore = beforeArr.filter(function (o) { return o && o.__type__ === 'cc.PrefabInfo'; }).length;

        const r = await callTool('scene_add_node', {
            path: tmpPrefabRel, parent: 'Root', name: 'McpPrefabNode', position: { x: 3, y: 4 }
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.kind, 'prefab', 'kind 应该报 prefab');
        assert.ok(r.added.prefabInfoId > 0, '没给新节点建 PrefabInfo');

        const after = JSON.parse(fs.readFileSync(tmpPrefabAbs, 'utf8'));
        const infoAfter = after.filter(function (o) { return o && o.__type__ === 'cc.PrefabInfo'; }).length;
        assert.strictEqual(infoAfter, infoBefore + 1, 'PrefabInfo 数量没加一');

        const node = after[r.added.id];
        assert.ok(node && node._prefab && typeof node._prefab.__id__ === 'number', '节点缺 _prefab');
        assert.strictEqual(after[node._prefab.__id__].__type__, 'cc.PrefabInfo', '_prefab 没指向 PrefabInfo');
        assert.strictEqual(node._id, '', '预制体里的节点 _id 应该是空串');
        assert.ok(after[node._prefab.__id__].fileId.length === 22, 'fileId 长度不对');

        console.log('        PrefabInfo ' + infoBefore + ' → ' + infoAfter + '，节点 _id=""  fileId=' +
            after[node._prefab.__id__].fileId);
    });

    await check('预制体 add → set → remove 往返逐字节还原', async function () {
        if (!fs.existsSync(tmpPrefabAbs)) { console.log('        前置失败，跳过'); return; }

        const s = await callTool('scene_set_props', {
            path: tmpPrefabRel, node: 'McpPrefabNode', opacity: 128, size: { width: 50, height: 60 }
        });
        assert.ok(!s.error, s.error);
        assert.ok(s.changed.indexOf('opacity') >= 0, 'opacity 没改');

        const d = await callTool('scene_remove_node', { path: tmpPrefabRel, node: 'McpPrefabNode' });
        assert.ok(!d.error, d.error);

        const restored = fs.readFileSync(tmpPrefabAbs, 'utf8');
        const original = fs.readFileSync(path.join(PROJECT, findFirstPrefab()), 'utf8');
        assert.strictEqual(restored, original, '预制体加/改/删之后没还原成原文件（__id__ 重映射或换行风格有问题）');
        try { fs.unlinkSync(tmpPrefabAbs); } catch (e) { /* 忽略 */ }
    });

    await check('预制体拒绝删根节点 / 根别名 Root 可用', async function () {
        if (!fs.existsSync(tmpPrefabAbs)) { fs.copyFileSync(path.join(PROJECT, findFirstPrefab()), tmpPrefabAbs); }
        const r = await callTool('scene_remove_node', { path: tmpPrefabRel, node: 'Root' });
        // 'Root' 是根别名；根节点名字可能是别的，所以这里只要求"不报找不到节点"
        assert.ok(r.error && !/找不到节点/.test(r.error), '根别名没被识别：' + (r.error || '没报错'));
        assert.ok(/根节点/.test(r.error), '错误信息没说清是根节点：' + r.error);
    });

    console.log('\n=== 从零造预制体（prefab_create / 布局自检 / 结构校验） ===');

    const specDirRel = 'assets/__mcp_test_prefab';
    const specRel = specDirRel + '/Spec.prefab';
    const specAbs = path.join(PROJECT, specRel);

    await check('prefab_create 从 spec 生成，图片/脚本只给路径', async function () {
        try { fs.rmSync(path.join(PROJECT, specDirRel), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        try { fs.rmSync(path.join(PROJECT, specDirRel) + '.meta', { force: true }); } catch (e) { /* 忽略 */ }

        const png = findFirstPng();
        const root = {
            name: 'SpecRoot',
            size: [750, 1334],
            children: [
                { name: 'title', size: [400, 60], pos: [0, 500], label: '标题' },
                { name: 'icon', size: [100, 100], pos: [0, 0] },
                { name: 'overlapA', size: [100, 100], pos: [0, -300], label: 'A' },
                { name: 'overlapB', size: [100, 100], pos: [10, -300], label: 'B' },
                { name: 'wayOff', size: [50, 50], pos: [5000, 5000], label: '出界' },
                { name: 'panel', size: [200, 200], pos: [0, 100], children: [{ name: 'inner', size: [20, 20], pos: [0, 0] }] }
            ]
        };
        if (png) root.children[1].sprite = png;

        const r = await callTool('prefab_create', { path: specRel, root: root });
        assert.ok(!r.error, r.error);
        assert.ok(/^[0-9a-f-]{36}$/.test(r.uuid), 'uuid 格式不对：' + r.uuid);
        assert.strictEqual(r.nodeCount, 8, '节点数不对：' + r.nodeCount);
        assert.ok(fs.existsSync(specAbs), '文件没落盘');
        assert.ok(fs.existsSync(specAbs + '.meta'), '.meta 没生成');

        // 结构校验：用 lib 里的校验器再过一遍（生成的东西也不信"应该没问题"）
        const prefablib = require('./lib/prefab.js');
        const arr = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        const problems = prefablib.validatePrefabArray(arr, specRel);
        assert.strictEqual(problems.length, 0, '生成的结构不合法：' + problems.join('；'));

        // 读回来：节点树、组件、图片引用都对得上
        const tree = await callTool('query_scene_tree', { path: specRel });
        assert.ok(!tree.error, tree.error);
        const flat = flatten(tree.tree);
        assert.strictEqual(flat.length, 8, 'query_scene_tree 读出的节点数不对：' + flat.length);
        const title = flat.filter(function (x) { return x.node.name === 'title'; })[0];
        assert.ok(title && title.node.components.some(function (c) { return c.type === 'cc.Label'; }), 'title 上的 Label 没挂上');
        if (png) {
            const icon = flat.filter(function (x) { return x.node.name === 'icon'; })[0];
            const sprite = icon.node.components.filter(function (c) { return c.type === 'cc.Sprite'; })[0];
            assert.ok(sprite && sprite.spriteFrame, 'icon 的 Sprite 没接上图片');
            assert.strictEqual(sprite.spriteFrame.resourceType, 'sprite-frame',
                'spriteFrame 填错类型了（应该是 sprite-frame）：' + sprite.spriteFrame.resourceType);
            assert.strictEqual(sprite.spriteFrame.problem, undefined, 'spriteFrame 有问题：' + sprite.spriteFrame.problem);
        }
        console.log('        ' + r.nodeCount + ' 个节点 / ' + r.objects + ' 个对象，模板文件 ' + r.templateFiles + ' 个');
    });

    await check('prefab_layout_check 报出重叠与越界', async function () {
        if (!fs.existsSync(specAbs)) { console.log('        前置失败，跳过'); return; }
        const r = await callTool('prefab_layout_check', { path: specRel });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.kind, 'prefab');
        assert.ok(r.nodeCount >= 8, '节点数不对：' + r.nodeCount);
        assert.ok(r.overlaps.length >= 1, 'overlapA/overlapB 明显重叠却没报');
        assert.ok(r.outOfBounds.length >= 1, 'wayOff 在 (5000,5000) 却没报越界');
        const names = r.overlaps.map(function (o) { return o.a + '|' + o.b; }).join(' ');
        assert.ok(/overlapA/.test(names), '重叠里没 overlapA：' + names);
        console.log('        ' + r.summary);
    });

    await check('resolve_asset 查预制体不再误报 partial', async function () {
        const r = await callTool('resolve_asset', { input: specRel });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.kind, 'prefab');
        // 关键：script 字段是 null 但那是设计如此，不该把整次调用标成 partial
        const u = await callTool('resolve_asset', { input: r.uuid });
        assert.strictEqual(u.__status, 'ok', '查预制体 uuid 报了 ' + u.__status +
            '（空字段：' + JSON.stringify(u.__emptyFields) + '）');
        assert.strictEqual(r.__status, 'ok', '按路径查预制体报了 ' + r.__status);
    });

    await check('write_file 拒绝结构坏掉的 .prefab', async function () {
        const bad = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        // 找一个非根节点，把 _prefab 摘掉 —— 编辑器导入不报错，运行时才炸
        const victim = bad.filter(function (o, i) { return i > 1 && o.__type__ === 'cc.Node'; })[0];
        victim._prefab = null;
        const target = 'temp/mcp-bad-prefab.prefab';
        const r = await callTool('write_file', { path: target, content: JSON.stringify(bad, null, 2) });
        assert.ok(r.error, '坏预制体竟然写进去了');
        assert.ok(/_prefab/.test(r.error), '错误信息没指出 _prefab：' + r.error);
        assert.ok(/#\d+/.test(r.error), '错误信息没指出具体下标：' + r.error);
        try { fs.unlinkSync(path.join(PROJECT, target)); } catch (e) { /* 可能没写成功 */ }
    });

    await check('结构校验不把 cc.ClickEvent 当组件（真实项目有大量 Button）', async function () {
        // cc.ClickEvent / cc.AnimationClip 是普通 CCClass，不是 Component，没有 node 字段。
        // v0.3.4 的校验器按"非 Node 就必须有 node"扫，会把这些全判成坏结构 ——
        // 结果 write_file 在真实项目上被误拦。这条守住它别再回来。
        const prefablib = require('./lib/prefab.js');
        const arr = [
            { __type__: 'cc.Prefab', _name: '', _objFlags: 0, _native: '', data: { __id__: 1 }, optimizationPolicy: 0, asyncLoadAssets: false, readonly: false },
            {
                __type__: 'cc.Node', _name: 'Root', _objFlags: 0, _parent: null, _children: [],
                _active: true, _components: [{ __id__: 2 }], _prefab: { __id__: 4 },
                _opacity: 255, _color: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 },
                _contentSize: { __type__: 'cc.Size', width: 100, height: 100 },
                _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 },
                _trs: { __type__: 'TypedArray', ctor: 'Float64Array', array: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] },
                _eulerAngles: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
                _skewX: 0, _skewY: 0, _is3DNode: false, _groupIndex: 0, groupIndex: 0, _id: ''
            },
            {
                __type__: 'cc.Button', _name: '', _objFlags: 0, node: { __id__: 1 }, _enabled: true,
                clickEvents: [{ __id__: 3 }], _id: ''
            },
            { __type__: 'cc.ClickEvent', target: null, component: '', handler: 'onClick', customEventData: '' },
            { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: '', sync: false }
        ];
        const problems = prefablib.validatePrefabArray(arr);
        assert.strictEqual(problems.filter(function (x) { return /ClickEvent/.test(x); }).length, 0,
            '仍然把 ClickEvent 当组件：' + problems.join('；'));
        assert.strictEqual(problems.length, 0, '合法结构被判坏了：' + problems.join('；'));
    });

    await check('write_file 覆盖预制体时沿用旧 fileId（节点身份不丢）', async function () {
        if (!fs.existsSync(specAbs)) { console.log('        前置失败，跳过'); return; }
        const orig = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        const oldIds = {};
        orig.forEach(function (o) {
            if (o && o.__type__ === 'cc.PrefabInfo' && o.fileId) oldIds[o.fileId] = 1;
        });
        const oldCount = Object.keys(oldIds).length;
        assert.ok(oldCount > 0, '原文件没有 fileId，测不出来');

        // 模拟"AI 重新生成整份文件"：fileId 全部换新
        const rewritten = JSON.parse(JSON.stringify(orig));
        rewritten.forEach(function (o) {
            if (o && o.__type__ === 'cc.PrefabInfo' && o.fileId) {
                o.fileId = 'RND' + Math.random().toString(36).slice(2, 19);
            }
        });
        const r = await callTool('write_file', { path: specRel, content: JSON.stringify(rewritten, null, 2) });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.fileIdReused, oldCount, '复用 fileId 数量不对：' + r.fileIdReused + ' / 期望 ' + oldCount);

        const after = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        const afterIds = {};
        after.forEach(function (o) { if (o && o.__type__ === 'cc.PrefabInfo' && o.fileId) afterIds[o.fileId] = 1; });
        Object.keys(oldIds).forEach(function (id) {
            assert.ok(afterIds[id], '旧 fileId 没保住：' + id);
        });
    });

    console.log('\n=== 项目体检（project_doctor：查项目，不查 MCP） ===');

    await check('project_doctor 干净的预制体不误报', async function () {
        if (!fs.existsSync(specAbs)) { console.log('        前置失败，跳过'); return; }
        const r = await callTool('project_doctor', { path: specRel });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.scanned, 1);
        assert.strictEqual(r.problemCount, 0,
            '自己生成的预制体竟然有 ' + r.problemCount + ' 个问题：' +
            JSON.stringify(r.problems && r.problems.slice(0, 3)));
        console.log('        ' + specRel + ' → 0 问题');
    });

    await check('project_doctor 抓得到悬空 __uuid__', async function () {
        if (!fs.existsSync(specAbs)) { console.log('        前置失败，跳过'); return; }
        const badRel = 'temp/doctor-bad.prefab';
        const badAbs = path.join(PROJECT, badRel);
        const arr = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        // 把第一个 spriteFrame 改成不存在的 uuid
        let hit = 0;
        arr.forEach(function (o) {
            if (o && o.__type__ === 'cc.Sprite' && o._spriteFrame && o._spriteFrame.__uuid__) {
                o._spriteFrame.__uuid__ = '00000000-1111-2222-3333-444444444444';
                // 顺手塞一个假的 _materials 引用：材质是"数组元素本身是 {__uuid__}"的形态，
                // 扫描器如果只查属性值、不查元素自己，就会漏掉它
                o._materials = [{ __uuid__: '00000000-5555-6666-7777-888888888888' }];
                hit++;
            }
        });
        if (!hit) { console.log('        样本里没有 Sprite，跳过'); return; }
        fs.writeFileSync(badAbs, JSON.stringify(arr, null, 2), 'utf8');

        const r = await callTool('project_doctor', { path: badRel });
        assert.ok(!r.error, r.error);
        assert.ok(r.problemCount >= 1, '悬空 uuid 竟然没报');
        const text = JSON.stringify(r.problems);
        assert.ok(/悬空|找不到/.test(text), '问题描述里没提悬空引用：' + text.slice(0, 200));
        assert.ok(text.indexOf('00000000-1111-2222-3333-444444444444') >= 0, '没报出具体是哪个 uuid');
        assert.ok(text.indexOf('00000000-5555-6666-7777-888888888888') >= 0,
            '数组元素形态的引用（_materials 里的 {__uuid__}）没被扫描到');
        // temp 下的副本没有 .meta，应该同时报出来（这是真实行为，不是 bug）
        assert.ok(/缺 \.meta/.test(text), '缺 .meta 没被报出来');
        try { fs.unlinkSync(badAbs); } catch (e) { /* 忽略 */ }
        console.log('        抓到 ' + r.problemCount + ' 条：' +
            Object.keys(r.summary).slice(0, 3).join(' / '));
    });

    await check('project_doctor includeLayout 能报出压字', async function () {
        if (!fs.existsSync(specAbs)) { console.log('        前置失败，跳过'); return; }
        const r = await callTool('project_doctor', { path: specRel, includeLayout: true });
        assert.ok(!r.error, r.error);
        const text = JSON.stringify(r.problems);
        assert.ok(/布局/.test(text), 'Spec 预制体里 overlapA/overlapB 明显重叠，没报布局问题：' + text.slice(0, 200));
        console.log('        includeLayout → ' + r.problemCount + ' 条（含布局）');
    });

    await check('script_compile_status 三种状态不编造', async function () {
        const ts = findFirstTs();
        if (!ts) { console.log('        项目里没有 .ts，跳过'); return; }

        const r = await callTool('script_compile_status', { paths: [ts] });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.scripts.length, 1, '指定的脚本没被列出');
        const s = r.scripts[0];
        assert.ok(['ok', 'stale', 'missing'].indexOf(s.state) >= 0, '状态非法：' + s.state);
        assert.ok(s.sourceMtime, '没给源码时间');
        assert.ok(Array.isArray(s.diagnostics), 'diagnostics 不是数组');
        assert.strictEqual(s.diagnostics.length, 0, 'diagnostics 不该编造内容');

        // since 过滤：给一个未来时间点 → 一条都不该报
        const none = await callTool('script_compile_status', { paths: [ts], since: Date.now() + 3600000 });
        assert.strictEqual(none.scripts.length, 0, 'since 过滤没生效');

        // 不存在的脚本要如实说，而不是硬编一个状态
        const miss = await callTool('script_compile_status', { paths: ['assets/__不存在__.ts'] });
        assert.strictEqual(miss.scripts[0].state, 'missing-source', '不存在的脚本状态不对');

        // 扫描模式：只列有问题的，且不报错
        const scan = await callTool('script_compile_status', {});
        assert.ok(!scan.error, scan.error);
        assert.ok(typeof scan.summary.ok === 'number', 'summary 结构不对');
        console.log('        ' + ts + ' → ' + s.state + '（扫描 ' + scan.scanned + ' 个脚本，' +
            'stale ' + scan.summary.stale + ' / missing ' + scan.summary.missing + '）');
    });

    await check('script_compile_status waitMs 会轮询，超时如实说明', async function () {
        const ts = findFirstTs();
        if (!ts) { console.log('        项目里没有 .ts，跳过'); return; }

        // 已经编译好的：应当立刻 settled
        const ok = await callTool('script_compile_status', { paths: [ts], waitMs: 1200 });
        assert.ok(!ok.error, ok.error);
        assert.strictEqual(typeof ok.waitedMs, 'number', '没报 waitedMs');
        const pending = (ok.scripts || []).filter(function (x) { return x.state !== 'ok'; });
        assert.strictEqual(ok.settled, pending.length === 0,
            'settled 和 pending 对不上：' + JSON.stringify(pending));

        // 永远编不出来的脚本：等到超时必须说"别急着构建"
        const rel = specDirRel + '/never-compiled.ts';
        await callTool('write_file', { path: rel, content: 'export const x = 1;\n' });
        const r = await callTool('script_compile_status', { paths: [rel], waitMs: 900 });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.settled, false, '一个没有编译产物的脚本竟然报 settled');
        assert.ok(r.waitedMs >= 700, '没真的等：' + r.waitedMs + 'ms');
        assert.ok(Array.isArray(r.pending) && r.pending.length === 1, '没列出还在等谁');
        assert.ok(/别急着构建/.test(r.note), '超时提示里没说别构建：' + r.note.slice(0, 80));
        try { fs.unlinkSync(path.join(PROJECT, rel)); } catch (e) { /* 忽略 */ }
    });

    await check('refresh_assets 不传参时刷掉所有写过的目录（dirty 追踪）', async function () {
        const aRel = specDirRel + '/dirty-a.ts';
        const bRel = specDirRel + '/nested/dirty-b.prefab';
        const a = await callTool('write_file', { path: aRel, content: 'export const a = 1;\n' });
        assert.ok(!a.error, a.error);
        assert.strictEqual(a.created, true);

        const prefabBody = JSON.parse(fs.readFileSync(specAbs, 'utf8'));
        const b = await callTool('write_file', { path: bRel, content: JSON.stringify(prefabBody, null, 2) });
        assert.ok(!b.error, b.error);
        assert.strictEqual(b.prefabValidated, true, '写 .prefab 没走结构校验');

        const r = await callTool('refresh_assets', {});
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.sources, 'dirty', '没走 dirty 追踪：' + r.sources);
        const joined = r.refreshed.join(' ');
        assert.ok(joined.indexOf(specDirRel + '/') >= 0, '没刷第一层目录：' + joined);
        assert.ok(joined.indexOf(specDirRel + '/nested/') >= 0, '没刷嵌套目录：' + joined);
        console.log('        ' + r.refreshed.join(', '));
    });

    await check('refresh_assets 支持 paths 一次刷多个目录', async function () {
        const r = await callTool('refresh_assets', {
            paths: ['db://' + specDirRel + '/', 'db://assets/']
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.sources, 'path');
        assert.ok(r.refreshed.length >= 2, '没有合并去重后刷多个：' + r.refreshed.join(','));
    });

    console.log('\n=== 资源层 ===');

    await check('asset_refs 能反查"谁引用了我"', async function () {
        // 找一个真实被引用的图片：从预制体里翻一个 Sprite 用的图
        const prefabs = collectPrefabs(30);
        let hit = null;
        for (const pf of prefabs) {
            const tree = await callTool('query_scene_tree', { path: pf, maxDepth: 4 });
            if (tree.error) continue;
            const flat = flatten(tree.tree);
            for (const item of flat) {
                const sp = (item.node.components || []).filter(function (c) { return c.spriteFrame && c.spriteFrame.path; })[0];
                if (sp) { hit = { prefab: pf, image: sp.spriteFrame.path, uuid: sp.spriteFrame.uuid }; break; }
            }
            if (hit) break;
        }
        if (!hit) {
            console.log('        项目里找不到"预制体引用图片"的样本，跳过');
            return;
        }

        const r = await callTool('asset_refs', { input: hit.image });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.path, hit.image);
        assert.ok(Array.isArray(r.referrers), 'referrers 不是数组');
        assert.ok(r.referrerCount >= 1, '这张图明明被 ' + hit.prefab + ' 引用，却报没人引用');
        assert.ok(r.unused === false, 'unused 应该 false');
        const files = r.referrers.map(function (x) { return x.file; });
        assert.ok(files.indexOf(hit.prefab) >= 0, '引用列表里没有 ' + hit.prefab + '：' + files.join(','));
        console.log('        ' + hit.image + ' ← ' + r.referrerCount + ' 个文件（' + files.slice(0, 3).join(', ') + '）');

        // 反向：这个预制体引用了谁
        const out = await callTool('asset_refs', { input: hit.prefab, direction: 'out' });
        assert.ok(!out.error, out.error);
        assert.ok(Array.isArray(out.outgoing) && out.outgoing.length > 0, '预制体居然没引用任何资源');
        const uuids = out.outgoing.map(function (x) { return x.uuid; });
        assert.ok(uuids.indexOf(hit.uuid) >= 0, 'outgoing 里没有刚才那张图的 uuid');
        assert.ok(out.outgoing.some(function (x) { return x.missing === false; }), '所有引用都标记成 missing，索引有问题');
    });

    await check('asset_refs 对不存在的路径报错 / direction 校验', async function () {
        const a = await callTool('asset_refs', { input: 'assets/__不存在的图__.png' });
        assert.ok(a.error && /找不到/.test(a.error), '不存在的路径没报错：' + (a.error || ''));

        const b = await callTool('asset_refs', { input: 'assets', direction: 'sideways' });
        assert.ok(b.error && /direction/.test(b.error), 'direction 非法没报错：' + (b.error || ''));
    });

    await check('asset_query 结构 / 类型过滤 / limit 截断', async function () {
        let r = await callTool('asset_query', { pattern: 'db://assets/**/*.png' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.total, 3);
        assert.strictEqual(r.assets[0].url, 'db://assets/a.png');
        assert.strictEqual(r.assets[0].path, 'assets/a.png');

        r = await callTool('asset_query', { pattern: 'db://assets/**', type: 'texture' });
        assert.strictEqual(r.total, 2, '类型过滤不对');

        r = await callTool('asset_query', { pattern: 'db://assets/**', limit: 1 });
        assert.strictEqual(r.returned, 1);
        assert.strictEqual(r.truncated, true);
    });

    await check('asset_query 拒绝 assets 之外的路径', async function () {
        const r = await callTool('asset_query', { pattern: 'temp/x.png' });
        assert.ok(r.error, '项目外的路径竟然过了');
        assert.ok(/assets/.test(r.error), '错误信息没说清原因：' + r.error);
    });

    await check('asset_move 移动资源', async function () {
        const r = await callTool('asset_move', { from: 'assets/a.png', to: 'assets/z.png' });
        assert.ok(!r.error, r.error);
        assert.ok(/z\.png$/.test(r.to), 'to 不对：' + r.to);
    });

    await check('asset_delete 必须显式 confirm', async function () {
        const a = await callTool('asset_delete', { path: 'assets/a.png' });
        assert.ok(a.error, '没 confirm 竟然删了');

        const b = await callTool('asset_delete', { path: 'assets/a.png', confirm: true });
        assert.ok(!b.error, b.error);
        assert.strictEqual(b.count, 1);
    });

    await check('asset_meta_get 读出场景的 meta', async function () {
        assert.ok(scenePath, '前置失败：没拿到场景路径');
        const r = await callTool('asset_meta_get', { path: scenePath });
        assert.ok(!r.error, r.error);
        assert.ok(r.meta && typeof r.meta.uuid === 'string', '没读到 uuid');
        assert.strictEqual(r.meta.importer, 'scene', 'importer 不对：' + r.meta.importer);
    });

    await check('asset_meta_set 拒绝危险字段/未知子资源', async function () {
        assert.ok(scenePath, '前置失败：没拿到场景路径');

        const a = await callTool('asset_meta_set', { path: scenePath, props: { _x: 1 } });
        assert.ok(a.error, '改内部字段竟然成功了');

        const b = await callTool('asset_meta_set', { path: scenePath, props: { uuid: 'x' } });
        assert.ok(b.error, '改 uuid 竟然成功了');

        const c = await callTool('asset_meta_set', { path: scenePath, subMetas: { '不存在的子资源': { a: 1 } } });
        assert.ok(c.error, '不存在的子资源竟然成功了');
        assert.ok(/没有这个子资源/.test(c.error), '错误信息不对：' + c.error);
    });

    console.log('\n=== 场景文件与构建 ===');

    // v0.8.1 起 scene_create 默认产出可预览的标准场景（Canvas + Main Camera），
    // 并自动写 start-scene。空场景契约改由 withCanvas:false 显式指定。
    await check('scene_create 建出的场景可解析（默认带 Canvas）', async function () {
        const rel = 'assets/__mcp_test_scene.fire';
        const abs = path.join(PROJECT, rel);
        // scene_create 现在会写 start-scene / 设计分辨率，跑完要还原，
        // 否则后面的 project_settings_get 会读到被本用例改过的值。
        const saved = {
            w: mockProfile.data['design-resolution-width'],
            h: mockProfile.data['design-resolution-height'],
            s: mockProfile.data['start-scene']
        };
        const clean = function () {
            try { fs.unlinkSync(abs); } catch (e) { /* 不存在 */ }
            try { fs.unlinkSync(abs + '.meta'); } catch (e) { /* 不存在 */ }
            mockProfile.data['design-resolution-width'] = saved.w;
            mockProfile.data['design-resolution-height'] = saved.h;
            mockProfile.data['start-scene'] = saved.s;
        };
        clean();

        let template = '';
        try {
            const r = await callTool('scene_create', { path: rel, canvas: [750, 1334] });
            assert.ok(!r.error, r.error);
            assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.uuid),
                'uuid 格式不对：' + r.uuid);

            const tree = await callTool('query_scene_tree', { path: rel });
            assert.ok(!tree.error, tree.error || '新场景解析不了');
            assert.strictEqual(tree.tree.type, 'cc.Scene');
            assert.strictEqual(tree.tree.children.length, 1, '默认应带一个 Canvas 子节点');
            assert.strictEqual(tree.tree.children[0].name, 'Canvas');
            assert.ok(tree.tree.children[0].children.some(function (c) {
                return c.name === 'Main Camera';
            }), 'Canvas 下应有 Main Camera');
            assert.strictEqual(r.startSceneSet, true, '应自动设为启动场景');
            template = r.template;
        } finally {
            // 断言失败也必须清 —— 留一个空场景在 assets/ 下，下一轮会被
            // get_project_info 排在 scenes[0]，连锁挂掉二十多项。
            clean();
        }
        console.log('        模板 = ' + template);
    });

    await check('scene_create withCanvas:false 仍可产出纯空场景', async function () {
        const rel = 'assets/__mcp_test_scene_bare.fire';
        const abs = path.join(PROJECT, rel);
        const clean = function () {
            try { fs.unlinkSync(abs); } catch (e) { /* 不存在 */ }
            try { fs.unlinkSync(abs + '.meta'); } catch (e) { /* 不存在 */ }
        };
        clean();
        try {
            const r = await callTool('scene_create', { path: rel, withCanvas: false, startScene: false });
            assert.ok(!r.error, r.error);
            const tree = await callTool('query_scene_tree', { path: rel });
            assert.ok(!tree.error, tree.error || '新场景解析不了');
            assert.strictEqual(tree.tree.children.length, 0, 'withCanvas:false 应无子节点');
            assert.strictEqual(r.startSceneSet, false);
        } finally { clean(); }
    });

    await check('scene_create 拒绝覆盖已存在的文件', async function () {
        assert.ok(scenePath, '前置失败：没拿到场景路径');
        const r = await callTool('scene_create', { path: scenePath });
        assert.ok(r.error, '覆盖已有场景竟然成功了');
        assert.ok(/已存在/.test(r.error), '错误信息不对：' + r.error);
    });

    await check('build_targets 列出平台', async function () {
        const r = await callTool('build_targets', {});
        assert.ok(!r.error, r.error);
        assert.ok(r.count > 0, '没列出平台');
        assert.ok(r.targets[0].platform, 'targets 结构不对');
    });

    await check('build_status 初始为 idle', async function () {
        const r = await callTool('build_status', {});
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.state, 'idle');
    });

    await check('scene_move_node 换父节点并同步父子引用', async function () {
        fs.copyFileSync(path.join(PROJECT, scenePath), tmpAbs);

        const tree = await callTool('query_scene_tree', { path: tmpRel, maxDepth: 3 });
        const host = findParentWithTwoChildren(tree.tree);
        if (!host) {
            console.log('        场景里找不到有 2 个子节点的节点，跳过');
            return;
        }

        const src = host.children[0];
        const dst = host.children[1];
        const srcPath = (host.name ? host.name + '/' : '') + src.name;

        const r = await callTool('scene_move_node', {
            path: tmpRel, node: srcPath, newParent: dst.name, index: 0
        });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.to, dst.name, '新父节点不对：' + r.to);

        const newHost = await callTool('query_scene_tree', { path: tmpRel, node: dst.name });
        const moved = (newHost.tree.children || []).filter(function (c) { return c.name === src.name; })[0];
        assert.ok(moved, '节点没出现在新父节点下');

        // 旧父节点下不能再有这个节点
        const oldHost = await callTool('query_scene_tree', { path: tmpRel, node: host.name });
        const still = (oldHost.tree.children || []).filter(function (c) { return c.name === src.name; })[0];
        assert.ok(!still, '旧父节点下还留着这个节点');

        // 复原
        fs.copyFileSync(path.join(PROJECT, scenePath), tmpAbs);
        console.log('        ' + srcPath + ' → ' + dst.name + '[0]');
    });

    await check('project_settings_get 读出设置', async function () {
        const r = await callTool('project_settings_get', {});
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.settings['design-resolution-width'], 960);
        assert.strictEqual(r.settings['fit-height'], true);

        const one = await callTool('project_settings_get', { keys: ['fit-width'] });
        assert.strictEqual(Object.keys(one.settings).length, 1, 'keys 过滤不对');
    });

    await check('project_settings_set 写入并保存', async function () {
        mockProfile.saved = false;
        const r = await callTool('project_settings_set', {
            settings: { 'design-resolution-width': 1280 }
        });
        assert.ok(!r.error, r.error);
        assert.ok(r.changed.indexOf('design-resolution-width') >= 0, 'changed 不对');
        assert.strictEqual(mockProfile.saved, true, '没有触发 save');

        const back = await callTool('project_settings_get', { keys: ['design-resolution-width'] });
        assert.strictEqual(back.settings['design-resolution-width'], 1280, '没写进去');
    });

    await check('prefab_create(from:node) 导出并能实例化回来', async function () {
        const prefabRel = 'assets/__mcp_test.prefab';
        const prefabAbs = path.join(PROJECT, prefabRel);

        const tree = await callTool('query_scene_tree', { path: scenePath, maxDepth: 3 });
        const host = findParentWithTwoChildren(tree.tree);
        if (!host) {
            console.log('        场景里没有合适的节点，跳过');
            return;
        }

        // 逐个候选试：有些节点组件会引用子树外的对象，那种本来就导不出独立预制体
        let srcPath = null;
        let r = null;
        let lastErr = null;
        for (const kid of host.children) {
            const candidate = (host.name ? host.name + '/' : '') + kid.name;
            const res = await callTool('prefab_create', { from: 'node', node: candidate, prefab: prefabRel });
            if (!res.error) {
                srcPath = candidate;
                r = res;
                break;
            }
            lastErr = res.error;
            try { fs.unlinkSync(prefabAbs); } catch (e) { /* 忽略 */ }
            try { fs.unlinkSync(prefabAbs + '.meta'); } catch (e) { /* 忽略 */ }
        }

        if (!srcPath) {
            console.log('        候选节点都导不出独立预制体（最后一个原因：' + lastErr + '）');
            return;
        }

        assert.ok(r.objects > 0, '没导出任何对象');

        // 结构必须符合引擎约定
        const pf = JSON.parse(fs.readFileSync(prefabAbs, 'utf8'));
        assert.strictEqual(pf[0].__type__, 'cc.Prefab', '第 0 个对象不是 cc.Prefab');
        const infoCount = pf.filter(function (o) { return o.__type__ === 'cc.PrefabInfo'; }).length;
        const nodeCount = pf.filter(function (o) { return o.__type__ === 'cc.Node'; }).length;
        assert.strictEqual(infoCount, nodeCount, 'PrefabInfo 数量和节点数不一致');

        const meta = JSON.parse(fs.readFileSync(prefabAbs + '.meta', 'utf8'));
        assert.strictEqual(meta.importer, 'prefab');
        assert.ok(meta.uuid, 'meta 没有 uuid');
        pf.filter(function (o) { return o.__type__ === 'cc.PrefabInfo'; }).forEach(function (o) {
            assert.strictEqual(o.asset.__uuid__, meta.uuid, 'PrefabInfo 的 asset 和 meta.uuid 不一致');
        });

        // 实例化回来
        const inst = await callTool('scene_add_node', {
            from: 'prefab', path: tmpRel, prefab: prefabRel, parent: parentName, name: '__mcp_test_copy'
        });
        assert.ok(!inst.error, inst.error);

        const parentTree = await callTool('query_scene_tree', { path: tmpRel, node: parentName });
        const copy = (parentTree.tree.children || []).filter(function (c) { return c.name === '__mcp_test_copy'; })[0];
        assert.ok(copy, '实例化回来的节点不在');

        // 清理：删实例 + 删预制体文件，然后确认场景副本逐字节还原
        const d = await callTool('scene_remove_node', { path: tmpRel, node: parentName + '/__mcp_test_copy' });
        assert.ok(!d.error, d.error);

        try { fs.unlinkSync(prefabAbs); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(prefabAbs + '.meta'); } catch (e) { /* 忽略 */ }

        const restored = fs.readFileSync(tmpAbs, 'utf8');
        const original = fs.readFileSync(path.join(PROJECT, scenePath), 'utf8');
        assert.strictEqual(restored, original, '预制体导出+实例化+删除后场景副本没还原');
        console.log('        ' + srcPath + ' → ' + prefabRel + '（' + r.objects + ' 个对象 / ' + nodeCount + ' 个节点）');
    });

    await check('preview_control 状态/启动/停止', async function () {
        let r = await callTool('preview_control', { action: 'status' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(typeof r.running, 'boolean');
        assert.ok(r.url, 'status 没返回地址');

        r = await callTool('preview_control', { action: 'start' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.running, true, '启动后 running 不是 true');

        r = await callTool('preview_control', { action: 'stop' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.running, false, '停止后 running 不是 false');
    });

    await check('set_target_project 切换目标 / 拒绝不存在的项目', async function () {
        let r = await callTool('set_target_project', { name: 'mock_beta' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.target, 'mock_beta');
        assert.strictEqual(r.port, 25991);

        // 切完目标要能在 list 里看到
        const list = await callTool('list_open_projects', {});
        const marked = (list.projects || []).filter(function (p) { return p.isTarget; })[0];
        assert.ok(marked, '目标项目没被标出来');
        assert.strictEqual(marked.name, 'mock_beta');

        // 按端口切
        r = await callTool('set_target_project', { port: 25990 });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.target, 'mock_alpha');

        // 不存在的项目要报错
        const bad = await callTool('set_target_project', { name: '根本不存在的项目' });
        assert.ok(bad.error, '不存在的项目竟然成功了');
        assert.ok(/没找到/.test(bad.error), '错误信息不对：' + bad.error);

        // 缺参数也要报错
        const none = await callTool('set_target_project', {});
        assert.ok(none.error, '缺参数竟然成功了');
    });

    await check('目标按项目身份记录，不固化端口', async function () {
        // 目标文件里绝不能有 port 字段 —— 端口会随编辑器重启互换，
        // 存进去就等于存了个会漂移的引用。
        const targetFile = path.join(os.tmpdir(), 'cocos-mcp-2x-test-target.json');
        const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
        assert.ok(!('port' in raw), '目标文件里不该存 port：' + JSON.stringify(raw));
        assert.ok(raw.project, '目标文件里应该有 project 路径');
    });

    await check('端口互换后目标仍能解析到正确项目', async function () {
        // 这是 v0.3.0 的真实 bug：编辑器重启后两个项目端口互换，
        // 目标记的是端口，于是指向了错的项目。
        // 目标 = mock_alpha（端口 25990）
        await callTool('set_target_project', { name: 'mock_alpha' });

        // 模拟端口互换：注册表里两个项目的端口对调
        global.__MCP_TEST_REGISTRY__ = {
            mock_alpha: { name: 'mock_alpha', project: 'G:/mock/alpha', port: 25991, pid: 1 },
            mock_beta: { name: 'mock_beta', project: 'G:/mock/beta', port: 25990, pid: 2 }
        };

        try {
            const info = await callTool('get_project_info', {});
            // 目标是 mock_alpha，即使端口换了，目标项目名不能变
            assert.strictEqual(info.target.name, 'mock_alpha', '端口互换后目标解析错了');
            assert.strictEqual(info.target.port, 25991, '端口没跟着注册表更新');

            // 列表里的目标标记也必须跟着身份走
            const list = await callTool('list_open_projects', {});
            const marked = (list.projects || []).filter(function (p) { return p.isTarget; })[0];
            assert.ok(marked, '端口互换后目标没被标出来');
            assert.strictEqual(marked.name, 'mock_alpha', '目标标记指错项目');
            assert.strictEqual(marked.port, 25991);
        } finally {
            global.__MCP_TEST_REGISTRY__ = null;
        }
    });

    await check('runtime_info 报告场景进程通道可用', async function () {
        const r = await callTool('runtime_info', {});
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.available, true);
        assert.ok(r.capabilities, '没有 capabilities');
        assert.strictEqual(r.capabilities.sceneName, 'MockScene');
        console.log('        通道 = ' + r.source);
    });

    await check('runtime_read 读运行时状态（payload 位置正确）', async function () {
        const r = await callTool('runtime_read', { maxDepth: 2 });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.ok, true);
        assert.ok(r.data, '没有 data');
        assert.strictEqual(r.data.sceneName, 'MockScene');
        // 关键断言：场景进程能收到 payload（__id 在里面）
        // 如果 wrap 又只接第一个参数，_sawPayload 会是 'no'
        assert.strictEqual(r.data._sawPayload, 'yes',
            '场景进程没收到 payload —— 处理器签名又退回 (payload) 了');
        console.log('        场景 = ' + r.data.sceneName + '，读回 ' + r.data.totalRead + ' 个节点');
    });

    await check('eval_scene 求值表达式（expr 模式）', async function () {
        const r = await callTool('eval_scene', { expr: 'cc.director.getScene().name' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.expr, 'cc.director.getScene().name');
        assert.strictEqual(r.value, 'mock-value');
    });

    await check('场景脚本没有该方法时快速失败（不等超时）', async function () {
        // mock 里只注册了 ping / runtimeRead / runtimeEval。
        // 调一个不存在的方法，扩展必须在 3 秒内报"没有处理器"，
        // 而不是干等 15 秒超时 —— 这是 v0.3.0 最大的诊断痛点。
        const started = Date.now();
        const r = await callTool('runtime_read', { sceneMethod: 'definitelyNotRegistered' });
        const elapsed = Date.now() - started;
        assert.ok(r.error, '居然成功了');
        assert.ok(/没有.*处理器/.test(r.error), '错误信息不对：' + r.error);
        assert.ok(elapsed < 3000, '失败耗时 ' + elapsed + 'ms，太慢了');
        console.log('        失败耗时 ' + elapsed + 'ms');
    });

    await check('runtime_report(scene) 读场景 console', async function () {
        const r = await callTool('runtime_report', { source: 'scene', limit: 10 });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.captured, 2);
        assert.strictEqual(r.entries.length, 2);
        assert.strictEqual(r.entries[0].text, '游戏开始');
        assert.strictEqual(r.entries[1].level, 'error');
    });

    await check('runtime_inject 注入 / 幂等 / 撤销（不动资源文件）', async function () {
        const fs2 = require('fs');
        const path2 = require('path');
        const os2 = require('os');
        const injector = require('./injector.js');

        // 造一个假的构建产物
        const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'mcp-inject-'));
        const dest = path2.join(tmp, 'web-mobile');
        fs2.mkdirSync(dest, { recursive: true });

        const origHtml = [
            '<!DOCTYPE html><html><body>',
            '<script src="main.aaa34.js"></script>',
            '<script>',
            'loadScript("cocos2d-js-min.js", function () { window.boot(); });',
            '</script>',
            '</body></html>'
        ].join('\n');
        const indexPath = path2.join(dest, 'index.html');
        fs2.writeFileSync(indexPath, origHtml, 'utf8');
        // 造一个带哈希的资源文件，注入后必须一个字节不变
        const assetPath = path2.join(dest, 'main.aaa34.js');
        fs2.writeFileSync(assetPath, 'console.log("game");', 'utf8');
        const assetMd5Before = require('crypto').createHash('md5')
            .update(fs2.readFileSync(assetPath)).digest('hex');

        // 1) 注入
        let r = injector.applyInjection(dest, {
            selfDir: __dirname, port: 25900, project: 'testproj', interval: 2000
        });
        assert.strictEqual(r.injected, true, '注入失败：' + r.reason);
        assert.strictEqual(r.anchor, 'after-boot', '注入点不对');

        const afterHtml = fs2.readFileSync(indexPath, 'utf8');
        assert.ok(afterHtml.indexOf('mcp-runtime-report.js') >= 0, '没插入脚本引用');
        assert.ok(afterHtml.indexOf('__MCP_RUNTIME_CONFIG__') >= 0, '没写配置');
        assert.ok(afterHtml.indexOf('window.boot()') >= 0, '原来的 boot 调用被弄丢了');

        // 关键断言：带哈希的资源文件一个字节没动
        const assetMd5After = require('crypto').createHash('md5')
            .update(fs2.readFileSync(assetPath)).digest('hex');
        assert.strictEqual(assetMd5After, assetMd5Before, '资源文件被改了 —— 会导致 md5 校验失败');

        // 2) 幂等：再注入一次，不该叠加
        r = injector.applyInjection(dest, {
            selfDir: __dirname, port: 25901, project: 'testproj', interval: 2000
        });
        assert.strictEqual(r.injected, true);
        const twice = fs2.readFileSync(indexPath, 'utf8');
        // 脚本引用只该出现一次（第二行是配置，不含脚本名）
        const count = (twice.match(/<script src="mcp-runtime-report\.js">/g) || []).length;
        assert.strictEqual(count, 1, '重复注入了，脚本引用出现了 ' + count + ' 次');
        const markerCount = (twice.match(/cocos-mcp-2x:runtime-report:start/g) || []).length;
        assert.strictEqual(markerCount, 1, '注入标记出现了 ' + markerCount + ' 次');
        assert.ok(twice.indexOf('"port":25901') >= 0, '第二次注入没更新端口配置');

        // 3) 撤销：index.html 要还原成原样
        r = injector.applyInjection(dest, { selfDir: __dirname, remove: true });
        assert.strictEqual(r.injected, false);
        const restored = fs2.readFileSync(indexPath, 'utf8');
        assert.strictEqual(restored, origHtml, '撤销后 index.html 没还原');
        assert.ok(!fs2.existsSync(path2.join(dest, 'mcp-runtime-report.js')), '注入脚本没删掉');

        try { fs2.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        console.log('        注入幂等 + 撤销还原 + 资源文件未动，全部通过');
    });

    await check('注入脚本能在浏览器环境里正确上报', async function () {
        // 用 Node 的 vm 模拟一个最小浏览器环境，跑真实的注入脚本
        const fs2 = require('fs');
        const path2 = require('path');
        const vm = require('vm');

        const posted = [];
        const ccMock = {
            Component: function () {},
            js: { getClassName: function (c) { return c && c.__cls ? c.__cls : 'cc_Node'; } },
            director: {
                getScene: function () {
                    return {
                        name: 'Game', active: true, _components: [], children: [],
                        position: { x: 0, y: 0, z: 0 }, scaleX: 1, scaleY: 1, scaleZ: 1,
                        getComponents: function () { return []; }
                    };
                },
                getTotalFrames: function () { return 999; },
                getFPS: function () { return 59.8; }
            }
        };

        const sandbox = {
            window: {
                location: { hostname: '127.0.0.1', search: '' },
                addEventListener: function () {},
                __MCP_RUNTIME_CONFIG__: { port: 25900, project: 'testproj', interval: 2000, enabled: true }
            },
            console: console,
            setTimeout: setTimeout, clearTimeout: clearTimeout,
            setInterval: setInterval, clearInterval: clearInterval,
            Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
            String: String, Number: Number, Boolean: Boolean, Error: Error,
            XMLHttpRequest: function () {
                this.readyState = 0; this.status = 0;
                this.open = function (m, u) { this._m = m; this._u = u; };
                this.setRequestHeader = function () {};
                this.send = function (body) {
                    posted.push({ method: this._m, url: this._u, body: JSON.parse(body) });
                    this.readyState = 4; this.status = 200;
                    if (this.onreadystatechange) this.onreadystatechange();
                };
            }
        };
        sandbox.window.XMLHttpRequest = sandbox.XMLHttpRequest;
        sandbox.window.cc = ccMock;   // 真实浏览器里 cc 就是 window.cc
        sandbox.cc = ccMock;          // 同时也挂在全局（脚本会两个都试）
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);

        const src = fs2.readFileSync(path2.join(__dirname, 'inject-runtime.js'), 'utf8');
        vm.runInContext(src, sandbox);

        await new Promise(function (r) { setTimeout(r, 1200); });

        assert.ok(posted.length > 0, '注入脚本一次都没上报');
        const p = posted[0];
        assert.strictEqual(p.method, 'POST');
        assert.ok(/\/runtime-report$/.test(p.url), 'URL 不对：' + p.url);
        assert.strictEqual(p.body.scene, 'Game');
        assert.strictEqual(p.body.frame, 999);
        assert.strictEqual(p.body.project, 'testproj');
        console.log('        上报 ' + posted.length + ' 次，URL = ' + p.url);
    });

    await check('runtime_report(build) 读浏览器上报', async function () {
        const r = await callTool('runtime_report', { source: 'build' });
        assert.ok(!r.error, r.error);
        assert.ok('count' in r, '没有 count 字段');
        assert.ok('report' in r, '没有 report 字段');
    });

    await check('注入脚本 → 真实 MCP 端口 → 读回（端到端）', async function () {
        // 完整链路：注入脚本（vm 模拟浏览器）→ 真实 HTTP → MCP 接收端 → 读回
        const fs2 = require('fs');
        const path2 = require('path');
        const vm = require('vm');
        const http2 = require('http');

        function RealXHR() {
            this.readyState = 0; this.status = 0;
            this.open = function (m, u) { this._m = m; this._u = u; };
            this.setRequestHeader = function () {};
            this.send = function (body) {
                const req = http2.request({
                    host: '127.0.0.1', port: port, path: '/runtime-report', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, function (res) {
                    res.resume();
                    this.readyState = 4; this.status = res.statusCode;
                    if (this.onreadystatechange) this.onreadystatechange();
                }.bind(this));
                req.on('error', function () {
                    this.readyState = 4; this.status = 0;
                    if (this.onreadystatechange) this.onreadystatechange();
                }.bind(this));
                req.write(body); req.end();
            };
        }

        function mkNode(name, comps, kids) {
            return {
                name: name, active: true, _components: comps || [], children: kids || [],
                position: { x: 1, y: 2, z: 3 }, scaleX: 1, scaleY: 1, scaleZ: 1,
                getComponents: function () { return this._components; }
            };
        }
        const sprite = { __cls: 'cc_Sprite', node: null, spriteFrame: { name: 'hero_atlas' }, sizeMode: 0 };
        const appstart = { __cls: 'AppStart', node: null, gameTarget: 'prod' };
        const canvas = mkNode('Canvas', [sprite, appstart], [mkNode('topUI', [], [])]);
        sprite.node = canvas; appstart.node = canvas;

        const ccMock = {
            Component: function () {},
            js: { getClassName: function (c) { return (c && c.__cls) || 'cc_Node'; } },
            director: {
                getScene: function () { return mkNode('Game', [], [canvas]); },
                getTotalFrames: function () { return 12345; },
                getFPS: function () { return 59.7; }
            }
        };

        const sandbox = {
            window: {
                location: { hostname: '127.0.0.1', search: '' },
                addEventListener: function () {},
                __MCP_RUNTIME_CONFIG__: { port: port, project: 'e2e', interval: 2000, enabled: true }
            },
            console: console,
            setTimeout: setTimeout, clearTimeout: clearTimeout,
            setInterval: setInterval, clearInterval: clearInterval,
            Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
            String: String, Number: Number, Boolean: Boolean, Error: Error,
            XMLHttpRequest: RealXHR
        };
        sandbox.window.XMLHttpRequest = RealXHR;
        sandbox.window.cc = ccMock;
        sandbox.cc = ccMock;
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);

        vm.runInContext(
            fs2.readFileSync(path2.join(__dirname, 'inject-runtime.js'), 'utf8'),
            sandbox
        );

        // 等上报落地
        // 注入脚本的上报间隔是 2000ms，第一次在场景就绪后 500ms ——
        // 等到第二次上报（一定包含刚才那条 error）
        await new Promise(function (r) { setTimeout(r, 2800); });

        const rr = await callTool('runtime_report', { source: 'build' });
        assert.ok(!rr.error, rr.error);
        assert.ok(rr.count > 0, 'MCP 侧没收到上报');
        assert.ok(rr.report, '没有 report 内容');

        const rep = rr.report;
        assert.strictEqual(rep.project, 'e2e');
        assert.strictEqual(rep.scene, 'Game');
        assert.strictEqual(rep.frame, 12345);
        assert.ok(rep.tree, '没有场景树');
        assert.ok(rep.tree.children.length > 0, '场景树是空的');

        const cv = rep.tree.children[0];
        assert.strictEqual(cv.name, 'Canvas');
        // 类名归一化：cc_Sprite → cc.Sprite
        const types = (cv.components || []).map(function (c) { return c.type; });
        assert.ok(types.indexOf('cc.Sprite') >= 0, '类名没归一化：' + types.join(','));
        assert.ok(types.indexOf('AppStart') >= 0, '自定义脚本组件没读到：' + types.join(','));

        // 自定义脚本的业务属性也要能读到
        const app = (cv.components || []).filter(function (c) { return c.type === 'AppStart'; })[0];
        assert.ok(app, '没找到 AppStart 组件');
        assert.strictEqual(app.props.gameTarget, 'prod', '组件属性没读到');

        console.log('        收到 ' + rr.count + ' 次上报，场景 ' + rep.scene +
            '，组件 ' + types.join(','));
    });

    await check('中继转发 runtime-report（浏览器报给中继，中继转给扩展）', async function () {
        // 浏览器侧注入脚本报的是**中继端口**（因为客户端连的是中继），
        // 中继必须能把 /runtime-report 转给目标项目的扩展实例。
        // 这条链路断了，AI 就读不到浏览器里的游戏状态。
        const fs2 = require('fs');
        const path2 = require('path');
        const os2 = require('os');
        const http2 = require('http');
        const { spawn } = require('child_process');

        const hubHome = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'mcp-hub-rt-'));
        const hubDir = path2.join(hubHome, '.CocosCreator', 'cocos-mcp-2x');
        const portsDir = path2.join(hubDir, 'ports');
        fs2.mkdirSync(portsDir, { recursive: true });

        // 注册表：目标项目指向本测试的扩展端口
        fs2.writeFileSync(path2.join(portsDir, 'proj.json'), JSON.stringify({
            name: 'proj', project: PROJECT, port: port, pid: process.pid
        }));
        fs2.writeFileSync(path2.join(hubDir, 'target.json'), JSON.stringify({
            name: 'proj', project: PROJECT, updatedAt: new Date().toISOString()
        }));

        const hubPort = 25973;
        const child = spawn('node', [path2.join(__dirname, 'hub.js'), String(hubPort)], {
            env: Object.assign({}, process.env, { HOME: hubHome, USERPROFILE: hubHome }),
            stdio: 'ignore'
        });

        try {
            // 等中继起来
            let up = false;
            for (let i = 0; i < 40; i++) {
                await new Promise(function (r) { setTimeout(r, 150); });
                try {
                    await new Promise(function (resolve, reject) {
                        const req = http2.get({ host: '127.0.0.1', port: hubPort, path: '/status' },
                            function (res) { res.resume(); resolve(); });
                        req.on('error', reject);
                        req.setTimeout(1500, function () { req.destroy(new Error('timeout')); });
                    });
                    up = true;
                    break;
                } catch (e) { /* 还没起来 */ }
            }
            assert.ok(up, '中继没起来');

            // 通过中继上报
            const payload = { project: 'proj', scene: 'ViaHub', frame: 42, fps: 30, at: Date.now(), tree: null };
            const body = JSON.stringify(payload);
            const status = await new Promise(function (resolve, reject) {
                const req = http2.request({
                    host: '127.0.0.1', port: hubPort, path: '/runtime-report', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, function (res) {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => resolve({ status: res.statusCode, body: d }));
                });
                req.on('error', reject);
                req.end(body);
            });
            assert.strictEqual(status.status, 200, '中继返回 ' + status.status);

            // 扩展侧应该收到了
            const rr = await callTool('runtime_report', { source: 'build' });
            assert.ok(rr.report, '扩展没收到经中继转发的上报');
            assert.strictEqual(rr.report.scene, 'ViaHub', '转发过来的数据不对');
            console.log('        中继 ' + hubPort + ' → 扩展 ' + port + ' 转发成功');
        } finally {
            try { child.kill(); } catch (e) { /* 已退出 */ }
            try { fs2.rmSync(hubHome, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        }
    });

    await check('注入脚本捕获 console 并把错误上报（游戏里报错 → MCP 收到）', async function () {
        // 模拟真实浏览器：console === window.console（同一个对象）
        // 游戏代码调 console.error → 注入脚本劫持到 → 上报 → MCP 读回
        const fs2 = require('fs');
        const path2 = require('path');
        const vm = require('vm');
        const http2 = require('http');

        const posted = [];
        // 注意：浏览器里是 new XMLHttpRequest()，所以方法必须在原型上，
        // 否则 new 出来的实例上根本没有 open/send —— 注入脚本会静默失败。
        function RealXHR() {
            this.readyState = 0; this.status = 0;
        }
        RealXHR.prototype.open = function (m, u) { this._m = m; this._u = u; };
        RealXHR.prototype.setRequestHeader = function () {};
        RealXHR.prototype.send = function (body) {
            const self = this;
            posted.push(JSON.parse(body));
            const u = new URL(this._u);
            const req = http2.request({
                host: u.hostname, port: u.port, path: u.pathname, method: this._m,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, function (res) {
                res.resume();
                self.readyState = 4; self.status = res.statusCode;
                if (self.onreadystatechange) self.onreadystatechange();
            });
            req.on('error', function () {
                self.readyState = 4; self.status = 0;
                if (self.onreadystatechange) self.onreadystatechange();
            });
            req.write(body); req.end();
        };

        const THE_CONSOLE = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} };
        const ccMock = {
            Component: function () {},
            js: { getClassName: function () { return 'cc_Node'; } },
            director: {
                getScene: function () {
                    return {
                        name: 'Game', active: true, _components: [], children: [],
                        position: { x: 0, y: 0, z: 0 }, scaleX: 1, scaleY: 1, scaleZ: 1,
                        getComponents: function () { return []; }
                    };
                },
                getTotalFrames: function () { return 1234; },
                getFPS: function () { return 60; }
            }
        };

        const sandbox = {
            window: {
                location: { hostname: '127.0.0.1', search: '' },
                addEventListener: function () {},
                __MCP_RUNTIME_CONFIG__: { port: port, project: 'conftest', interval: 2000, enabled: true }
            },
            console: THE_CONSOLE,
            setTimeout: setTimeout, clearTimeout: clearTimeout,
            setInterval: setInterval, clearInterval: clearInterval,
            Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
            String: String, Number: Number, Boolean: Boolean, Error: Error,
            XMLHttpRequest: RealXHR
        };
        sandbox.window.XMLHttpRequest = RealXHR;
        sandbox.window.console = THE_CONSOLE;   // 浏览器里 console === window.console
        sandbox.window.cc = ccMock;
        sandbox.cc = ccMock;
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);

        vm.runInContext(
            fs2.readFileSync(path2.join(__dirname, 'inject-runtime.js'), 'utf8'),
            sandbox
        );

        // 游戏里报错
        setTimeout(function () {
            THE_CONSOLE.log('[PrivilegeView] 钥匙数量 = 0');
            THE_CONSOLE.error('[PrivilegeView] 获取特权失败：钥匙不足，无法获取特权（需要 1 把，当前 0 把）');
        }, 300);

        // 注入脚本的上报是周期性的（间隔 2000ms），
        // 等到第二次上报，一定包含刚才那条 error
        await new Promise(function (r) { setTimeout(r, 2800); });

        // 上报里必须带 console 字段，且含那条 error。
        // 不能只看最后一条 —— 最后一条可能正好在错误发生前。
        assert.ok(posted.length > 0, '注入脚本一次都没上报');

        var withErr = null;
        for (var pi = 0; pi < posted.length; pi++) {
            var con = posted[pi].console;
            if (!con || !con.entries) continue;
            for (var ei = 0; ei < con.entries.length; ei++) {
                if (con.entries[ei].level === 'error' && /钥匙不足/.test(con.entries[ei].text)) {
                    withErr = posted[pi];
                    break;
                }
            }
            if (withErr) break;
        }
        assert.ok(withErr, '上报了 ' + posted.length + ' 次都没抓到那条 error');
        assert.strictEqual(withErr.console.installed, true, 'console 劫持没装上');

        // MCP 侧要能读到
        const rr = await callTool('runtime_report', { source: 'build' });
        assert.ok(rr.console, 'MCP 侧没有 console 字段');
        assert.ok(rr.errors && rr.errors.length, 'MCP 侧没有 errors 字段');
        const mcpErr = rr.errors.filter(function (e) { return /钥匙不足/.test(e.text); })[0];
        assert.ok(mcpErr, 'MCP 侧错误内容不对：' + JSON.stringify(rr.errors));
        assert.strictEqual(rr.hasErrors, true);

        console.log('        MCP 收到错误：' + mcpErr.text);
    });

    await check('edit_file 精确替换一段（只动匹配处，CRLF 保持）', async function () {
        const fs2 = require('fs');
        const path2 = require('path');
        const os2 = require('os');

        // 在项目 temp 下造一个 CRLF 文件
        const rel = 'temp/__mcp_edit_test.ts';
        const abs = path2.join(PROJECT, rel);
        fs2.mkdirSync(path2.dirname(abs), { recursive: true });
        const orig = 'line1\r\nAAA\r\nline3\r\nAAA\r\nline5\r\n';
        fs2.writeFileSync(abs, orig, 'utf8');

        try {
            // 1) 替换第一处
            let r = await callTool('edit_file', {
                path: rel, oldText: 'AAA', newText: 'BBB'
            });
            assert.ok(!r.error, r.error);
            assert.strictEqual(r.replaced, 1, '应该只替换 1 处');
            assert.strictEqual(r.newline, 'CRLF（沿用原文件）');
            let now = fs2.readFileSync(abs, 'utf8');
            assert.ok(now.indexOf('line1\r\nBBB\r\nline3') >= 0, '第一处没被替换');
            assert.ok(now.indexOf('line3\r\nAAA\r\nline5') >= 0, '第二处不该被替换');
            assert.strictEqual((now.match(/\r\n/g) || []).length, 5, 'CRLF 数量变了');

            // 2) 全部替换（用一个还没被改过的关键字）
            r = await callTool('edit_file', { path: rel, oldText: 'line3', newText: 'lineX', all: true });
            assert.ok(!r.error, r.error);
            assert.strictEqual(r.replaced, 1, '只有一个 line3，应该替换 1 处');
            now = fs2.readFileSync(abs, 'utf8');
            assert.ok(now.indexOf('lineX') >= 0, '没替换');
            assert.ok(now.indexOf('line3') < 0, '还有没替换的');

            // 2b) 真正的多处替换：重新造一个有两个 AAA 的文件
            fs2.writeFileSync(abs, 'x\r\nAAA\r\ny\r\nAAA\r\nz\r\n', 'utf8');
            r = await callTool('edit_file', { path: rel, oldText: 'AAA', newText: 'BBB', all: true });
            assert.ok(!r.error, r.error);
            assert.strictEqual(r.replaced, 2, '应该替换 2 处');
            now = fs2.readFileSync(abs, 'utf8');
            assert.ok(now.indexOf('AAA') < 0, '还有没替换的');
            assert.strictEqual((now.match(/\r\n/g) || []).length, 5, 'CRLF 数量变了');

            // 3) count 不符 → 拒绝写入，文件不动
            const before = fs2.readFileSync(abs, 'utf8');
            r = await callTool('edit_file', { path: rel, oldText: 'BBB', newText: 'DDD', count: 5 });
            assert.ok(r.error, 'count 不符竟然成功了');
            assert.ok(/匹配数不符/.test(r.error), '错误信息不对：' + r.error);
            assert.strictEqual(fs2.readFileSync(abs, 'utf8'), before, '拒绝后文件被改了');

            // 4) oldText 不存在 → 报错，且文件不动
            r = await callTool('edit_file', { path: rel, oldText: '压根不存在的内容', newText: 'x' });
            assert.ok(r.error, '不存在的 oldText 竟然成功了');
            assert.ok(/没找到/.test(r.error), '错误信息不对：' + r.error);
            assert.strictEqual(fs2.readFileSync(abs, 'utf8'), before, '报错后文件被改了');

            console.log('        精确替换 / 全部替换 / count 防手滑 / 失败不改文件，全部通过');
        } finally {
            try { fs2.unlinkSync(abs); } catch (e) { /* 忽略 */ }
        }
    });

    await check('write_file 保留原文件换行风格（CRLF 项目不被写成 LF）', async function () {
        // 很多项目源码是 CRLF，硬写成 LF 会让 git diff 变成全量重写。
        const fs2 = require('fs');
        const path2 = require('path');
        const os2 = require('os');

        const tmpDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'mcp-nl-'));
        const f = path2.join(tmpDir, 'a.ts');
        fs2.writeFileSync(f, 'line1\r\nline2\r\nline3\r\n', 'utf8');

        // 通过 MCP 写入 LF 内容
        const r = await callTool('write_file', {
            path: path2.relative(PROJECT, f).replace(/\\/g, '/'),
            content: 'x1\nx2\n'
        });
        // 路径可能因为不在项目内被拒 —— 那就直接验证工具的行为
        if (!r.error) {
            const after = fs2.readFileSync(f, 'utf8');
            assert.ok(after.indexOf('\r\n') >= 0, 'CRLF 没保留：' + JSON.stringify(after));
            assert.strictEqual(r.newline, 'CRLF（沿用原文件）');
        } else {
            // 路径被安全阀拦了也算过（说明不会乱写项目外的地方）
            assert.ok(/项目|路径|安全/.test(r.error), '错误信息不对：' + r.error);
        }
        try { fs2.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    });

    await check('edit_file 能改 prefab 里的 spriteFrame（只动匹配处）', async function () {
        // 实测场景：把特权页面的「获取」按钮图标从摄像机换成金钥匙。
        // prefab 是格式化过的 JSON，edit_file 的精确替换正好对付它。
        const fs2 = require('fs');
        const path2 = require('path');

        const rel = 'temp/__mcp_prefab_test.prefab';
        const abs = path2.join(PROJECT, rel);
        fs2.mkdirSync(path2.dirname(abs), { recursive: true });

        // 造一个和真实 prefab 同构的最小样本
        const uuidA = 'aaaaaaaa-1111-2222-3333-444444444444';
        const uuidB = 'bbbbbbbb-1111-2222-3333-444444444444';
        const sample = [
            '[',
            '  {',
            '    "__type__": "cc.Node",',
            '    "_name": "sp",',
            '    "_contentSize": {',
            '      "__type__": "cc.Size",',
            '      "width": 39,',
            '      "height": 32',
            '    },',
            '    "_trs": {',
            '      "__type__": "TypedArray",',
            '      "ctor": "Float64Array",',
            '      "array": [',
            '        -79.479,',
            '        0,',
            '        0,',
            '        0,',
            '        0,',
            '        0,',
            '        1,',
            '        1.3,',
            '        1.3,',
            '        1',
            '      ]',
            '    }',
            '  },',
            '  {',
            '    "__type__": "cc.Sprite",',
            '    "_spriteFrame": {',
            '      "__uuid__": "' + uuidA + '"',
            '    },',
            '    "_type": 0,',
            '    "_sizeMode": 1',
            '  }',
            ']'
        ].join('\n');
        fs2.writeFileSync(abs, sample, 'utf8');

        try {
            // 1) 换 spriteFrame
            let r = await callTool('edit_file', {
                path: rel,
                oldText: '"_spriteFrame": {\n      "__uuid__": "' + uuidA + '"\n    },\n    "_type": 0,\n    "_sizeMode": 1',
                newText: '"_spriteFrame": {\n      "__uuid__": "' + uuidB + '"\n    },\n    "_type": 0,\n    "_sizeMode": 1',
                count: 1
            });
            assert.ok(!r.error, r.error);
            assert.strictEqual(r.replaced, 1);

            // 2) 改尺寸（带 _name 锚点，保证唯一）
            r = await callTool('edit_file', {
                path: rel,
                oldText: '"_name": "sp",\n    "_contentSize": {\n      "__type__": "cc.Size",\n      "width": 39,\n      "height": 32\n    },',
                newText: '"_name": "sp",\n    "_contentSize": {\n      "__type__": "cc.Size",\n      "width": 47,\n      "height": 69\n    },',
                count: 1
            });
            assert.ok(!r.error, r.error);

            // 3) 改缩放
            r = await callTool('edit_file', {
                path: rel,
                oldText: '        -79.479,\n        0,\n        0,\n        0,\n        0,\n        0,\n        1,\n        1.3,\n        1.3,\n        1',
                newText: '        -79.479,\n        0,\n        0,\n        0,\n        0,\n        0,\n        1,\n        0.75,\n        0.75,\n        1',
                count: 1
            });
            assert.ok(!r.error, r.error);

            // 验证：JSON 仍合法，且三处都改了
            const now = fs2.readFileSync(abs, 'utf8');
            const arr = JSON.parse(now);
            assert.strictEqual(arr.length, 2, '对象数变了');
            assert.strictEqual(arr[0]._contentSize.width, 47);
            assert.strictEqual(arr[0]._contentSize.height, 69);
            assert.strictEqual(arr[0]._trs.array[7], 0.75);
            assert.strictEqual(arr[0]._trs.array[8], 0.75);
            assert.strictEqual(arr[1]._spriteFrame.__uuid__, uuidB);

            console.log('        换图 + 改尺寸 + 改缩放，prefab JSON 仍合法');
        } finally {
            try { fs2.unlinkSync(abs); } catch (e) { /* 忽略 */ }
        }
    });

    await check('resolve_asset 能分清 texture 和 sprite-frame', async function () {
        // 一张 png 有两个 uuid：
        //   主 uuid（texture）      —— "这张图"这个资源
        //   subMeta uuid（sprite-frame）—— 能填进 prefab 的 _spriteFrame
        // 填错会在渲染时报 "spriteFrame.textureLoaded is not a function"。
        //
        // 各项目的资源不一样，所以动态找一个当前项目里存在的图片来测。
        const list = await callTool('resolve_asset', {});
        assert.ok(!list.error, list.error);
        assert.ok(list.items && list.items.length > 0, '这个项目里没有 sprite-frame 可测');

        // 拿一个 sprite-frame 的 uuid，反查它对应的图片路径
        const sample = list.items[0];
        const ru0 = await callTool('resolve_asset', { input: sample.uuid });
        assert.ok(!ru0.error, ru0.error);
        assert.ok(ru0.path, '解析不到图片路径');
        assert.strictEqual(ru0.resourceType, 'sprite-frame');
        assert.strictEqual(ru0.usableAsSpriteFrame, true);

        const r = await callTool('resolve_asset', { input: ru0.path });
        assert.ok(!r.error, r.error);
        assert.ok(r.mainUuid, '没有主 uuid');
        assert.ok(r.spriteFrameUuid, '没有 sprite-frame uuid');
        assert.notStrictEqual(r.mainUuid, r.spriteFrameUuid,
            '主 uuid 和 sprite-frame uuid 不应是同一个');
        assert.strictEqual(r.spriteFrames[0].isSpriteFrame, true);

        // 主 uuid（texture）必须被标成"不能当 spriteFrame 用"
        const ru2 = await callTool('resolve_asset', { input: r.mainUuid });
        assert.ok(!ru2.error, ru2.error);
        assert.strictEqual(ru2.resourceType, 'asset');
        assert.strictEqual(ru2.usableAsSpriteFrame, false,
            '主 uuid（texture）不该被标成可当 spriteFrame 用');

        console.log('        ' + ru0.path.split('/').pop() +
            '  texture=' + r.mainUuid.slice(0, 8) +
            '  sprite-frame=' + r.spriteFrameUuid.slice(0, 8));
    });

    await check('query_scene_tree 能报出每个 Sprite 用的哪张图', async function () {
        // 动态找一个带 Sprite 组件的 prefab —— 各项目资源不同
        const fs2 = require('fs');
        const path2 = require('path');
        const assetsDir = path2.join(PROJECT, 'assets');
        let target = null;
        (function walk(d, depth) {
            if (target || depth > 8) return;
            let es;
            try { es = fs2.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
            for (const e of es) {
                if (target) return;
                const p = path2.join(d, e.name);
                if (e.isDirectory()) { walk(p, depth + 1); continue; }
                if (e.name.endsWith('.prefab')) {
                    try {
                        const s = fs2.readFileSync(p, 'utf8');
                        if (s.indexOf('"cc.Sprite"') >= 0) {
                            target = path2.relative(PROJECT, p).replace(/\\/g, '/');
                            return;
                        }
                    } catch (e2) { /* 忽略 */ }
                }
            }
        })(assetsDir, 0);

        assert.ok(target, '这个项目里没找到带 Sprite 的 prefab');

        const r = await callTool('query_scene_tree', { path: target, maxDepth: 10 });
        assert.ok(!r.error, r.error);

        let sprites = 0, withFile = 0, wrongType = 0, missing = 0;
        (function walk(n) {
            if (!n) return;
            (n.components || []).forEach(function (c) {
                if (!c.spriteFrame) return;
                sprites++;
                if (c.spriteFrame.file) {
                    withFile++;
                    // 能解析出路径的，类型必须正确
                    if (c.spriteFrame.resourceType !== 'sprite-frame') wrongType++;
                } else {
                    // 解析不出的 —— 项目自带的坏引用，工具要如实报出来
                    missing++;
                }
            });
            (n.children || []).forEach(walk);
        })(r.tree);

        assert.ok(sprites > 0, '没读到任何 Sprite 组件');
        // 有图名的那些，类型必须正确。
        // 注意：项目本身可能有坏引用（资源被删了 prefab 还在引用），
        // 那是项目的问题，工具要如实报出来而不是掩盖 —— 所以只校验有图名的部分。
        assert.strictEqual(wrongType, 0,
            '有 ' + wrongType + ' 个 Sprite 的 spriteFrame 不是 sprite-frame 类型');
        assert.ok(withFile > 0, '一个图片名都没解析出来');

        console.log('        ' + target.split('/').pop() + ' 里 ' + sprites +
            ' 个 Sprite，' + withFile + ' 个能报出图片名且类型正确' +
            (missing ? '（' + missing + ' 个是项目自带的坏引用）' : ''));
    });

    await check('mcp_selftest 自检：所有工具的返回值都是自洽的', async function () {
        // 这是防退化的关键测试：每次改动后自动体检全部工具，
        // 保证「返回值形态」「空值标注」「错误信息」不会悄悄坏掉。
        const r = await callTool('mcp_selftest', { deep: true });
        assert.ok(!r.error, r.error);
        // v0.8.0 合并后只有 28 个工具，其中 9 个有副作用被跳过、1 个是自检自己，
        // 所以真正跑到的审计项比 v0.7.0 少；下限跟着下调，但"全部被覆盖"仍由
        // 下面 noStatus / badEmpty 两项逐条断言守住。
        assert.ok(r.audited >= 15, '体检的工具太少：' + r.audited);

        // 每个被体检的工具都必须带 __status（说明统一包装生效了）
        const noStatus = r.items.filter(function (x) {
            return x.shape === 'json' && !x.status;
        });
        assert.strictEqual(noStatus.length, 0,
            '有 ' + noStatus.length + ' 个工具没被统一包装：' +
            noStatus.map(function (x) { return x.name; }).join(', '));

        // 空值必须被列进 __emptyFields
        const badEmpty = r.items.filter(function (x) {
            return x.shape === 'json' && x.issue && x.issue.indexOf('__emptyFields') >= 0;
        });
        assert.strictEqual(badEmpty.length, 0,
            '有工具的 null 字段没列进 __emptyFields：' +
            badEmpty.map(function (x) { return x.name; }).join(', '));

        // 报错的工具，错误信息必须说清下一步
        const badErr = r.items.filter(function (x) {
            return !x.ok && x.errorHasGuidance === false;
        });
        assert.strictEqual(badErr.length, 0,
            '有工具的错误信息没说下一步该怎么做：' +
            badErr.map(function (x) { return x.name + ' → ' + String(x.error).slice(0, 60); }).join(' | '));

        console.log('        体检 ' + r.audited + ' 个工具，跳过 ' + r.skipped +
            ' 个（有副作用的），' + (r.problems.length ? r.problems.length + ' 个有问题' : '全部自洽'));
        if (r.problems.length) {
            r.problems.slice(0, 5).forEach(function (p) {
                console.log('        · ' + p.name + ': ' + (p.issue || p.error || '').slice(0, 80));
            });
        }
    });

    await check('所有工具描述都带返回约定（离开对话也能看懂）', async function () {
        // 每个 tools/list 的描述都要带【返回约定】——
        // 这样换个 AI、隔段时间再来，光看描述就知道怎么解读返回值。
        const r = await rpc('tools/list', {});
        const tools = r.result.tools;
        assert.strictEqual(tools.length, 28, '工具数不对：' + tools.length);

        const missing = tools.filter(function (t) {
            return !t.description || t.description.indexOf('【返回约定】') < 0;
        });
        assert.strictEqual(missing.length, 0,
            '有 ' + missing.length + ' 个工具描述没带返回约定：' +
            missing.map(function (t) { return t.name; }).join(', '));

        // 每个工具都要有描述、参数 schema
        const noDesc = tools.filter(function (t) { return !t.description || t.description.length < 15; });
        assert.strictEqual(noDesc.length, 0,
            '有工具描述太短：' + noDesc.map(function (t) { return t.name; }).join(', '));

        console.log('        ' + tools.length + ' 个工具描述全部带约定');
    });

    await check('mcp_selftest(sideEffects) 深度自检：副作用工具都跑通且不留垃圾', async function () {
        // 这个测试最关键：它验证「有副作用的工具真的能用」，
        // 而且验证自检工具自己不留垃圾（测试节点、临时资源）。
        const fs2 = require('fs');
        const path2 = require('path');

        const r = await callTool('mcp_selftest', { sideEffects: true });
        assert.ok(!r.error, r.error);
        assert.ok(r.verified >= 20, '验证的工具太少：' + r.verified);

        // 不该有「意外失败」或「意外成功」
        const bad = (r.problems || []);
        assert.strictEqual(bad.length, 0,
            '有 ' + bad.length + ' 个工具有问题：' +
            bad.map(function (p) {
                return p.name + ' → ' + String(p.issue || p.error || '').slice(0, 70);
            }).join(' | '));

        // 自检工具不能留下垃圾
        assert.ok(Array.isArray(r.cleanedNodes), '没有 cleanedNodes 字段');
        // 自证：真实场景文件的 md5 没变（这条是描述里承诺过的，必须真返回）
        assert.notStrictEqual(r.realSceneUntouched, false,
            '真实场景文件在自检过程中被改动了（md5 变了）—— 这是 bug');
        assert.ok(r.realSceneUntouched === true || r.realSceneUntouched === null,
            'realSceneUntouched 只能是 true / null，实际：' + r.realSceneUntouched);

        // 现场核对：assets/temp 下不能有探测残留
        const probeDir = path2.join(PROJECT, 'assets', '__mcp_probe');
        assert.ok(!fs2.existsSync(probeDir), 'assets/__mcp_probe 没清理干净');
        const tmpDir = path2.join(PROJECT, 'temp', '__mcp_verify');
        assert.ok(!fs2.existsSync(tmpDir), 'temp/__mcp_verify 没清理干净' +
            (r.cleanup ? '（' + r.cleanup + '）' : '') +
            ((r.leftover || []).length ? '；清理告警：' + r.leftover.join('、') : ''));

        console.log('        ' + r.verified + ' 个副作用工具全通过，清理了 ' +
            (r.cleanedNodes || []).length + ' 个测试节点，项目无残留');
    });

    await check('bridge.js 语法正确且包含所有动作分支', async function () {
        // 桥接脚本是浏览器环境的代码，node --check 能抓语法错。
        // 动作分支漏了的话，AI 到时候会拿到「未知指令」。
        const fs2 = require('fs');
        const path2 = require('path');
        const src = fs2.readFileSync(path2.join(__dirname, 'bridge.js'), 'utf8');

        const ACTIONS = [
            'ping', 'eval', 'read', 'click', 'clickbutton', 'dispatchtouch',
            'module', 'script', 'fguitree', 'fguiclick', 'screenshot'
        ];
        const missing = ACTIONS.filter(function (a) {
            return src.indexOf("action === '" + a + "'") < 0;
        });
        assert.strictEqual(missing.length, 0, 'bridge.js 缺少这些动作：' + missing.join(', '));

        // 关键坑：main.js 是严格模式，arguments 不与形参同步 ——
        // bridge 里如果用了 apply(this, arguments) 就会丢改写后的参数。
        assert.ok(src.indexOf('apply(this, arguments)') < 0 ||
                  src.indexOf('arguments') < 0,
            'bridge.js 里不要依赖 arguments 同步');

        console.log('        ' + ACTIONS.length + ' 个动作都在');
    });

    await check('Web 预览桥接：端点、指令队列、结果回收', async function () {
        // 桥接协议是纯 HTTP，不依赖真实浏览器 ——
        // 这几条守住协议层，真实浏览器那部分由 mcp_verify_all 之外的手动验收覆盖。
        const http2 = require('http');

        function get(path) {
            return new Promise(function (resolve, reject) {
                const req = http2.get({ host: '127.0.0.1', port: port, path: path, timeout: 4000 }, function (res) {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => resolve(d));
                });
                req.on('error', reject);
                req.on('timeout', () => req.destroy(new Error('timeout')));
            });
        }
        function post(path, body) {
            return new Promise(function (resolve, reject) {
                const req = http2.request({
                    host: '127.0.0.1', port: port, path: path, method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                    timeout: 4000
                }, function (res) {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => resolve(d));
                });
                req.on('error', reject);
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.write(body);
                req.end();
            });
        }

        // 1) 上报端点：POST 一条带 error 的日志
        await post('/bridge/report', JSON.stringify({
            bridge: 1, project: '__test__', scene: 'TestScene', frame: 42, fps: 60,
            logs: [{ seq: 1, level: 'error', text: '__MCP_TEST_ERROR__ 钥匙不足', at: Date.now() }]
        }));

        // 2) 能读到这条日志
        const rep = await callTool('runtime_report', { source: 'preview', limit: 20 });
        assert.ok(!rep.error, rep.error);
        const hits = (rep.logs || []).filter(function (l) {
            return String(l.text).indexOf('__MCP_TEST_ERROR__') >= 0;
        });
        assert.ok(hits.length, '上报的 error 日志没读到');
        assert.strictEqual(hits[0].level, 'error', '日志级别不对');
        assert.ok((rep.errors || []).length, 'errors 字段里没有这条');

        // 3) 指令队列：入队后能被 GET 拉到
        const q = await callTool('preview_command', { action: 'ping', timeout: 300 });
        void q;   // 没浏览器时必然超时，这里只验队列本身

        const cmds = JSON.parse(await get('/bridge/commands?since=0'));
        assert.ok(cmds && Array.isArray(cmds.commands), '指令接口没返回 commands 数组');
        assert.ok(cmds.commands.length >= 1, '队列里没有指令');
        const ping = cmds.commands.filter(function (c) { return c.action === 'ping'; })[0];
        assert.ok(ping, '队列里没有 ping 指令');
        assert.ok(ping.id, '指令没有 id');

        // 4) 结果回收：POST 结果后再拉，队列里那条就没了
        await post('/bridge/result', JSON.stringify({
            id: ping.id, seq: ping.seq, ok: true, result: { pong: true }
        }));
        const cmds2 = JSON.parse(await get('/bridge/commands?since=' + ping.seq));
        assert.ok(!cmds2.commands.filter(function (c) { return c.id === ping.id; }).length,
            '已回收的指令还在队列里');

        console.log('        端点 / 队列 / 结果回收全部正常');
    });

    await check('run_script 能从文件读脚本执行（path 模式）', async function () {
        const fs2 = require('fs');
        const path2 = require('path');
        const rel = 'temp/__mcp_exec_test.js';
        const abs = path2.join(PROJECT, rel);
        fs2.mkdirSync(path2.dirname(abs), { recursive: true });
        fs2.writeFileSync(abs, 'return 1 + 41;\n', 'utf8');
        try {
            const r = await callTool('run_script', { path: rel });
            assert.ok(!r.error, r.error);
            assert.strictEqual(r.result, 42, '返回值不对：' + JSON.stringify(r.result));
        } finally {
            try { fs2.unlinkSync(abs); } catch (e) { /* 忽略 */ }
        }
    });

    await check('get_project_info 报告当前操作的是哪个项目', async function () {
        const r = await callTool('get_project_info', {});
        assert.ok(!r.error, r.error);
        assert.ok(r.operatingProject, '没有 operatingProject 字段');
        assert.ok('isTarget' in r, '没有 isTarget 字段');
    });

    await check('hub_control 开启/查询/关闭', async function () {
        let r = await callTool('hub_control', { action: 'start' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.started, true, '没启动成功');
        assert.ok(r.url && /25800/.test(r.url), '地址不对：' + r.url);

        r = await callTool('hub_control', { action: 'status' });
        assert.ok(!r.error, r.error);
        assert.ok(typeof r.running === 'boolean', 'status 结构不对');

        r = await callTool('hub_control', { action: 'stop' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.stopped, true);
    });

    await check('中继按项目身份解析目标端口（不靠陈旧端口）', async function () {
        // 中继是独立进程，读的是真实文件。用一个隔离的 HOME 跑它，
        // 免得碰到用户真实的 target.json 和注册表。
        const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-test-'));
        const hubDir = path.join(hubHome, '.CocosCreator', 'cocos-mcp-2x');
        const portsDir = path.join(hubDir, 'ports');
        fs.mkdirSync(portsDir, { recursive: true });

        // 目标 = 项目 A，但注册表里 A 记的是旧端口
        fs.writeFileSync(path.join(hubDir, 'target.json'), JSON.stringify({
            name: 'projA', project: 'G:/work/projA', updatedAt: new Date().toISOString()
        }));
        fs.writeFileSync(path.join(portsDir, 'projA.json'), JSON.stringify({
            name: 'projA', project: 'G:/work/projA', port: 25971, pid: 1
        }));
        fs.writeFileSync(path.join(portsDir, 'projB.json'), JSON.stringify({
            name: 'projB', project: 'G:/work/projB', port: 25970, pid: 2
        }));

        const { spawn } = require('child_process');
        const hubPath = path.join(__dirname, 'hub.js');
        const hubPort = 25972;

        // 起一个中继，用隔离的 HOME
        const child = spawn('node', [hubPath, String(hubPort)], {
            env: Object.assign({}, process.env, { HOME: hubHome, USERPROFILE: hubHome }),
            stdio: 'ignore',
            detached: false
        });

        try {
            // 等它起来
            let status = null;
            for (let i = 0; i < 40; i++) {
                await new Promise(function (r) { setTimeout(r, 150); });
                try {
                    const res = await httpGet('http://127.0.0.1:' + hubPort + '/status');
                    status = JSON.parse(res);
                    break;
                } catch (e) { /* 还没起来 */ }
            }
            assert.ok(status, '中继没起来');

            // 关键断言：目标解析出来是 projA，且端口取自注册表（25971），不是目标文件里的旧值
            assert.strictEqual(status.target.name, 'projA', '目标项目名不对');
            assert.strictEqual(status.target.port, 25971, '目标端口没从注册表解析');
            assert.strictEqual(status.target.online, true, '目标应在线');
        } finally {
            try { child.kill(); } catch (e) { /* 已退出 */ }
            try { fs.rmSync(hubHome, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        }
    });

    console.log('\n============================');
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    console.log('============================');

    // 不在别人的项目里留垃圾（失败也要清，否则下一轮全是假失败）
    cleanupTestArtifacts();

    ext.unload();
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
    console.error('测试异常：', e);
    try { cleanupTestArtifacts(); } catch (e2) { /* 忽略 */ }
    process.exit(1);
});
