// dev-eval.js —— 把一段 JS 文件当作 eval_scene 的 code 发过去。
// 存在的意义：代码里有引号、换行、正则，塞进命令行 JSON 必然转义出错。
//
//   node dev-eval.js 25900 temp/probe.js
//   node dev-eval.js 25900 temp/probe.js --tool run_script
//
// 参数：<port> <codeFile> [--tool eval_scene|run_script|execute_script] [--arg k=v ...]
const fs = require('fs');
const http = require('http');

const port = parseInt(process.argv[2], 10);
const file = process.argv[3];
if (!port || !file) {
    console.error('用法: node dev-eval.js <port> <codeFile> [--tool eval_scene|run_script]');
    process.exit(1);
}

let tool = 'eval_scene';
let renderer = false;
const extra = {};
for (let i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === '--renderer') { renderer = true; continue; }
    if (process.argv[i] === '--tool') { tool = process.argv[++i]; continue; }
    if (process.argv[i] === '--arg') {
        const kv = process.argv[++i] || '';
        const eq = kv.indexOf('=');
        if (eq > 0) extra[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
}

let code = fs.readFileSync(file, 'utf8');

// --renderer：代码在场景面板的渲染进程里跑（那里有 cc 和 DOM）。
// 主进程这段代码只是把文件读出来丢给 executeJavaScript —— 不用手工转义。
if (renderer) {
    tool = 'run_script';
    code = 'const _fs = require("fs");\n' +
        'const _win = Editor.Panel.findWindow("scene");\n' +
        'const _wc = _win && _win.nativeWin && _win.nativeWin.webContents;\n' +
        'if (!_wc) return { error: "no webContents" };\n' +
        'const _src = _fs.readFileSync(' + JSON.stringify(file) + ', "utf8");\n' +
        'return _wc.executeJavaScript("(function(){\\n" + _src + "\\n})()", true).then(function (v) {\n' +
        '    return { ok: true, value: v };\n' +
        '}, function (e) { return { ok: false, error: String(e && e.message || e) }; });\n';
}

const args = Object.assign({ code: code }, extra);
const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: tool, arguments: args }
});

const req = http.request({
    host: '127.0.0.1', port: port, path: '/mcp', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, function (res) {
    let d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () {
        try {
            const j = JSON.parse(d);
            const c = j.result && j.result.content && j.result.content[0];
            const text = c ? c.text : JSON.stringify(j, null, 2);
            try {
                console.log(JSON.stringify(JSON.parse(text), null, 1));
            } catch (e) {
                console.log(text);
            }
        } catch (e) {
            console.log(d);
        }
    });
});
req.on('error', function (e) { console.error('请求失败: ' + e.message); process.exit(1); });
req.setTimeout(120000, function () { req.destroy(); console.error('超时'); });
req.end(body);
