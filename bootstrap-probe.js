'use strict';

/**
 * 冷启动探针：在**完全空的临时 Cocos 2.4 项目**上验证 scene_create 能从 0 建工程。
 *
 * 与 test.js 的区别：test.js 需要一个已有素材的项目；本脚本自己造一个
 * assets/ 为空的项目，专门覆盖「一个 .fire 都没有」的分支，跑完即删，
 * 不碰真实项目、不写端口注册表。
 *
 * 用法：node bootstrap-probe.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PROJECT = path.join(os.tmpdir(), 'mcp-bootstrap-probe-' + Date.now());
fs.mkdirSync(path.join(PROJECT, 'assets', 'scene'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, 'settings'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, 'project.json'),
    JSON.stringify({ engine: 'cocos-creator-js', name: 'probe', version: '2.4.15' }));
fs.writeFileSync(path.join(PROJECT, 'settings', 'project.json'), '{}');

process.env.COCOS_MCP_NO_REGISTRY = '1';

let port = 25900;
const profile = { data: {}, saved: false };

function grab(s) {
    const m = String(s).match(/127\.0\.0\.1:(\d+)/);
    if (m) port = parseInt(m[1], 10);
}

global.Editor = {
    Project: { path: PROJECT },
    log: function () { grab(Array.prototype.join.call(arguments, ' ')); },
    success: function () { grab(Array.prototype.join.call(arguments, ' ')); },
    warn: function () { grab(Array.prototype.join.call(arguments, ' ')); },
    error: function () { grab(Array.prototype.join.call(arguments, ' ')); },
    assetdb: {
        refresh: function () { /* 同步降级分支 */ },
        assetBackupPath: path.join(os.tmpdir(), 'mcp-asset-backup'),
        queryAssets: function (pattern, filter, cb) { setTimeout(function () { cb(null, []); }, 0); },
        move: function (f, t, cb) { if (cb) cb(null, []); },
        delete: function (u, cb) { if (cb) cb(null, []); }
    },
    Profile: {
        load: function () {
            return {
                getSelfData: function () { return profile.data; },
                set: function (k, v) { profile.data[k] = v; },
                save: function () { profile.saved = true; }
            };
        }
    },
    Ipc: { sendToPanel: function () { }, sendToMain: function () { } },
    PreviewServer: { _previewPort: 7457, start: function (o, cb) { if (cb) cb(); }, stop: function () { } },
    Builder: { simpleBuildTargets: {} },
    sceneScripts: {},
    Package: { paths: [] }
};

const ext = require('./main.js');
ext.load();

function rpc(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params });
        const req = http.request({
            host: '127.0.0.1', port: port, path: '/mcp', method: 'POST',
            agent: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Connection': 'close'
            },
            timeout: timeoutMs || 8000
        }, function (res) {
            let d = '';
            res.on('data', function (c) { d += c; });
            res.on('end', function () {
                try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); }
            });
        });
        req.on('timeout', function () { req.destroy(new Error('请求超时')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function call(name, args) {
    const r = await rpc('tools/call', { name: name, arguments: args || {} });
    if (!r.result) throw new Error('无 result：' + JSON.stringify(r).slice(0, 300));
    const text = r.result.content[0].text;
    if (r.result.isError) return { error: text };
    try { return JSON.parse(text); } catch (e) { return text; }
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log('  PASS  ' + name); }
    catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
    await sleep(300);
    console.log('临时空项目：' + PROJECT);
    console.log('MCP 端口：' + port + '\n');

    await check('空项目里 scenes 为空（确认确实从 0 开始）', async function () {
        const r = await call('get_project_info', {});
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.scenes.length, 0, 'scenes 应为空');
    });

    let createdRel = 'assets/scene/Main.fire';
    await check('scene_create 在无模板项目里能建出标准场景', async function () {
        const r = await call('scene_create', { path: createdRel, canvas: [750, 1334] });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.template, 'builtin://empty-scene', '应走内置模板');
        assert.strictEqual(r.objects, 7, '应为 SceneAsset+Scene+Canvas 一套共 7 对象');
        assert.strictEqual(r.startSceneSet, true, '应自动写 start-scene');
        assert.ok(profile.data['start-scene'], 'project settings 里应有 start-scene');
        assert.strictEqual(profile.data['design-resolution-width'], 750);
        const abs = path.join(PROJECT, createdRel);
        assert.ok(fs.existsSync(abs), '.fire 未落盘');
        assert.ok(fs.existsSync(abs + '.meta'), '.meta 未落盘');
        assert.strictEqual(readJson(abs + '.meta').uuid, r.uuid, '返回 uuid 应与 .meta 一致');
    });

    await check('新场景可被 query_scene_tree 解析且含 Canvas / Main Camera', async function () {
        const t = await call('query_scene_tree', { path: createdRel });
        assert.ok(!t.error, t.error);
        assert.strictEqual(t.tree.type, 'cc.Scene');
        assert.strictEqual(t.tree.children.length, 1, '应有 1 个 Canvas 子节点');
        assert.strictEqual(t.tree.children[0].name, 'Canvas');
        assert.ok(t.tree.children[0].children.some(function (c) { return c.name === 'Main Camera'; }),
            'Canvas 下应有 Main Camera');
        const comps = t.tree.children[0].components.map(function (c) { return c.type; });
        assert.ok(comps.indexOf('cc.Canvas') >= 0, '缺 cc.Canvas');
        assert.ok(comps.indexOf('cc.Widget') >= 0, '缺 cc.Widget');
    });

    await check('prefab create 的自引用 uuid 与 .meta 一致（A 类修复）', async function () {
        const rel = 'assets/resources/prefab/Probe.prefab';
        const r = await call('prefab', {
            cmd: 'create', from: 'spec', path: rel,
            root: { name: 'Probe', size: [200, 60], children: [{ name: 'Label', size: [180, 50], label: '' }] }
        });
        assert.ok(!r.error, r.error);
        const metaUuid = readJson(path.join(PROJECT, rel + '.meta')).uuid;
        const arr = readJson(path.join(PROJECT, rel));
        const infos = arr.filter(function (o) { return o && o.__type__ === 'cc.PrefabInfo'; });
        assert.ok(infos.length > 0, '没有 PrefabInfo');
        infos.forEach(function (o) {
            assert.strictEqual(o.asset.__uuid__, metaUuid, 'PrefabInfo.asset 与 .meta.uuid 不一致');
        });
    });

    await check('refresh_assets 多 paths 不再把 db://assets 削成 db://（C 类修复）', async function () {
        const r = await call('refresh_assets', { paths: ['db://assets', 'db://assets/scene'] });
        assert.ok(!r.error, r.error);
        assert.ok(r.done, 'done 应为 true');
        assert.ok(r.refreshed.indexOf('db://assets/') >= 0, 'db://assets 应被刷到：' + JSON.stringify(r.refreshed));
        assert.ok(r.refreshed.indexOf('db://assets/scene/') >= 0, '子目录应被刷到');
    });

    await check('project_doctor 在新建资源上报 0 问题', async function () {
        const r = await call('project_doctor', {});
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.problemCount, 0, JSON.stringify(r.problems).slice(0, 400));
    });

    await check('compile-status 显式声明 diagnostics 不可用（B 类修复）', async function () {
        const r = await call('editor', { cmd: 'compile-status' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.diagnosticsAvailable, false);
        assert.ok(/不代表编译无错误/.test(r.conclusion || ''), '缺少结论提示');
    });

    await check('preview report 带 noiseFiltered 字段（B 类修复）', async function () {
        const r = await call('runtime', { cmd: 'report', source: 'preview' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(typeof r.noiseFiltered, 'number');
    });

    console.log('\n============================');
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    console.log('============================');

    try { ext.unload(); } catch (e) { }
    try { fs.rmSync(PROJECT, { recursive: true, force: true }); } catch (e) { }
    process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
    console.error('探针异常：' + (e && e.stack || e));
    try { ext.unload(); } catch (x) { }
    try { fs.rmSync(PROJECT, { recursive: true, force: true }); } catch (x) { }
    process.exit(1);
});
