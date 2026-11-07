// 验收脚本：全部经中继入口走一遍
const http = require('http');

const HUB = 25800;

function rpc(tool, args) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: tool, arguments: args || {} }
        });
        const req = http.request({
            host: '127.0.0.1', port: HUB, path: '/mcp', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    const t = j.result.content[0].text;
                    if (j.result.isError) { reject(new Error(t)); return; }
                    resolve(JSON.parse(t));
                } catch (e) { reject(new Error('解析失败: ' + d.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }).on('error', reject);
    });
}

(async () => {
    console.log('════ 步骤 0：入口与目标 ════');
    const st = await httpGet('http://127.0.0.1:' + HUB + '/status');
    const info = JSON.parse(st.body);
    console.log('  中继入口 : http://127.0.0.1:' + HUB + '/mcp');
    console.log('  目标项目 : ' + (info.target ? info.target.name + ' (端口 ' + info.target.port + ')' : '未设置'));
    info.projects.forEach(p => console.log('    · ' + p.name + '  端口 ' + p.port + '  存活=' + p.alive));

    console.log('\n════ 步骤 1：环境自检 ════');
    const ping = await rpc('scene_ping');
    console.log('  项目     : ' + ping.sceneFile + '  (' + ping.objectCount + ' 个对象)');
    console.log('  模板可用 : ' + ping.templateFound);

    const gi = await rpc('get_project_info');
    console.log('  操作目标 : ' + gi.operatingProject + '   isTarget=' + gi.isTarget +
        '   端口 ' + gi.mcpPort);

    console.log('\n════ 步骤 2：构建产物 ════');
    const bs = await rpc('build_status');
    console.log('  状态=' + bs.state + '  文件=' + bs.fileCount + '  体积=' + Math.round((bs.bytes || 0) / 1024 / 1024 * 10) / 10 + 'MB');

    console.log('\n════ 步骤 3：游戏能不能真的打开 ════');
    const pv = await rpc('preview_control', { action: 'status' });
    console.log('  预览服务 : ' + pv.running + '  端口 ' + pv.port);
    if (pv.running) {
        const page = await httpGet(pv.buildUrl);
        const title = (page.body.match(/<title>([^<]*)<\/title>/) || [])[1] || '(无 title)';
        console.log('  游戏页面 : HTTP ' + page.status + '  ' + page.body.length + 'B  <' + title + '>');
    }

    console.log('\n════ 步骤 4：读 → 改 → 写 → 验 ════');
    const before = await rpc('query_scene_tree', { path: 'assets/scene/Game.fire', node: 'Canvas' });
    console.log('  改前 Canvas 子节点: ' + before.tree.children.map(c => c.name).join(', '));

    const add = await rpc('scene_add_node', {
        parent: 'Canvas', name: 'AcceptNode', position: { x: 30, y: 40 }
    });
    console.log('  加节点 : ' + add.added.name + ' (id=' + add.added.id + ') 已存盘=' + add.saved);

    const set = await rpc('scene_set_props', {
        node: 'Canvas/AcceptNode', position: { x: 111, y: 222 }
    });
    console.log('  改属性 : ' + set.changed.join(', '));

    const after = await rpc('query_scene_tree', { path: 'assets/scene/Game.fire', node: 'Canvas' });
    const n = after.tree.children.filter(c => c.name === 'AcceptNode')[0];
    console.log('  读回   : AcceptNode pos=(' + (n ? n.position.x + ',' + n.position.y : '缺失') + ')  子节点总数=' + after.tree.children.length);

    console.log('\n════ 步骤 5：清理 ════');
    const del = await rpc('scene_remove_node', { node: 'Canvas/AcceptNode' });
    console.log('  删节点 : ' + del.removed + '  对象 ' + del.objectsBefore + ' → ' + del.objectsAfter);

    const final = await rpc('query_scene_tree', { path: 'assets/scene/Game.fire', node: 'Canvas' });
    console.log('  最终 Canvas 子节点: ' + final.tree.children.map(c => c.name).join(', '));
})().catch(e => {
    console.error('验收失败：', e.message);
    process.exit(1);
});
