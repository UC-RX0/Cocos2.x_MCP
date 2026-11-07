#!/usr/bin/env node
/**
 * deploy.js —— 带冲突检测的部署脚本
 *
 * 背景：扩展是全局安装的，可能有人（另一个会话、用户自己）在同时改同一份代码。
 * 无脑 cp 会把对方的改动覆盖掉，而且双方都不知道。
 * 所以这里记录"上次部署后磁盘上应该是什么样"，下次部署前先比对，
 * 发现被改过就停下来报告，除非显式 --force。
 *
 * 用法：
 *   node deploy.js            正常部署（有冲突会拒绝）
 *   node deploy.js --force    强制覆盖
 *   node deploy.js --check    只检查不部署
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = __dirname;
// 扩展目录名在不同安装方式下不统一：标准名是 cocos-mcp-2x，
// 但这台机器上编辑器实际加载的是 packages/mcp。优先标准名，
// 不存在则回退，避免把代码部署到编辑器根本不看的目录。
const PKG_ROOT = path.join(require('os').homedir(), '.CocosCreator', 'packages');
const DEP_STD = path.join(PKG_ROOT, 'cocos-mcp-2x');
const DEP_LEGACY = path.join(PKG_ROOT, 'mcp');
const DEP = fs.existsSync(DEP_STD) ? DEP_STD : DEP_LEGACY;
const MANIFEST = path.join(SRC, '.deploy-manifest.json');

// 只部署这些文件。dev-client.js 是开发期工具，故意不进扩展目录。
// lib/ 是拆出来的纯逻辑层，main.js 会 require 它 —— 必须一起部署，
// 少一个就是 "Cannot find module" 的启动失败。
const FILES = ['main.js', 'scene.js', 'package.json', 'reload.js', 'test.js', 'hub.js',
    'injector.js', 'inject-runtime.js', 'bridge.js',
    'HANDOFF.md', 'README.md', 'README.en.md', 'DEVELOP.md',
    'lib/fsutil.js', 'lib/uuid.js', 'lib/scene-parse.js',
    'lib/scene-tools.js', 'lib/prefab.js', 'lib/doc.js', 'lib/asset-graph.js',
    'lib/editor-state.js',
    'lib/tool-schema.js', 'lib/scene-template.js'];

const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');

function md5(file) {
    try {
        return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    } catch (e) {
        return null;
    }
}

/**
 * 语法检查。用 vm.Script 编译 —— 不起子进程，快。
 * 返回 { ok, message, line }
 */
function checkSyntax(file) {
    const vm = require('vm');
    let code;
    try {
        code = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { ok: false, message: '读不了文件：' + e.message, line: 0 };
    }
    try {
        // 包成模块，避免顶层 return / import 之类误判
        new vm.Script('(function(exports, require, module, __filename, __dirname){' + code + '\n})', { filename: file });
        return { ok: true, message: '', line: 0 };
    } catch (e) {
        // 从堆栈里抠出行号
        let line = 0;
        const m = /:(\d+)\)?$/.exec((e.stack || '').split('\n')[0] || '');
        if (m) line = parseInt(m[1], 10);
        return { ok: false, message: e.message, line: line };
    }
}

function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    } catch (e) {
        return {};
    }
}

function writeManifest(m) {
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

const old = readManifest();
const conflicts = [];
const changed = [];

for (const f of FILES) {
    const srcFile = path.join(SRC, f);
    const depFile = path.join(DEP, f);

    if (!fs.existsSync(srcFile)) continue;

    // 部署前必须过语法检查 —— 语法错误的 js 进了编辑器会直接让扩展崩掉，
    // 而且报错信息（"未知工具"之类）跟真实原因对不上，很难查。
    if (f.endsWith('.js')) {
        const check = checkSyntax(srcFile);
        if (!check.ok) {
            console.error('✗ 语法错误，拒绝部署：' + f);
            console.error('  ' + check.message);
            if (check.line) {
                const lines = fs.readFileSync(srcFile, 'utf8').split(/\r?\n/);
                for (let i = Math.max(0, check.line - 3); i < Math.min(lines.length, check.line + 2); i++) {
                    console.error('  ' + (i + 1 === check.line ? '>' : ' ') + ' ' + (i + 1) + ' | ' + lines[i]);
                }
            }
            process.exit(1);
        }
    }

    const srcMd5 = md5(srcFile);
    const depMd5 = md5(depFile);
    const known = old[f];

    // 磁盘上的部署文件和我上次部署时不一样 → 有人动过
    if (known && depMd5 && depMd5 !== known) {
        conflicts.push({ file: f, deployed: depMd5, expected: known, srcMd5: srcMd5, depMd5: depMd5 });
        continue;
    }

    if (srcMd5 !== depMd5) changed.push(f);
}

if (conflicts.length && !force) {
    console.log('⚠ 部署目录被改过，拒绝覆盖：');
    for (const c of conflicts) {
        console.log('   ' + c.file + '  当前=' + c.deployed.slice(0, 8) + '  我部署时=' + c.expected.slice(0, 8));
    }
    console.log('');
    console.log('  磁盘上的部署文件和源码已经不同步。先确认那些改动是什么：');
    console.log('    diff  ~/.CocosCreator/packages/cocos-mcp-2x/<文件>  <源目录>/<文件>');
    console.log('  确认要覆盖，就加 --force 重跑。');
    process.exit(1);
}

if (conflicts.length && force) {
    // 以前这里直接 process.exit(1) 了，--force 形同虚设 —— 提示写着"加 --force 重跑"，
    // 加了还是同样的报错。强制覆盖时把冲突文件补回待部署清单（覆盖循环里被 continue 跳过了）。
    console.log('⚠ --force 强制覆盖 ' + conflicts.length + ' 个被改过的文件：');
    for (const c of conflicts) {
        console.log('   ' + c.file + '  当前=' + c.deployed.slice(0, 8) + '  我部署时=' + c.expected.slice(0, 8));
        if (c.srcMd5 !== c.depMd5) changed.push(c.file);
    }
    console.log('');
}

if (checkOnly) {
    console.log(changed.length ? '待部署：' + changed.join(', ') : '没有待部署的改动');
    process.exit(0);
}

for (const f of changed) {
    const dest = path.join(DEP, f);
    // lib/ 等子目录在扩展目录里可能还不存在，先建出来
    // （mkdirSync 带 recursive:true，目录已存在也不报错）
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), dest);
    console.log('  ✓ ' + f);
}

const m = {};
for (const f of FILES) {
    const h = md5(path.join(DEP, f));
    if (h) m[f] = h;
}
writeManifest(m);

console.log(changed.length
    ? ('部署完成：' + changed.join(', '))
    : '部署完成：没有需要更新的文件');
if (force) console.log('（本次是 --force 强制覆盖）');
