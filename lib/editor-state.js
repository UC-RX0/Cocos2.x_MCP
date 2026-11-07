/**
 * 编辑器状态层：写入台账 + 磁盘/内存差异比对。
 *
 * 为什么需要它
 * ------------
 * 这个 MCP 的核心是"直接改文件，不经过编辑器进程"。代价是：
 *   1. 编辑器内存里还是旧场景 —— 用户下次在编辑器里一保存，AI 的改动就被覆盖了，
 *      而且**没有任何提示**。这是最难查的一类事故。
 *   2. 我们改完之后，编辑器也可能反过来改这个文件（用户手动编辑并保存），
 *      我们下一次写入就会盖掉他的改动。
 *
 * 前者靠"比对磁盘上的节点集合 vs 场景进程里活着的节点集合"发现；
 * 后者靠"写入台账"发现（记录我们写完那一刻的 mtime/size，下次写之前比一下）。
 *
 * 本模块只做**纯逻辑**：读写台账、算差异、定风险等级。
 * 需要 Editor 的部分（场景进程、面板重载）留在 main.js —— 那样这个文件
 * 能在 Node 里直接单测，不需要开编辑器。
 */
var fs = require('fs');
var path = require('path');

var ctx = {
    projectRoot: function () { throw new Error('editor-state 未初始化：请先调用 setContext()'); },
    statSafe: function () { return null; },
    relPath: function (abs) { return abs; }
};

function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}

/** 台账放在 temp 下：不进 assets、不会被编辑器导入、git 里本来就忽略 */
var LEDGER_DIR = path.join('temp', 'mcp-state');
var LEDGER_FILE = 'ledger.json';
var MAX_ENTRIES = 400;
var MAX_IDS = 300;

function ledgerAbs() {
    return path.join(ctx.projectRoot(), LEDGER_DIR, LEDGER_FILE);
}

function emptyLedger() {
    return { version: 1, project: null, files: {} };
}

function readLedger() {
    var out = emptyLedger();
    try {
        var obj = JSON.parse(fs.readFileSync(ledgerAbs(), 'utf8'));
        if (obj && obj.files && typeof obj.files === 'object') {
            out.version = obj.version || 1;
            out.project = obj.project || null;
            out.files = obj.files;
        }
    } catch (e) {
        // 台账不存在 / 坏了都不影响主流程 —— 最坏退化成"没有历史"
    }
    return out;
}

function saveLedger(l) {
    var abs = ledgerAbs();
    try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(l, null, 1), 'utf8');
        return true;
    } catch (e) {
        return false;
    }
}

/** 只保留最近的若干条，台账本身别长成垃圾场 */
function prune(l) {
    var keys = Object.keys(l.files);
    if (keys.length <= MAX_ENTRIES) return 0;
    keys.sort(function (a, b) {
        return (l.files[a].at || 0) - (l.files[b].at || 0);
    });
    var drop = keys.length - MAX_ENTRIES;
    for (var i = 0; i < drop; i++) delete l.files[keys[i]];
    return drop;
}

/**
 * 记一次写入。
 *
 * **必须在写完之后调**：这里 stat 到的 mtime 就是"我们写出来的那个版本"的指纹，
 * 下次写之前拿它比，就能知道中间有没有人动过。
 */
function recordWrite(abs, meta) {
    meta = meta || {};
    var st = ctx.statSafe(abs);
    var rel = ctx.relPath(abs);
    var l = readLedger();
    l.project = ctx.projectRoot();

    var entry = {
        at: Date.now(),
        mtimeMs: st ? st.mtimeMs : null,
        size: st ? st.size : null,
        tool: meta.tool || null,
        openInEditor: meta.openInEditor === undefined ? null : !!meta.openInEditor,
        editorStale: meta.editorStale === undefined ? null : !!meta.editorStale
    };
    if (meta.uuid) entry.uuid = meta.uuid;
    // 这一批写完之后文件里有哪些节点 id、删掉了哪些 id。
    // 只留最近 300 个，台账不该长成第二个数据库。
    if (meta.ids && meta.ids.length) entry.ids = meta.ids.slice(-MAX_IDS);
    if (meta.removed && meta.removed.length) entry.removed = meta.removed.slice(-MAX_IDS);

    l.files[rel] = entry;
    prune(l);
    var saved = saveLedger(l);
    entry.persisted = saved;
    return entry;
}

/**
 * 写之前 / 任何时候：这个文件跟我们上次写的那个版本还是不是同一个。
 *
 * changed=true 有三种可能，都不加区分地报出来（区分不了，但都值得知道）：
 *   - 编辑器保存了一次（用户改了东西并 Ctrl+S）
 *   - 用户在别的编辑器里改了
 *   - git checkout / 构建脚本动了它
 */
function checkFile(abs) {
    var rel = ctx.relPath(abs);
    var l = readLedger();
    var e = l.files[rel] || null;
    if (!e) {
        return { tracked: false, changed: false, lastWrite: null, rel: rel };
    }

    var st = ctx.statSafe(abs);
    if (!st) {
        return { tracked: true, changed: true, missing: true, lastWrite: e, rel: rel };
    }

    // mtime 用 1ms 容差：JSON 往返的是双精度浮点，理论上精确，
    // 但不同文件系统（尤其网络盘/FAT）的精度不一样，严格相等容易误报"被外部改过"。
    var mtimeMoved = (e.mtimeMs == null) || Math.abs(e.mtimeMs - st.mtimeMs) >= 1;
    var changed = mtimeMoved || (e.size !== st.size);
    return {
        tracked: true,
        changed: changed,
        missing: false,
        rel: rel,
        lastWrite: e,
        ageMs: e.at ? (Date.now() - e.at) : null,
        mtimeDeltaMs: e.mtimeMs == null ? null : (st.mtimeMs - e.mtimeMs),
        sizeDelta: e.size == null ? null : (st.size - e.size)
    };
}

/** 清账（换项目、或怀疑台账脏了） */
function clearLedger(onlyMissing) {
    if (!onlyMissing) {
        var l0 = emptyLedger();
        l0.project = ctx.projectRoot();
        saveLedger(l0);
        return { cleared: 'all' };
    }
    var l = readLedger();
    var n = 0;
    Object.keys(l.files).forEach(function (rel) {
        if (!ctx.statSafe(path.join(ctx.projectRoot(), rel))) { delete l.files[rel]; n++; }
    });
    saveLedger(l);
    return { cleared: 'missing', removed: n };
}

/**
 * 磁盘上的节点集合 vs 场景进程里活着的节点集合。
 *
 * 只比 `_id`（引擎序列化时写进文件、运行时原样保留）。
 * 不比属性 —— 属性差异（用户把某个 label 改了字）这里看不到，
 * 但如果用户**增删了节点**，或者我们写了文件而编辑器没重载，
 * 这个比对一定能发现，而那正是最危险的情况。
 *
 * 场景进程那边的 liveNodes 必须已经过滤掉编辑器辅助节点
 * （它们带 HideInHierarchy 标志，见 main.js 的 LIVE_NODES_CODE）。
 */
function diffNodes(fileNodes, liveNodes, mode) {
    // 场景里每个节点都有稳定的 _id，按 id 比最准（改名也能对上）。
    // 预制体里节点的 _id 是空串（引擎的约定），只能按 path 比。
    var byPath = (mode === 'path');
    var fmap = {};
    var lmap = {};
    var i;

    function keyOf(n, counter) {
        var base = byPath ? (n.path || n.name || '') : (n.id || n.path || n.name || '');
        // 预制体里不同分支下可能重名，加序号区分，避免把两个节点压成一个
        if (counter[base] === undefined) { counter[base] = 1; return base; }
        counter[base]++;
        return base + '#' + counter[base];
    }

    var fc = {};
    var lc = {};
    for (i = 0; i < (fileNodes || []).length; i++) {
        var f = fileNodes[i];
        if (!f) continue;
        fmap[keyOf(f, fc)] = f;
    }
    for (i = 0; i < (liveNodes || []).length; i++) {
        var v = liveNodes[i];
        if (!v) continue;
        lmap[keyOf(v, lc)] = v;
    }

    var fileOnly = [];
    var liveOnly = [];
    var matched = 0;

    Object.keys(fmap).forEach(function (k) {
        if (lmap[k]) { matched++; return; }
        fileOnly.push({ id: fmap[k].id || null, name: fmap[k].name, path: fmap[k].path || null });
    });
    Object.keys(lmap).forEach(function (k) {
        if (fmap[k]) return;
        liveOnly.push({ id: lmap[k].id || null, name: lmap[k].name, path: lmap[k].path || null });
    });

    return {
        mode: byPath ? 'path' : 'id',
        matched: matched,
        fileNodes: Object.keys(fmap).length,
        liveNodes: Object.keys(lmap).length,
        fileOnly: fileOnly,
        liveOnly: liveOnly,
        inSync: fileOnly.length === 0 && liveOnly.length === 0
    };
}

/**
 * 在一棵 live 树里找"就是这棵预制体"的子树。
 *
 * 为什么不能要求完全相等：我们刚往预制体里加了个节点，文件就比编辑器内存多一个，
 * 严格相等立刻失效 —— 而这时候恰恰最需要认出"编辑器开的就是它"。
 * 所以按**双向重叠度**打分：
 *   ratioLive  = 活子树里能在文件里找到的路径占比（编辑器有没有多出来的节点）
 *   ratioFile  = 文件里能在活子树里找到的路径占比（我们有没有新加的节点）
 *   score = min(两个比例)
 * 两边都高才算同一棵。这样"我加了节点""你删了节点"都还能认出来。
 *
 * 只在临时场景（预制体编辑态）下调用 —— 普通场景里宁可判 false，
 * 也不要因为场景里摆了个同款预制体实例就说"你正开着这个预制体"。
 */
function findMatchingSubtree(prefabNodes, liveNodes, minScore) {
    if (!prefabNodes || !prefabNodes.length || !liveNodes || !liveNodes.length) return null;
    var need = typeof minScore === 'number' ? minScore : 0.5;

    var root = prefabNodes[0];
    var fileRels = relativePaths(prefabNodes, root.path);
    if (!fileRels.length) return null;
    var fileSet = {};
    for (var i = 0; i < fileRels.length; i++) fileSet[fileRels[i]] = 1;
    var fileCount = fileRels.length;

    var best = null;
    for (var j = 0; j < liveNodes.length; j++) {
        var live = liveNodes[j];
        if (live.name !== root.name) continue;
        var liveRels = relativePaths(liveNodes, live.path);
        if (!liveRels.length) continue;

        var hit = 0;
        for (var k = 0; k < liveRels.length; k++) {
            if (fileSet[liveRels[k]]) hit++;
        }
        var ratioLive = hit / liveRels.length;
        var ratioFile = hit / fileCount;
        var score = Math.min(ratioLive, ratioFile);
        if (score < need) continue;

        if (!best || score > best.score) {
            best = {
                node: live,
                path: live.path,
                nodes: liveRels.length,
                score: Math.round(score * 1000) / 1000,
                ratioLive: Math.round(ratioLive * 1000) / 1000,
                ratioFile: Math.round(ratioFile * 1000) / 1000
            };
        }
    }
    return best;
}

/** 以 rootPath 为根，返回这棵子树里所有节点的"相对路径"（根本身是空串） */
function relativePaths(nodes, rootPath) {
    if (!rootPath) return [];
    var out = [];
    var prefix = rootPath + '/';
    for (var i = 0; i < nodes.length; i++) {
        var p = nodes[i].path;
        if (p === rootPath) out.push('');
        else if (p.indexOf(prefix) === 0) out.push(p.slice(rootPath.length));
    }
    return out;
}

/**
 * 把上面两路信息压成一个结论。
 *
 * 注意两个方向不能混：
 *   fileOnly  → 磁盘有、编辑器内存没有 → **编辑器是旧的**（我们写完了但没重载）
 *   liveOnly  → 编辑器内存有、磁盘没有 → **编辑器里有未保存的改动**（重载会丢）
 * 两者同时存在时，优先报"编辑器有未保存改动"（因为重载有损失）。
 */
function classify(opts) {
    opts = opts || {};
    var ledger = opts.ledger || null;
    var diff = opts.diff || null;
    var openInEditor = opts.openInEditor;

    var out = {
        risk: 'none',
        needsReload: false,
        losesOnReload: 0,
        advice: null
    };

    if (ledger && ledger.tracked && ledger.changed && !ledger.missing) {
        out.risk = 'clobbered';
        out.advice = '这个文件在我们上次写入之后被改过了（' +
            (ledger.mtimeDeltaMs !== null && ledger.mtimeDeltaMs !== undefined
                ? ('mtime 差 ' + Math.round(ledger.mtimeDeltaMs) + 'ms、')
                : '') +
            'size 差 ' + (ledger.sizeDelta || 0) + ' 字节）。' +
            '最可能是你在编辑器里保存了一次 —— 如果是，刚才那批改动已经被覆盖，需要重做。' +
            '接着写之前先确认盘上是你要的版本（read_file / query_scene_tree）。';
    }

    if (diff && !diff.inSync) {
        // liveOnly 有两种来源，必须分开，否则一律当成"用户改了东西"会天天误报：
        //   a) 我们上一批操作**删掉**的节点，编辑器内存里还留着（正常，重载就没了）
        //   b) 用户自己在编辑器里新建的节点（重载会丢，必须拦住）
        // 判据：上一批写入记下的 removed 里有这个 id → 是我们删的。
        var removedSet = {};
        var lastRemoved = (ledger && ledger.lastWrite && ledger.lastWrite.removed) || [];
        for (var ri = 0; ri < lastRemoved.length; ri++) removedSet[lastRemoved[ri]] = 1;

        var staleRemoved = [];
        var userLive = [];
        for (var li = 0; li < diff.liveOnly.length; li++) {
            var item = diff.liveOnly[li];
            if (item.id && removedSet[item.id]) staleRemoved.push(item);
            else userLive.push(item);
        }
        out.staleRemoved = staleRemoved;
        out.unexpectedLive = userLive;

        if (userLive.length) {
            out.risk = 'editor-has-unsaved';
            out.losesOnReload = userLive.length;
            out.needsReload = true;
            out.advice = '编辑器内存里有 ' + userLive.length + ' 个磁盘上从来没有过的节点（' +
                userLive.slice(0, 5).map(function (x) { return x.name; }).join(', ') +
                '）—— 你在编辑器里改了还没保存。**别急着重载**，先在编辑器里 Ctrl+S 存一次，' +
                '或者确认丢弃再传 force:true。';
            return out;
        }
        if (diff.fileOnly.length) {
            out.risk = 'editor-stale';
            out.needsReload = true;
            out.advice = '磁盘上有 ' + diff.fileOnly.length + ' 个编辑器内存里没有的节点（' +
                diff.fileOnly.slice(0, 5).map(function (x) { return x.name; }).join(', ') +
                '）—— 文件是新的、编辑器还是旧的。调 editor_sync {action:"reload"} 让它跟上，' +
                '否则你在编辑器里保存时会把这些改动覆盖掉。';
            return out;
        }
        if (staleRemoved.length) {
            out.risk = 'editor-stale';
            out.needsReload = true;
            out.advice = '我们上一批操作删掉了 ' + staleRemoved.length + ' 个节点，' +
                '但编辑器内存里还显示着它们（' +
                staleRemoved.slice(0, 5).map(function (x) { return x.name; }).join(', ') +
                '）。重载一下就干净了，不会丢东西。';
            return out;
        }
    }

    if (openInEditor === true && !out.advice) {
        out.advice = '编辑器正开着它，但内容和磁盘一致 —— 暂时不用管。';
    }

    return out;
}

module.exports = {
    setContext: setContext,
    ledgerAbs: ledgerAbs,
    readLedger: readLedger,
    recordWrite: recordWrite,
    checkFile: checkFile,
    clearLedger: clearLedger,
    diffNodes: diffNodes,
    findMatchingSubtree: findMatchingSubtree,
    classify: classify
};
