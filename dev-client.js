#!/usr/bin/env node
/**
 * dev-client.js —— 开发期直连指定端口的 MCP 客户端
 *
 * 为什么需要它：mcp.json 里只能登记一个 URL，客户端会把它绑死。
 * 开发时 25900 可能是真实项目（不能碰），测试项目在 25901，
 * 原生 MCP 工具打不到，所以留一个按端口直连的小工具。
 *
 * 用法：
 *   node dev-client.js 25901 get_project_info
 *   node dev-client.js 25901 query_scene_tree '{"path":"assets/scene/Game.fire","maxDepth":1}'
 *   node dev-client.js 25901 execute_script '{"code":"return 1+1"}'
 *   node dev-client.js 25901 --list           # 列出该端口所有工具名
 */

const http = require('http');

const PORT = parseInt(process.argv[2], 10);
const REST = process.argv.slice(3);

if (!PORT || !REST.length) {
    console.error('用法: node dev-client.js <port> <tool|--list> [jsonArgs]');
    process.exit(1);
}

const TOOL = REST[0];
let ARGS = {};
if (REST[1]) {
    try {
        ARGS = JSON.parse(REST[1]);
    } catch (e) {
        console.error('参数不是合法 JSON: ' + e.message);
        process.exit(1);
    }
}

function rpc(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params });
        const req = http.request({
            host: '127.0.0.1',
            port: PORT,
            path: '/mcp',
            method: 'POST',
            // 关掉连接复用：服务端 reload 后旧 socket 会读到已关闭的旧实例
            agent: false,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(body),
                'Connection': 'close'
            }
        }, function (res) {
            let data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('返回非 JSON: ' + data.slice(0, 300))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 30000, function () {
            req.destroy(new Error('请求超时 ' + (timeoutMs || 30000) + 'ms'));
        });
        req.end(body);
    });
}

(async function main() {
    try {
        if (TOOL === '--list') {
            const r = await rpc('tools/list', {});
            const tools = r.result.tools || [];
            console.log('端口 ' + PORT + ' 工具数: ' + tools.length);
            tools.forEach(function (t) { console.log('  - ' + t.name); });
            return;
        }

        if (TOOL === '--init') {
            const r = await rpc('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'dev-client', version: '1.0' }
            });
            console.log(JSON.stringify({ serverInfo: r.result.serverInfo, protocolVersion: r.result.protocolVersion }, null, 2));
            return;
        }

        const r = await rpc('tools/call', { name: TOOL, arguments: ARGS });
        if (r.error) {
            console.log('RPC 错误: ' + JSON.stringify(r.error));
            process.exit(2);
        }
        const c = r.result && r.result.content;
        if (!c || !c.length) {
            console.log(JSON.stringify(r.result, null, 2));
            return;
        }
        const text = c[0].text;
        try {
            console.log(JSON.stringify(JSON.parse(text), null, 2));
        } catch (e) {
            console.log(text);
        }
        if (r.result.isError) process.exit(2);
    } catch (e) {
        console.error('失败: ' + e.message);
        process.exit(1);
    }
})();
