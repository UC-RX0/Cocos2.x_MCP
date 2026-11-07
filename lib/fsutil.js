'use strict';

/**
 * 纯文件系统工具 —— 不碰 Editor，不碰项目上下文。
 *
 * 拆出来的理由：这些函数是整个 MCP 里最"纯"的一层，
 * 任何模块都能安全依赖它们，测试时也不需要 mock 编辑器。
 *
 * 兼容性：Cocos Creator 2.4 内置 Node 版本较老，
 *   刻意不使用 ?. / ?? / Array.flat 等新语法。
 */

const fs = require('fs');
const path = require('path');

/** 读目录/文件状态，失败返回 null（EPERM、ENOENT 都不抛） */
function statSafe(abs) {
    try {
        return fs.statSync(abs);
    } catch (e) {
        return null;
    }
}

/**
 * 通用目录遍历。用显式栈而不是递归，避免超深目录爆栈。
 * onFile(full, name, stat) 返回 false 可中断遍历。
 */
function walkFiles(baseDir, opts, onFile) {
    opts = opts || {};
    var maxDepth = opts.maxDepth === undefined ? 30 : opts.maxDepth;
    var skip = opts.skip || {};
    var stack = [{ d: baseDir, depth: 0 }];
    while (stack.length) {
        var cur = stack.pop();
        var items;
        try {
            items = fs.readdirSync(cur.d);
        } catch (e) {
            continue;
        }
        for (var i = 0; i < items.length; i++) {
            var name = items[i];
            var full = path.join(cur.d, name);
            var st = statSafe(full);
            if (!st) continue;
            if (st.isDirectory()) {
                if (skip[name]) continue;
                if (cur.depth + 1 <= maxDepth) stack.push({ d: full, depth: cur.depth + 1 });
            } else {
                if (onFile(full, name, st) === false) return;
            }
        }
    }
}

/** 只读文件末尾若干字节，避免把几百 MB 的日志整个读进内存 */
function readTail(abs, maxBytes) {
    var st = statSafe(abs);
    if (!st) return '';
    var start = Math.max(0, st.size - maxBytes);
    var len = st.size - start;
    if (len <= 0) return '';
    var fd;
    try {
        fd = fs.openSync(abs, 'r');
        var buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return buf.toString('utf8');
    } catch (e) {
        return '';
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (e2) { /* 忽略 */ }
        }
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 简单 glob：* 不跨目录，** 跨目录，? 单字符 */
function globToRegExp(glob) {
    var g = String(glob).trim();
    var out = '';
    for (var i = 0; i < g.length; i++) {
        var c = g.charAt(i);
        if (c === '*') {
            if (g.charAt(i + 1) === '*') {
                out += '.*';
                i++;
            } else {
                out += '[^/\\\\]*';
            }
        } else if (c === '?') {
            out += '.';
        } else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) {
            out += '\\' + c;
        } else {
            out += c;
        }
    }
    return new RegExp('^' + out + '$', 'i');
}

module.exports = {
    statSafe: statSafe,
    walkFiles: walkFiles,
    readTail: readTail,
    escapeRegExp: escapeRegExp,
    globToRegExp: globToRegExp
};
