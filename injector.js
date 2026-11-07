'use strict';

/**
 * 浏览器侧运行时上报的注入器。
 *
 * 为什么需要：编辑器里的场景进程能读到运行时状态，但**浏览器里跑着的那个游戏**
 * 是另一个进程，读不到它。要让 AI 看到"玩家实际在玩的时候"的状态，
 * 唯一的办法是让游戏自己把状态报回来。
 *
 * 怎么注入：**只改 index.html**，不动任何带哈希的资源文件。
 *   - index.html 是入口，没有哈希，改它不影响资源完整性
 *   - 资源文件（main.a1b2c3.js）一个字节都不动，md5 校验依然通过
 *   - 插入一行 <script src="mcp-runtime-report.js">，并在它之前写入配置
 *
 * 静默：
 *   - 不弹窗、不改画面、不影响游戏逻辑
 *   - 上报失败自动放弃（连续失败 3 次就停）
 *   - 非本机页面自动禁用
 *   - URL 加 ?mcp=off 即可关闭
 *
 * 可逆：
 *   - 改之前把原 index.html 备份成 index.html.mcp-bak
 *   - 重复注入不会叠加（认标记）
 *   - uninject 能还原
 */

const fs = require('fs');
const path = require('path');

const MARK_START = '<!-- cocos-mcp-2x:runtime-report:start -->';
const MARK_END = '<!-- cocos-mcp-2x:runtime-report:end -->';
const SCRIPT_NAME = 'mcp-runtime-report.js';
const BACKUP_SUFFIX = '.mcp-bak';

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 拿到注入脚本的源码 */
function readInjectorSource(selfDir) {
    const p = path.join(selfDir, 'inject-runtime.js');
    if (!fs.existsSync(p)) {
        throw new Error('找不到注入脚本：' + p);
    }
    return fs.readFileSync(p, 'utf8');
}

/**
 * 在 index.html 里找注入点。
 * 优先插在 `window.boot()` 调用之后（那时 cc 已经加载好了）；
 * 找不到就插在最后一个 <script> 之前。
 */
function findInjectionAnchor(html) {
    // 找 boot 的调用点：loadScript(... , function () { ... window.boot(); ... })
    const bootIdx = html.lastIndexOf('window.boot()');
    if (bootIdx >= 0) {
        // 找到这个调用所在的 script 块结束位置
        const after = html.indexOf('</script>', bootIdx);
        if (after > 0) {
            return { at: after, kind: 'after-boot' };
        }
    }
    // 兜底：最后一个 </body> 前
    const bodyIdx = html.lastIndexOf('</body>');
    if (bodyIdx > 0) {
        return { at: bodyIdx, kind: 'before-body-end' };
    }
    return null;
}

/**
 * 注入（或撤销）。
 * 返回 { injected, changed, dest, backup, reason }
 */
function applyInjection(destDir, opts) {
    const o = opts || {};
    const selfDir = o.selfDir || __dirname;
    const port = o.port || 0;
    const project = o.project || null;
    const interval = o.interval || 2000;

    const indexPath = path.join(destDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
        return {
            injected: false,
            changed: false,
            dest: destDir,
            reason: '找不到 index.html（这个产物可能不是 web 构建）'
        };
    }

    const original = fs.readFileSync(indexPath, 'utf8');
    const backupPath = indexPath + BACKUP_SUFFIX;

    // 撤销模式要先判 —— 不然会走进"已注入过，只更新配置"那个分支
    if (o.remove) {
        if (original.indexOf(MARK_START) < 0) {
            return {
                injected: false,
                changed: false,
                dest: destDir,
                reason: '这个产物本来就没注入过，无需撤销'
            };
        }
        // 有备份就用备份还原；没有备份就把注入片段剥掉
        let restored;
        if (fs.existsSync(backupPath)) {
            restored = fs.readFileSync(backupPath, 'utf8');
        } else {
            const re = new RegExp(
                '\\n*' + escapeRegExp(MARK_START) + '[\\s\\S]*?' + escapeRegExp(MARK_END) + '\\n*'
            );
            restored = original.replace(re, '\n');
        }
        fs.writeFileSync(indexPath, restored, 'utf8');
        try { fs.unlinkSync(backupPath); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(path.join(destDir, SCRIPT_NAME)); } catch (e) { /* 忽略 */ }
        return {
            injected: false,
            changed: true,
            dest: destDir,
            reason: '已撤销注入，index.html 恢复原样'
        };
    }

    // 已经注入过了 → 只更新配置，不重复插入
    if (original.indexOf(MARK_START) >= 0) {
        const refreshed = rewriteConfig(original, { port, project, interval });
        let changed = false;
        if (refreshed !== original) {
            fs.writeFileSync(indexPath, refreshed, 'utf8');
            changed = true;
        }
        // 注入脚本本身也刷新一下（逻辑可能有更新）
        const src = readInjectorSource(selfDir);
        const scriptPath = path.join(destDir, SCRIPT_NAME);
        let scriptChanged = false;
        if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== src) {
            fs.writeFileSync(scriptPath, src, 'utf8');
            scriptChanged = true;
        }
        return {
            injected: true,
            changed: changed || scriptChanged,
            dest: destDir,
            reason: '已经注入过，只更新了配置'
        };
    }

    // 备份原文件（只备份一次）
    if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, original, 'utf8');
    }

    const anchor = findInjectionAnchor(original);
    if (!anchor) {
        return {
            injected: false,
            changed: false,
            dest: destDir,
            reason: '在 index.html 里找不到注入点（没有 window.boot() 也没有 </body>）'
        };
    }

    // 写注入脚本
    const src = readInjectorSource(selfDir);
    fs.writeFileSync(path.join(destDir, SCRIPT_NAME), src, 'utf8');

    // 拼注入片段
    const config = {
        port: port,
        project: project,
        interval: interval,
        enabled: true,
        path: 'runtime-report'
    };
    const snippet = [
        MARK_START,
        '<script>window.__MCP_RUNTIME_CONFIG__ = ' + JSON.stringify(config) + ';</script>',
        '<script src="' + SCRIPT_NAME + '"></script>',
        MARK_END
    ].join('\n');

    const patched = original.slice(0, anchor.at) + '\n' + snippet + '\n' + original.slice(anchor.at);
    fs.writeFileSync(indexPath, patched, 'utf8');

    return {
        injected: true,
        changed: true,
        dest: destDir,
        anchor: anchor.kind,
        backup: backupPath,
        script: path.join(destDir, SCRIPT_NAME),
        reason: '已注入运行时上报（只改了 index.html，资源文件一个字节没动）'
    };
}

/** 替换已注入片段里的配置（不重复插入） */
function rewriteConfig(html, cfg) {
    const config = {
        port: cfg.port,
        project: cfg.project,
        interval: cfg.interval,
        enabled: true,
        path: 'runtime-report'
    };
    const re = /window\.__MCP_RUNTIME_CONFIG__\s*=\s*\{[^}]*\};/;
    if (!re.test(html)) return html;
    return html.replace(re, 'window.__MCP_RUNTIME_CONFIG__ = ' + JSON.stringify(config) + ';');
}

/** 检查一个构建目录是否已注入 */
function isInjected(destDir) {
    const indexPath = path.join(destDir, 'index.html');
    if (!fs.existsSync(indexPath)) return false;
    try {
        return fs.readFileSync(indexPath, 'utf8').indexOf(MARK_START) >= 0;
    } catch (e) {
        return false;
    }
}

/**
 * 在一个构建输出目录里找所有可能的 web 产物目录。
 * build/web-mobile、build/web-desktop、build/jsb-link 等。
 */
function findWebDests(buildRoot) {
    const out = [];
    if (!buildRoot || !fs.existsSync(buildRoot)) return out;
    let entries;
    try {
        entries = fs.readdirSync(buildRoot, { withFileTypes: true });
    } catch (e) {
        return out;
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(buildRoot, e.name);
        if (fs.existsSync(path.join(full, 'index.html'))) out.push(full);
    }
    return out;
}

module.exports = {
    applyInjection,
    findWebDests,
    isInjected,
    MARK_START,
    MARK_END,
    SCRIPT_NAME
};
