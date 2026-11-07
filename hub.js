'use strict';

/**
 * hub.js —— cocos-mcp-2x 的常驻中继
 *
 * 为什么需要它：
 * 多个 Cocos 编辑器同时开着时，每个编辑器各跑一个扩展实例、各占一个端口。
 * 客户端的 mcp.json 只能填一个 URL，于是"客户端连的是谁"和"用户想操作谁"经常不一致；
 * 更糟的是，客户端连的那个编辑器一关，整条链路就断了，哪怕目标项目好好开着。
 *
 * hub 是独立于编辑器的常驻进程，固定占一个端口：
 *   1. 每次收到 MCP 请求，读全局 target.json 找到目标项目
 *   2. 转发到目标项目所在的编辑器实例
 *   3. 目标不在线（编辑器关了）就退而求其次，挑一个还活着的项目
 *   4. 一个都不在，就返回明确错误而不是干等
 *
 * 用法：
 *   node hub.js            # 默认端口 25800
 *   node hub.js 25810      # 指定端口
 *
 * 客户端（mcp.json）填 hub 的端口：
 *   { "cocos-mcp-2x": { "type": "http", "url": "http://127.0.0.1:25800/mcp" } }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const PORT = parseInt(process.argv[2], 10) || 25800;
const HOME = path.join(os.homedir(), '.CocosCreator', 'cocos-mcp-2x');

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        return null;
    }
}

function readRegistry() {
    const dir = path.join(HOME, 'ports');
    const out = [];
    const byProject = new Map();
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        return out;
    }
    for (const f of files) {
        if (f.slice(-5) !== '.json') continue;
        const full = path.join(dir, f);
        const o = readJson(full);
        if (!o || !o.port) continue;

        // 同一项目只留一条（改过文件命名规则后可能留下旧格式残留）
        const prev = byProject.get(o.project);
        if (prev) {
            const newer = (o.startedAt || '') > (prev.startedAt || '') ? o : prev;
            byProject.set(o.project, newer);
            continue;
        }
        byProject.set(o.project, o);
        out.push(o);
    }
    out.sort((a, b) => a.port - b.port);
    return out;
}

function readTarget() {
    return readJson(path.join(HOME, 'target.json'));
}

/**
 * 目标记的是项目身份，端口实时解析。
 * 端口按启动顺序分配，编辑器一重启就互换 —— 存端口等于存了个会漂移的引用。
 */
function resolveTarget(projects) {
    const t = readTarget();
    if (!t) return null;

    // 先按项目路径匹配（同名项目在不同盘符的常见情况），再按项目名兜底
    let hit = null;
    if (t.project) {
        hit = projects.find(p => p.project === t.project) || null;
    }
    if (!hit && t.name) {
        hit = projects.find(p => p.name === t.name) || null;
    }

    if (!hit) {
        return { name: t.name || null, project: t.project || null, port: null, online: false };
    }
    return { name: hit.name, project: hit.project, port: hit.port, pid: hit.pid, online: true };
}

function alive(port, timeoutMs) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        let done = false;
        const finish = v => {
            if (done) return;
            done = true;
            try { s.destroy(); } catch (e) { /* 忽略 */ }
            resolve(v);
        };
        s.setTimeout(timeoutMs || 700);
        s.on('connect', () => finish(true));
        s.on('error', () => finish(false));
        s.on('timeout', () => finish(false));
    });
}

function forward(port, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', e => reject(new Error('转发失败：' + (e.code || e.message))));
        req.setTimeout(180000, () => req.destroy(new Error('转发超时')));
        req.end(body);
    });
}

/** 转发 GET 请求到另一个端口的指定路径 */
function forwardRawGet(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path,
            method: 'GET'
        }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', e => reject(new Error('转发失败：' + (e.code || e.message))));
        req.setTimeout(30000, () => req.destroy(new Error('转发超时')));
        req.end();
    });
}

/** 转发到另一个端口的指定路径（不限定 /mcp） */
function forwardRaw(port, path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', e => reject(new Error('转发失败：' + (e.code || e.message))));
        req.setTimeout(30000, () => req.destroy(new Error('转发超时')));
        req.end(body);
    });
}

async function pickTarget() {
    const projects = readRegistry();
    const t = resolveTarget(projects);

    // 目标优先（按实时解析出的端口），其次其它注册过的
    const candidates = [];
    if (t && t.port) candidates.push(t);
    for (const p of projects) {
        if (!t || p.port !== t.port) candidates.push(p);
    }

    for (const c of candidates) {
        if (await alive(c.port)) return { picked: c, wanted: t, candidates };
    }
    return { picked: null, wanted: t, candidates };
}

const server = http.createServer(async (req, res) => {
    // 给人看的状态页
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
        const projects = readRegistry();
        const t = resolveTarget(projects);
        const aliveList = [];
        for (const p of projects) aliveList.push({ ...p, alive: await alive(p.port) });
        const body = JSON.stringify({
            hub: { port: PORT, url: 'http://127.0.0.1:' + PORT + '/mcp' },
            target: t,
            projects: aliveList,
            note: 'AI 用 mcp.json 里这个端口；用 set_target_project 决定实际操作哪个项目'
        }, null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
        return;
    }

    // 浏览器侧运行时上报 —— 中继要转发给目标项目的扩展实例。
    // 注入脚本报的是中继端口（客户端连的是中继），中继再转给真正收数据的那个实例。
    if (req.method === 'POST' && req.url && req.url.indexOf('/runtime-report') === 0) {
        const { picked } = await pickTarget();
        if (!picked) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":false,"reason":"no available project"}');
            return;
        }
        let body = '';
        req.on('data', c => {
            body += c;
            if (body.length > 16 * 1024 * 1024) req.destroy();
        });
        req.on('end', async () => {
            try {
                const r = await forwardRaw(picked.port, '/runtime-report', body);
                res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
                res.end(r.data);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, reason: e.message }));
            }
        });
        return;
    }

    // Web 预览桥接 —— 同样转发给目标项目的扩展实例。
    //
    // 为什么走中继：注入到预览页的 bridge.js 里写的是**中继端口**。
    // 扩展实例的端口会变（编辑器重启、端口按启动顺序分配），
    // 写死扩展端口的话，扩展一重启，页面里的配置就指向一个死端口，
    // 桥接从此断掉 —— 而且没有任何报错，只是静默地不再上报。
    // 中继端口是固定的（mcp.json 就指着它），所以走中继最稳。
    if (req.url && req.url.indexOf('/bridge/') === 0) {
        const { picked } = await pickTarget();
        if (!picked) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":false,"reason":"no available project"}');
            return;
        }
        const path = req.url;

        if (req.method === 'GET') {
            // /bridge/commands —— 浏览器轮询指令
            try {
                const r = await forwardRawGet(picked.port, path);
                res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
                res.end(r.data);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, reason: e.message }));
            }
            return;
        }

        let body = '';
        req.on('data', c => {
            body += c;
            if (body.length > 16 * 1024 * 1024) req.destroy();
        });
        req.on('end', async () => {
            try {
                const r = await forwardRaw(picked.port, path, body);
                res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
                res.end(r.data);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, reason: e.message }));
            }
        });
        return;
    }

    if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('只接受 POST /mcp');
        return;
    }

    let body = '';
    req.on('data', c => {
        body += c;
        if (body.length > 16 * 1024 * 1024) req.destroy();
    });

    req.on('end', async () => {
        const { picked, wanted, candidates } = await pickTarget();

        if (!picked) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32000,
                    message: '没有可用的 Cocos 项目。请至少打开一个 Cocos Creator 2.x 项目' +
                        (wanted ? '（目标 ' + wanted.name + ' 的端口 ' + wanted.port + ' 没响应）' : '') +
                        '。已知的端口：' + candidates.map(c => c.port).join(', ')
                }
            }));
            return;
        }

        try {
            const r = await forward(picked.port, body);
            res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
            res.end(r.data);
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32000, message: e.message }
            }));
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    const t = resolveTarget(readRegistry());
    console.log('[cocos-mcp-2x hub] 已启动 → http://127.0.0.1:' + PORT + '/mcp');
    console.log('  当前目标：' + (t ? t.name + (t.port ? '（端口 ' + t.port + '）' : '（当前没打开）') : '未设置'));
    console.log('  状态页：http://127.0.0.1:' + PORT + '/status');
});

process.on('SIGINT', () => {
    console.log('\n[cocos-mcp-2x hub] 退出');
    process.exit(0);
});
