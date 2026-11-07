'use strict';

/**
 * uuid ↔ 资源路径 双向索引。
 *
 * Cocos 的两种 uuid：
 *   - **完整 uuid**：36 位带横线，meta 里的 "uuid" 字段
 *   - **压缩 uuid**：23 字符，场景文件里脚本组件的 __type__ 就是这个
 *
 * 一张 png 有**两个** uuid：
 *   - 主 uuid（meta 里第一个 "uuid"）→ texture，**不能**填进 Sprite._spriteFrame
 *   - subMetas 里的 uuid → sprite-frame，**这才是** _spriteFrame 要填的
 * 填错会在渲染时报 `spriteFrame.textureLoaded is not a function`。
 *
 * 依赖注入：ctx 传入 { projectRoot, relPath, safePath, walkFiles, statSafe }，
 *   这样本模块不依赖 main.js，也不产生循环引用。
 */

const fs = require('fs');
const path = require('path');

const UUID_CACHE_MS = 30000;

/** Cocos 的压缩 uuid 用的 base64 字符表 */
const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function compressUuid(uuid) {
    var hex = String(uuid).replace(/-/g, '');
    if (hex.length !== 32) return String(uuid);
    var out = hex.slice(0, 5);
    for (var i = 5; i < 32; i += 3) {
        var num = parseInt(hex.substr(i, 3), 16);
        out += BASE64_KEYS.charAt(num >> 6) + BASE64_KEYS.charAt(num & 63);
    }
    return out;
}

var uuidCache = { root: null, time: 0, byFull: {}, byShort: {} };

/**
 * 宿主注入的上下文。由 main.js 在加载时调用 setContext 填好。
 * 之所以要注入：projectRoot() 依赖编辑器全局 Editor，
 * 而 Editor 只在编辑器主进程里存在 —— 本模块单独测试时没有它。
 */
var ctx = {
    projectRoot: function () { throw new Error('uuid 模块未初始化：请先调用 setContext()'); },
    relPath: function (abs) { return abs; },
    safePath: function (rel) { return rel; },
    walkFiles: function () { throw new Error('uuid 模块未初始化：请先调用 setContext()'); },
    statSafe: function () { return null; },
    skipDirs: {}
};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

/**
 * 单个 .meta 的解析结果缓存（按 abs 路径 + mtime + size 命中）。
 *
 * 为什么要这个：cleanMaster（4086 资源）整表重建要 1.2–1.4 秒，而
 * `refresh_assets` 每次都会 `invalidateCache()` —— 于是"写 → 刷 → 读回"
 * 这一轮要付两次全量扫描。有了这层缓存，重建只做"遍历 + stat"，
 * 只有真正变过的 .meta 才重新解析（改一个文件 = 解析一个文件）。
 */
var metaCache = {};
var metaCacheHits = { hit: 0, miss: 0 };

/** 解析一个 .meta，抽出主 uuid / 子资源 uuid / sprite-frame 标记 */
function parseMetaEntry(full, assetRel, st) {
    var txt;
    try {
        txt = fs.readFileSync(full, 'utf8');
    } catch (e) {
        return null;
    }

    var m = /"uuid"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/.exec(txt);
    if (!m) return null;

    var subs = [];
    var seen = {};
    var subRe = /"subMetas"\s*:\s*\{([\s\S]*?)\n(\s*)\}/g;
    var sm;
    while ((sm = subRe.exec(txt)) !== null) {
        var body = sm[1];
        var uRe = /"uuid"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
        var um;
        while ((um = uRe.exec(body)) !== null) {
            var su = um[1];
            if (su === m[1] || seen[su]) continue;
            seen[su] = true;
            subs.push(su);
        }
    }

    // sprite-frame 的两种写法（importer 在前 / uuid 在前）都扫一遍
    var frames = [];
    var fSeen = {};
    var impRe = /"importer"\s*:\s*"sprite-frame"[\s\S]{0,400}?"uuid"\s*:\s*"([0-9a-fA-F-]{36})"/g;
    var im;
    while ((im = impRe.exec(txt)) !== null) {
        if (!fSeen[im[1]]) { fSeen[im[1]] = true; frames.push(im[1]); }
    }
    var impRe2 = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"[\s\S]{0,200}?"importer"\s*:\s*"sprite-frame"/g;
    var im2;
    while ((im2 = impRe2.exec(txt)) !== null) {
        if (!fSeen[im2[1]]) { fSeen[im2[1]] = true; frames.push(im2[1]); }
    }

    return {
        mtimeMs: st.mtimeMs,
        size: st.size,
        assetRel: assetRel,
        uuid: m[1],
        subs: subs,
        spriteFrames: frames
    };
}

/**
 * 扫描 assets 下所有 .meta，建 uuid ↔ 路径索引。
 * 缓存 30 秒，refresh_assets 会强制失效；单文件层按 mtime 增量。
 */
function buildUuidIndex(force) {
    var root = ctx.projectRoot();
    if (!root) throw new Error('项目未打开');
    var now = Date.now();
    if (!force && uuidCache.root === root && (now - uuidCache.time) < UUID_CACHE_MS) {
        return uuidCache;
    }

    var byFull = {};
    var byShort = {};
    // uuid → 资源类型。**必须区分 texture 和 sprite-frame** ——
    // prefab 里 Sprite 组件的 _spriteFrame 只能填 sprite-frame 的 uuid，
    // 填成 texture 的（png 主 uuid）会报 "spriteFrame.textureLoaded is not a function"。
    var byKind = {};
    var assetsDir = path.join(root, 'assets');
    var count = 0;

    var nextCache = {};
    var stats = { files: 0, reused: 0, parsed: 0 };

    ctx.walkFiles(assetsDir, { maxDepth: 40, skip: ctx.skipDirs }, function (full, name) {
        if (name.slice(-5) !== '.meta') return;
        stats.files++;

        var st = ctx.statSafe(full);
        if (!st) return;

        var hit = metaCache[full];
        var entry;
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            entry = hit;
            stats.reused++;
        } else {
            entry = parseMetaEntry(full, ctx.relPath(full.slice(0, -5)), st);
            stats.parsed++;
        }
        if (!entry) return;
        nextCache[full] = entry;

        byFull[entry.uuid] = entry.assetRel;
        byShort[compressUuid(entry.uuid)] = entry.uuid;
        byKind[entry.uuid] = 'asset';
        count++;

        for (var i = 0; i < entry.subs.length; i++) {
            var su = entry.subs[i];
            if (byFull[su]) continue;         // 已被更具体的占用
            byFull[su] = entry.assetRel;
            byShort[compressUuid(su)] = su;
            byKind[su] = 'sub-resource';
        }
        for (var f = 0; f < entry.spriteFrames.length; f++) {
            byKind[entry.spriteFrames[f]] = 'sprite-frame';
        }
    });

    metaCache = nextCache;
    metaCacheHits = stats;

    uuidCache = {
        root: root, time: now, byFull: byFull, byShort: byShort, byKind: byKind, count: count,
        // 供 diagnose 用：这次重建到底读了多少文件
        scan: stats
    };
    return uuidCache;
}

/**
 * uuid → 资源类型。
 * 返回 'sprite-frame' / 'asset' / 'sub-resource' / null
 */
function uuidKind(uuid) {
    var idx = buildUuidIndex(false);
    var u = String(uuid || '').trim();
    if (idx.byKind[u]) return idx.byKind[u];
    if (idx.byShort[u] && idx.byKind[idx.byShort[u]]) return idx.byKind[idx.byShort[u]];
    return null;
}

function uuidToPath(uuid) {
    var idx = buildUuidIndex(false);
    var u = String(uuid || '').trim();
    if (idx.byFull[u]) return idx.byFull[u];
    // 传进来的是压缩形态
    if (idx.byShort[u] && idx.byFull[idx.byShort[u]]) return idx.byFull[idx.byShort[u]];
    return null;
}

/** 路径 → 完整 uuid（读同名 .meta） */
function pathToUuid(rel) {
    var abs = ctx.safePath(rel);
    var meta = abs + '.meta';
    if (!ctx.statSafe(meta)) return null;
    var txt;
    try {
        txt = fs.readFileSync(meta, 'utf8');
    } catch (e) {
        return null;
    }
    var m = /"uuid"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(txt);
    return m ? m[1] : null;
}

var scriptInfoCache = {};

/**
 * 从脚本源码里捞类名。只做正则匹配，不引 TS 解析器——
 * 目标是"知道这个组件叫什么"，不是做语义分析。
 */
function readScriptInfo(rel) {
    var abs;
    try {
        abs = ctx.safePath(rel);
    } catch (e) {
        return null;
    }
    var st = ctx.statSafe(abs);
    if (!st) return null;
    var key = abs;
    var cached = scriptInfoCache[key];
    if (cached && cached.mtime === st.mtimeMs) return cached.info;

    var txt;
    try {
        txt = fs.readFileSync(abs, 'utf8');
    } catch (e) {
        return null;
    }

    var info = { path: rel, className: null, baseClass: null, ccclassName: null };
    var cls = /(?:export\s+default\s+|export\s+)?class\s+([A-Za-z_$][\w$]*)\s+extends\s+([\w$.]+)/.exec(txt);
    if (cls) {
        info.className = cls[1];
        info.baseClass = cls[2];
    }
    var cc = /@ccclass\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(txt);
    if (cc) info.ccclassName = cc[1];

    scriptInfoCache[key] = { mtime: st.mtimeMs, info: info };
    return info;
}

//#endregion

module.exports = {
    setContext: setContext,
    compressUuid: compressUuid,
    buildUuidIndex: buildUuidIndex,
    uuidKind: uuidKind,
    uuidToPath: uuidToPath,
    pathToUuid: pathToUuid,
    readScriptInfo: readScriptInfo,
    invalidateCache: function () { uuidCache = { root: null, time: 0, byFull: {}, byShort: {} }; },
    /** 清掉单文件级缓存（换项目 / 怀疑 meta 被外部改动时用） */
    invalidateMetaCache: function () { metaCache = {}; },
    BASE64_KEYS: BASE64_KEYS
};
