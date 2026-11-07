'use strict';

/**
 * 资源引用图（谁引用了我 / 我引用了谁）—— 纯逻辑 + 注入式 fs。
 *
 * 为什么需要：v0.4.x 之前只能查"这个 uuid 是什么"，查不了"**谁引用了我**"。
 * 于是删一张图、改一个 uuid 会不会把某个 prefab 弄坏，只能靠猜 ——
 * 这是改别人项目最容易埋雷的地方，而答案其实就在文件里（`__uuid__`）。
 *
 * 做法：扫 assets 下的序列化文件（.fire / .prefab / .anim / .json），
 * 用正则抠出所有 `"__uuid__": "..."`，建"文件 → 引用列表"的正向索引，
 * 再反转成"uuid → 引用者"。按文件 mtime 增量，改一个文件只重扫一个。
 *
 * 依赖注入：{ projectRoot, relPath, safePath, walkFiles, statSafe, skipDirs }
 */

var fs = require('fs');
var path = require('path');

var ctx = {
    projectRoot: function () { throw new Error('asset-graph 未初始化：请先 setContext'); },
    relPath: function (abs) { return abs; },
    safePath: function (rel) { return rel; },
    walkFiles: function () { throw new Error('asset-graph 未初始化：请先 setContext'); },
    statSafe: function () { return null; },
    skipDirs: {}
};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

var CACHE_MS = 30000;
var CLOCK = 0;
var cache = { root: null, time: 0, byFile: {}, toUuid: {}, files: 0 };
var fileCache = {};   // abs -> { mtimeMs, size, rel, uuids: [] }

var SCAN_EXT = { '.fire': 1, '.prefab': 1, '.anim': 1, '.json': 1 };

function extOf(name) {
    var i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i).toLowerCase();
}

/** 扫一个文件里的所有 __uuid__ 引用（去重但保留出现次数） */
function scanFile(abs, rel, st) {
    var txt;
    try {
        txt = fs.readFileSync(abs, 'utf8');
    } catch (e) {
        return null;
    }
    var counts = {};
    var order = [];
    var re = /"__uuid__"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
    var m;
    while ((m = re.exec(txt)) !== null) {
        var u = m[1];
        if (!counts[u]) { counts[u] = 0; order.push(u); }
        counts[u]++;
    }
    return {
        mtimeMs: st.mtimeMs,
        size: st.size,
        rel: rel,
        uuids: order,      // 出现过哪些（顺序无意义，但要稳定）
        counts: counts     // 各出现几次（同一张图用 3 次 = 3 处引用）
    };
}

/**
 * 建/刷新引用索引。
 * 返回 { files, refs, byFile, toUuid, elapsedMs, scan:{reused,parsed} }
 */
function buildRefIndex(force) {
    var root = ctx.projectRoot();
    if (!root) throw new Error('项目未打开');

    var now = Date.now();
    if (!force && cache.root === root && (now - cache.time) < CACHE_MS) return cache;

    var t0 = Date.now();
    var assetsDir = path.join(root, 'assets');
    var nextFiles = {};
    var stats = { reused: 0, parsed: 0, scanned: 0, skipped: 0 };

    ctx.walkFiles(assetsDir, { maxDepth: 40, skip: ctx.skipDirs }, function (full, name) {
        if (!SCAN_EXT[extOf(name)]) return;
        if (name.slice(-5) === '.meta') return;
        var st = ctx.statSafe(full);
        if (!st || st.isDirectory()) return;

        var rel = ctx.relPath(full);
        // 二进制/超大 json 跳过：它们不是序列化文档，读了也白读
        if (st.size > 8 * 1024 * 1024) { stats.skipped++; return; }
        stats.scanned++;

        var hit = fileCache[full];
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            nextFiles[full] = hit;
            stats.reused++;
            return;
        }
        var parsed = scanFile(full, rel, st);
        stats.parsed++;
        if (parsed) nextFiles[full] = parsed;
    });

    // 反转：uuid → [{file, count}]
    var toUuid = {};
    var totalRefs = 0;
    for (var abs in nextFiles) {
        if (!Object.prototype.hasOwnProperty.call(nextFiles, abs)) continue;
        var f = nextFiles[abs];
        for (var i = 0; i < f.uuids.length; i++) {
            var u = f.uuids[i];
            if (!toUuid[u]) toUuid[u] = [];
            toUuid[u].push({ file: f.rel, count: f.counts[u] || 1 });
            totalRefs += f.counts[u] || 1;
        }
    }

    fileCache = nextFiles;
    CLOCK = Date.now();
    cache = {
        root: root,
        time: now,
        byFile: nextFiles,
        toUuid: toUuid,
        files: Object.keys(nextFiles).length,
        refs: totalRefs,
        elapsedMs: Date.now() - t0,
        scan: stats,
        builtAt: CLOCK
    };
    return cache;
}

/** 谁引用了这个 uuid（返回 [{file, count}]，按引用次数降序） */
function refsTo(uuid) {
    var idx = buildRefIndex(false);
    var list = idx.toUuid[uuid] || [];
    var out = list.slice();
    out.sort(function (a, b) { return b.count - a.count; });
    return out;
}

/** 这个文件引用了哪些 uuid（返回 [{uuid, count}]） */
function refsFrom(rel) {
    var idx = buildRefIndex(false);
    var abs = ctx.safePath(rel);
    var f = idx.byFile[abs];
    if (!f) {
        // 还没入索引（新写的文件）—— 单独扫一次，顺手塞进去
        var st = ctx.statSafe(abs);
        if (!st) return null;
        var parsed = scanFile(abs, rel, st);
        if (!parsed) return null;
        idx.byFile[abs] = parsed;
        for (var i = 0; i < parsed.uuids.length; i++) {
            var u = parsed.uuids[i];
            if (!idx.toUuid[u]) idx.toUuid[u] = [];
            idx.toUuid[u].push({ file: rel, count: parsed.counts[u] || 1 });
        }
        idx.files = Object.keys(idx.byFile).length;
        f = parsed;
    }
    var out = [];
    for (var k = 0; k < f.uuids.length; k++) {
        out.push({ uuid: f.uuids[k], count: f.counts[f.uuids[k]] || 1 });
    }
    return out;
}

function invalidate() {
    cache = { root: null, time: 0, byFile: {}, toUuid: {}, files: 0 };
    fileCache = {};
}

module.exports = {
    setContext: setContext,
    buildRefIndex: buildRefIndex,
    refsTo: refsTo,
    refsFrom: refsFrom,
    invalidate: invalidate
};
