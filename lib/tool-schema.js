'use strict';

/**
 * 工具声明表 —— 纯数据，不含任何逻辑。
 *
 * 每个工具的 name / description / inputSchema 都在这里。
 * description 末尾只追加 **一行** TOOL_FOOTER（也就是"__status 怎么读"这一句，
 * ~110 字），完整的返回约定 TOOL_CONTRACT 走 initialize.instructions，只说一次。
 *
 * 为什么这么切：v0.3.x 把 1967 字节的契约拼进每个工具的描述里，
 * 54 个工具 = 106 KB 的同一段话，占 tools/list 的 68%。工具列表是每会话都要拉的，
 * 纯浪费 —— 而且真正需要"每个工具都看到"的只有那一句语义。
 *
 * **加新工具的流程（3 步）**：
 *   1. 在 TOOLS 里加一条（name / description / inputSchema）
 *   2. 在 main.js 的 IMPL 表里加一条（name → 实现函数）
 *   3. 在 main.js 的 buildAuditProbes() 里加一条（没有副作用的给参数，有的给 null）
 * 漏了第 2 步：启动时告警 + mcp_selftest 报 problem（不会静默变成"未知工具"）
 * 漏了第 3 步：mcp_selftest 报 problem（以前是静默跳过）
 * 最后跑 `node test.js <项目路径>`，它会校验三张表条目数一致。
 *
 * description 写法要求：**说清楚什么时候用我、什么时候别用我、什么时候会空**。
 * 空值不是失败，但 AI 必须知道"空是因为什么"。
 *
 * v0.8.0：30 个旧工具合并成 8 个 cmd 型聚合入口（工具数 50 → 28）。
 * 旧名不在 TOOLS 里，但 main.js 的 RENAMED 表会把它们翻译成"新名 + cmd"，
 * 所以老脚本/老提示词不会突然失效；新增聚合工具时记得同步那张表。
 */

/**
 * 所有"写 .prefab"的工具共用的一段约定。
 *
 * 这段知识以前只散落在 HANDOFF.md 里，但 AI 看不到交接文档 ——
 * 等于没有。所以必须出现在 tools/list 的描述里，让调用方当场就能读到。
 */
var PREFAB_RULES = [
    '',
    '【Prefab 约定】（写 .prefab 必读；完整版见 initialize.instructions）',
    '- [0]=cc.Prefab，data.__id__ 指向根节点；没有 cc.Scene。',
    '- 每个 cc.Node 都要有 _prefab → 自己的 cc.PrefabInfo；fileId 根节点空串、其余 22 位唯一，重写时别换。',
    '- 预制体里节点 _id 一律空串（场景里才要唯一 id）。',
    '- Sprite._spriteFrame 只认 sprite-frame uuid：resolve_asset(path).spriteFrames[0].uuid；填 png 主 uuid 会报 textureLoaded is not a function。',
    '- 组件 __type__ 用 cc.Xxx 或 resolve_asset(脚本路径).compressed；位置缩放都在 _trs 的 10 个数里。',
    '- 写完必须 refresh_assets；更省事用 prefab{cmd:"create"} 或 scene_edit（path 传 .prefab）。'
].join('\n');

var TOOLS = [
    {
        name: 'get_project_info',
        description: '获取当前 Cocos Creator 2.x 项目的基本信息：项目路径、引擎版本、场景文件列表、当前 MCP 端口。任何操作前先调这个确认上下文。',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'list_dir',
        description: '列出项目内某个目录的内容。返回文件名、是否目录、大小。用于在读写前摸清结构。目录不存在会报错；空目录返回空列表且 status=empty。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '相对项目根的路径，如 assets/scene，默认 "."' }
            },
            required: []
        }
    },
    {
        name: 'search_files',
        description: '在项目内做全文搜索，返回 **纯文本**，每行是 文件:行号:内容。读代码前先用它定位，不要靠猜路径逐个 read_file。默认按字面量匹配（不解析正则，要正则传 useRegex），支持 glob 过滤文件类型。找不到时返回空字符串且 status=empty，不是报错。',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '要搜的内容，如 "MiniGame.init"' },
                path: { type: 'string', description: '搜索范围，相对项目根，默认 "assets"' },
                glob: { type: 'string', description: '文件名过滤，如 "*.ts" 或 "*.ts,*.js"。含 / 时按相对路径匹配' },
                context: { type: 'number', description: '每条命中前后各带几行上下文，0-5，默认 0' },
                maxResults: { type: 'number', description: '最多返回多少条，默认 80，上限 300' },
                useRegex: { type: 'boolean', description: '把 pattern 当正则用，默认 false' },
                ignoreCase: { type: 'boolean', description: '忽略大小写，默认 true' },
                includeMeta: { type: 'boolean', description: '是否也搜 .meta 文件，默认 false' }
            },
            required: ['pattern']
        }
    },
    {
        name: 'read_file',
        description: '读取项目内文本文件的内容。返回 **纯文本原文**（不是 JSON），直接读即可。超过 4MB 会拒绝，避免把二进制资源读爆。文件不存在会报错。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '相对项目根的路径' }
            },
            required: ['path']
        }
    },
    {
        name: 'write_file',
        description: '写入项目内文本文件，目录不存在会自动创建。用于改代码、改 .fire / .prefab 的 JSON。' +
            '写 .fire / .prefab 后需要调用 refresh_assets 让编辑器重新导入（不传参即可，会自动刷写过的目录）。' +
            '\n**写 .prefab 时会在落盘前做结构校验**：悬空 __id__、缺 _prefab、fileId 重复、组件 node 回指丢失 → 直接拒绝并指出具体下标；' +
            '覆盖已有预制体时按「父路径+节点名」匹配旧节点、沿用原 fileId，节点身份不会因为整文件重写而丢。' +
            '\n涉及 _spriteFrame 先调 resolve_asset(path) 取 spriteFrames；涉及脚本组件类型用 resolve_asset(scriptPath).compressed。' +
            PREFAB_RULES,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '相对项目根的路径' },
                content: { type: 'string', description: '完整文件内容' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit_file',
        description: '精确替换文件里的某一段内容，其余字节不动。改代码首选这个 —— 不用读全文再拼回去，也不用担心把文件改坏。支持 oldText/newText 精确匹配或正则。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '相对项目根的路径' },
                oldText: { type: 'string', description: '要被替换的原文，必须和文件里逐字符一致（含缩进和换行）' },
                newText: { type: 'string', description: '替换成的新内容' },
                all: { type: 'boolean', description: '是否替换全部匹配，默认只替换第一处' },
                regex: { type: 'boolean', description: '把 oldText 当正则处理，默认 false' },
                count: { type: 'number', description: '期望的匹配数 —— 不符就拒绝写入（防手滑）' }
            },
            required: ['path', 'oldText', 'newText']
        }
    },
    {
        name: 'query_scene_tree',
        description: '解析 .fire 场景或 .prefab 预制体，返回节点树：名称、层级、位置、尺寸、挂载的组件。脚本组件自动反解出 script 路径和 className（不用猜压缩 uuid 是谁），Sprite 直接报出用的哪张图、类型对不对。' +
            '\n传 node 只取该子树；再加 detail: true（或给 depth）会额外返回这个节点的**完整序列化值** —— 位置/缩放/尺寸/锚点/颜色 + 每个组件的 @property 真实值（引用节点和资源会翻译成名字/路径）。' +
            '\n（原 read_scene_node 已并入 detail）',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '相对项目根的 .fire 或 .prefab 路径' },
                maxDepth: { type: 'number', description: '最大展开层级，默认 20' },
                node: { type: 'string', description: '只看某个节点的子树，路径如 "Canvas/bottomUI"，或节点 id' },
                detail: { type: 'boolean', description: '对 node 额外返回完整属性（原 read_scene_node），默认 false' },
                depth: { type: 'number', description: 'detail 的属性展开深度，默认 3，最大 6' }
            },
            required: ['path']
        }
    },
    {
        name: 'mcp_selftest',
        description: '**MCP 自检**：把工具实际跑一遍，检查返回值形态、空值标注、错误信息质量，返回 problems 数组（空的说明 MCP 本身没问题）。**换环境 / 隔段时间再用 / 换了个 AI 之前，先跑一次。**' +
            '\n- 默认（不带 sideEffects）：只跑无副作用的工具，快（≈1 秒），随时可跑。' +
            '\n- sideEffects: true：连有副作用的工具也真跑一遍。**不碰你的真实文件** —— 场景类在 temp/ 的场景副本上做，资源类在 assets/__mcp_probe/ 副本上做，跑完全部删除，并校验真实场景文件 md5 未变（返回 realSceneUntouched 自证）。慢，但完整。' +
            '\n（原 mcp_audit 与 mcp_verify_all 合并：sideEffects 就是它俩的分界）',
        inputSchema: {
            type: 'object',
            properties: {
                sideEffects: { type: 'boolean', description: '连有副作用的工具也跑，默认 false' },
                deep: { type: 'boolean', description: '额外检查错误信息里有没有说下一步该怎么做，默认 false' },
                only: { type: 'array', items: { type: 'string' }, description: '只验这几个工具' },
                cleanup: { type: 'boolean', description: 'sideEffects 跑完是否清理临时资源，默认 true' }
            },
            required: []
        }
    },
    {
        name: 'resolve_asset',
        description: '资源解析总入口：路径 / 完整 uuid / 23 位压缩 uuid 三者互转，并给出类型与可用性。' +
            '\n- 传 input：返回 uuid / compressed / path / kind / exists；图片还会给 spriteFrames —— **这才是能填进 Sprite._spriteFrame 的值**，png 的主 uuid 是 texture，填错渲染时报 textureLoaded is not a function。' +
            '\n- 不传 input：列出项目里所有 sprite-frame（最多 200 条）。' +
            '\n- parts: true 时带上该资源的全部 subMetas（九宫格切边那一层）。' +
            '\n（v0.4.0 旧名 resolve_uuid / resolve_sprite_frame 仍可自动转发）',
        inputSchema: {
            type: 'object',
            properties: {
                input: { type: 'string', description: '路径（assets/...）/ 完整 uuid / 压缩 uuid；不填则列出所有 sprite-frame' },
                uuid: { type: 'string', description: 'input 的别名（旧调用兼容）' },
                path: { type: 'string', description: 'input 的别名（旧调用兼容）' },
                parts: { type: 'boolean', description: '是否带上全部 subMetas，默认 false' }
            },
            required: []
        }
    },
    {
        name: 'run_script',
        description: '在**扩展主进程**里执行 JavaScript，可访问全局 Editor 和 require。万能兜底工具：当成普通函数体写，要返回结果就写 return，支持 async / Promise（会等结果）。' +
            '\n- 给 path：从项目内的 .js 文件读代码执行 —— **长脚本首选这个**，code 是 JSON 字符串，转义层叠容易出错，从文件读就没有这个问题。' +
            '\n- 给 code：直接执行。' +
            '\n注意：无超时保护，await 一个永不 resolve 的 Promise 会挂住请求。' +
            '\n（原 execute_script 与 execute_script_file 合并）',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '脚本文件路径（相对项目根，如 temp/diag.js）；给了就忽略 code' },
                code: { type: 'string', description: '要执行的代码，可含 return，可 await' }
            },
            required: []
        }
    },
    {
        name: 'refresh_assets',
        description: '让编辑器重新导入资源。改完 .fire / .prefab / 图片或新增文件后必须调用，否则编辑器看不到变化。会等导入真正完成再返回。' +
            '\n三种用法：不传参 = 刷「write_file / edit_file 写过但还没刷过」的目录（自动记账，跨目录一次刷完）；' +
            'path = 刷单个；paths = 刷多个。返回值 refreshed 是实际刷了哪些目录，踩空要看它。' +
            '\n为什么会有自动记账：改一个视图往往要同时写 .prefab、.prefab.meta、.ts、.ts.meta，' +
            '它们分散在不同目录，漏刷任一个的表现都是"编辑器里还是旧的"，最难查。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'db:// 开头的资源路径（文件或目录都行，会自动取所在目录）' },
                paths: { type: 'array', items: { type: 'string' }, description: '多个 db:// 路径，与 path 可同时给，合并去重' }
            },
            required: []
        }
    },
    {
        name: 'asset_refs',
        description: '**谁引用了我 / 我引用了谁** —— 删资源、改 uuid 之前必须先问它。' +
            '\n扫 assets 下所有 `.fire` / `.prefab` / `.anim` / `.json` 里的 `__uuid__`，反转成引用索引（按文件 mtime 增量）。' +
            '\n- `direction: "in"`（默认）：谁引用我。`unused: true` 表示没人引用 —— 图片这类资源大概率可以安全删。' +
            '\n- `direction: "out"`：我引用了谁。改这些资源会影响当前文件；`missing: true` 表示引用指向一个已经不存在的 uuid（悬空引用）。' +
            '\n- `both`：两边都要。' +
            '\n同一份资源的主 uuid + 所有 subMetas 都会一起查（引用可能落在 sprite-frame 那个 uuid 上）。',
        inputSchema: {
            type: 'object',
            properties: {
                input: { type: 'string', description: '资源路径（assets/...）/ 完整 uuid / 压缩 uuid' },
                path: { type: 'string', description: 'input 的别名' },
                direction: { type: 'string', description: 'in（谁引用我，默认）/ out（我引用谁）/ both' },
                limit: { type: 'number', description: '每边最多返回多少条，默认 50' }
            },
            required: []
        }
    },
    {
        name: 'project_doctor',
        description: '**项目体检**（只读，不改任何文件）。检查的是项目，不是 MCP —— MCP 自己是 `mcp_selftest` 的事。' +
            '\n专抓那些"**编辑器导入时不报、运行时才炸**"的坑：' +
            '\n- 悬空 `__uuid__`（引用的资源已被删）→ 运行时白图/丢组件' +
            '\n- `Sprite._spriteFrame` 填成了 png 主 uuid（不是 sprite-frame）→ textureLoaded is not a function' +
            '\n- 预制体缺 `_prefab`、fileId 重复、`__id__` 越界、父子互指不一致' +
            '\n- 缺 `.meta`（编辑器不会导入）、孤儿 `.meta`（资源已删，库里留幽灵）' +
            '\n- `includeLayout: true` 时额外跑布局检查（越界 / 压字），噪声大，默认关' +
            '\n改完一批东西、交付前跑一次；问题和修复建议都在 `problems[]` 里。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '只查这个 .fire / .prefab；省略则扫 assets 下的（受 limit 限制）' },
                limit: { type: 'number', description: '全项目扫描最多查多少个文件，默认 120（上限 500）' },
                includeLayout: { type: 'boolean', description: '是否额外跑布局检查（越界/压字），默认 false' },
                fix: {
                    type: 'boolean',
                    description: 'true = 执行自动修复；字符串 "preview" = 只列修复计划不动文件；省略 = 只报告。' +
                        '只修三类安全的：spriteFrame 填成 texture、孤儿 .meta（移到隔离区不删）、缺 .meta（交给编辑器 refresh）'
                }
            },
            required: []
        }
    },
    {
        name: 'editor_sync',
        description: '**磁盘和编辑器内存是不是一回事** —— 这套 MCP 直接改文件，编辑器内存可能是旧的，' +
            '用户下次在编辑器里保存就会把改动覆盖掉，而且没有任何提示。这个工具专门治它。' +
            '\n- `action: "status"`（默认）：报现状，不改任何东西。关键字段：' +
            '\n  · `openInEditor` 编辑器是不是正开着这个文件（按 uuid 比，不是按路径猜）' +
            '\n  · `diff.fileOnly` **磁盘有、编辑器内存没有** → 文件是新的、编辑器是旧的' +
            '\n  · `diff.liveOnly` **编辑器内存有、磁盘没有** → 你在编辑器里改了没保存' +
            '\n  · `ledger.changedSinceLastWrite` 文件在我们上次写入之后被外部改过（大概率是编辑器保存，' +
            '意味着上次那批改动已经被覆盖）' +
            '\n  · `risk`：none / editor-stale / editor-has-unsaved / clobbered，`advice` 说明该怎么办' +
            '\n- `action: "reload"`：让场景面板**重新从磁盘加载**，然后轮询到节点集合对齐才算成功' +
            '（返回 `reloaded` + `verified`）。编辑器内存里有磁盘上不存在的节点时会**拒绝**（重载会丢），' +
            '确认要丢传 `force: true`。' +
            '\n- `action: "clear"`：清台账（`missingOnly: true` 只清文件已不存在的条目）。' +
            '\n**写完 .fire/.prefab 之后，如果返回里 `editor.openInEditor` 是 true，就该调这个 reload。**',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'status（默认）/ reload / clear' },
                path: { type: 'string', description: '.fire / .prefab 路径；省略则用编辑器当前打开的场景' },
                force: { type: 'boolean', description: 'reload 时允许丢弃编辑器内存里未保存的节点，默认 false' },
                refresh: { type: 'boolean', description: 'reload 前先 refresh_assets，默认 true' },
                waitMs: { type: 'number', description: 'reload 后等对齐的最长毫秒数，默认 8000（上限 30000）' },
                missingOnly: { type: 'boolean', description: 'clear 时只清「文件已不存在」的条目' }
            },
            required: []
        }
    },
    {
        name: 'scene_capture',
        description: '**截一张编辑器场景视图的图**，存到 temp/mcp-state/shots/ 并返回路径。' +
            '\n用途：`prefab{cmd:"check-layout"}` 算的是"几何上不重叠"（算出来的对），截图给的是"看起来的对" —— ' +
            '九宫格切边画错、图片拉伸、字体没生效、文字压图，这些几何全都过、肉眼一看就废。' +
            '\n**默认给干净画面**（clean:true）：临时关掉场景里的网格 / 设计分辨率框 / gizmo 节点，' +
            '隐藏界面上的坐标标尺、节点标签、以及预制体编辑态浮在画布里的「PREFAB 保存/关闭」悬浮条，' +
            '并裁掉顶部工具栏；截完立刻全部恢复，不碰文件也不改用户设置。clean:false 才截编辑器原样。' +
            '\n截的是**编辑器里当前显示的样子**，不是游戏运行画面。' +
            '编辑器里没打开对应场景时直接报错，不返回空白图。' +
            '\n典型用法：`editor_sync {action:"reload"}` 让编辑器跟上 → `scene_capture` 看一眼 → ' +
            '发现问题再用 `query_scene_tree` / `prefab{cmd:"check-layout"}` 定位到具体节点。' +
            '\n返回里 `cleanHidden` / `cleanDomHidden` 列出这次实际关掉了什么，' +
            '`file` 是相对项目根的路径，直接用 ViewImage / present_files 打开看。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '可选，校验编辑器里打开的是不是这个 .fire；不一致会报错' },
                clean: { type: 'boolean', description: '默认 true：临时关掉网格/gizmo/界面叠加层（含预制体「保存/关闭」悬浮条）并裁掉顶部工具栏，截完恢复；false 截编辑器原样' }
            },
            required: []
        }
    },
    {
        name: 'list_open_projects',
        description: '列出本机所有打开着的 Cocos 2.x 项目及其 MCP 端口，并标出当前目标项目。多个项目同时开着时，用 set_target_project 指定要操作哪个——之后所有调用都会转发过去，客户端连的是哪个端口就不重要了。',
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'set_target_project',
        description: '指定 AI 要操作哪个项目（多开编辑器时用）。设置之后，所有 MCP 调用都会自动转发到该项目所在的端口，不用改 mcp.json。传项目名或端口都行。',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '项目名（目录名），如 bottle_new' },
                port: { type: 'number', description: 'MCP 端口，如 25901' }
            },
            required: []
        }
    },
    {
        name: 'hub_control',
        description: '开启/关闭/查询中继服务。中继是独立于编辑器的常驻进程，固定占一个端口，让 mcp.json 指向它——这样不管开几个编辑器、客户端连的那个在不在，AI 都能找到真正要操作的项目。',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'start / stop / status，默认 status' },
                port: { type: 'number', description: '中继端口，默认 25800' }
            },
            required: []
        }
    },
    {
        name: 'scene_diagnose',
        description: '场景/预制体诊断。默认报告文件层与通道状态：当前文件、对象数、根类型（scene/prefab）、能否找到可克隆的空节点模板、场景脚本是否注册、场景进程通不通。**scene_* 报错时先跑这个。**' +
            '\nprobe: true 改成探测**场景进程的能力**：能不能 require / 写文件 / 发 HTTP / Editor.Message 在不在，用于诊断"场景脚本只收不回"。' +
            '\n（原 scene_ping 与 scene_probe 合并）',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '可选，直接指定 .fire / .prefab 路径；省略则用编辑器当前打开的场景' },
                probe: { type: 'boolean', description: 'true = 探测场景进程能力（原 scene_probe），默认 false' },
                skipSceneScript: { type: 'boolean', description: '跳过场景进程探测，只看文件层信息' },
                timeout: { type: 'number', description: 'probe 时等场景进程响应的毫秒数，默认 8000' }
            },
            required: []
        }
    },
    {
        name: 'scene_create',
        description: '新建一个空场景（.fire + .meta）并导入，支持从零搭建工程。' +
            '\n- 项目里有 .fire：克隆已有场景的 [0] 与场景根，字段和默认值跟引擎一致。' +
            '\n- 项目里没有 .fire：用内置引擎同款模板直接产出 SceneAsset + Scene + Canvas + Main Camera，不再要求先手工建场景。' +
            '\n- 默认补 Canvas、自动写入 start-scene 与设计分辨率；返回的 uuid 以编辑器导入后的 .meta 为准（会回读对齐）。',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '新场景路径，必须以 .fire 结尾，如 assets/scene/New.fire' },
                canvas: { type: 'array', items: { type: 'number' }, description: '设计分辨率 [w,h]，默认 [960,640]' },
                withCanvas: { type: 'boolean', description: '是否保证场景里有 Canvas + Main Camera，默认 true' },
                startScene: { type: 'boolean', description: '是否自动设为启动场景并写设计分辨率，默认 true' }
            },
            required: ['path']
        }
    },
    {
        name: "scene_edit",
        description: "cmd 型入口（必填 cmd）：场景 / 预制体的**唯一编辑入口**：8 种 cmd 覆盖增节点、删节点、移节点、改属性、加/删/改组件、批量操作。\npath 直接传 .fire 或 .prefab（省略则用编辑器当前打开的场景）。\n- add-node：新建空节点（parent/name/position），或 from=prefab 拷预制体（prefab/parent/name）\n- remove-node：删节点（node），连子孙、组件、PrefabInfo 一起删；有外部引用会拒绝\n- move-node：换父 / 调同级顺序（node/newParent/index）\n- set-props：改节点属性（node + name/position/active/scale/opacity/size/anchor）\n- add-component / remove-component：加 / 删组件（node/type）\n- set-component-props：改组件字段（node/type/props）\n- apply：一次写多个改动（ops 数组），同一文件改 3 处以上用它最省；dryRun 只试算不写盘\n写盘前跑结构校验，写完落盘；改完记得 refresh_assets。" + PREFAB_RULES,
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["add-node","remove-node","move-node","set-props","add-component","remove-component","set-component-props","apply"],"description":"要做的动作：add-node / remove-node / move-node / set-props / add-component / remove-component / set-component-props / apply。必填；旧工具名调用时会自动补上。"},
                "from": {"type":"string","description":"省略 = 新建空节点；\"prefab\" = 从预制体拷一个进来"},
                "prefab": {"type":"string","description":"from=prefab 时的预制体路径，如 assets/ui/Panel.prefab"},
                "parent": {"type":"string","description":"父节点路径，如 \"Canvas\" 或 \"Canvas/bottomUI\"；省略则挂到根（场景写 \"Scene\"，预制体写 \"Root\" 或直接省略）"},
                "name": {"type":"string","description":"新节点/根节点名字，默认 NewNode（from=prefab 时默认用预制体里的名字）（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "position": {"type":"object","description":"可选，节点位置 {x,y,z}（仅空节点）（不同 cmd 下含义略有差别，按对应 cmd 的用法传）","properties":{"x":{"type":"number"},"y":{"type":"number"},"z":{"type":"number"}}},
                "path": {"type":"string","description":"可选，直接指定 .fire 或 .prefab 路径；省略则用编辑器当前打开的场景（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "node": {"type":"string","description":"节点路径，如 \"Canvas/topUI\"，或节点 id（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "newParent": {"type":"string","description":"新的父节点：写根算起的完整路径，或用同级节点的名字（\"挂到 Main Camera 下\"）；写 \"Scene\" / \"Root\" 表示移到根下"},
                "index": {"type":"number","description":"插入到新父节点 _children 的第几位，默认末尾"},
                "active": {"type":"boolean","description":"显隐"},
                "scale": {"type":"object","description":"缩放 {x,y}","properties":{"x":{"type":"number"},"y":{"type":"number"}}},
                "opacity": {"type":"number","description":"不透明度 0-255"},
                "size": {"type":"object","description":"尺寸 {width,height}","properties":{"width":{"type":"number"},"height":{"type":"number"}}},
                "anchor": {"type":"object","description":"锚点 {x,y}，0-1","properties":{"x":{"type":"number"},"y":{"type":"number"}}},
                "type": {"type":"string","description":"组件类型：cc.Sprite / 脚本路径（assets/xxx/Foo.ts）/ uuid / 脚本类名（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "props": {"type":"object","description":"要覆盖的字段，如 {\"_spriteFrame\":{\"asset\":\"assets/ui/a.png\"}}（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "enabled": {"type":"boolean","description":"是否启用，默认 true"},
                "ops": {"type":"array","description":"操作数组，按顺序应用。例：[{\"op\":\"addNode\",\"parent\":\"panel\",\"name\":\"title\"},{\"op\":\"setProps\",\"node\":\"panel/title\",\"position\":{\"x\":0,\"y\":500}}]","items":{"type":"object"}},
                "dryRun": {"type":"boolean","description":"只试算不写盘，返回会变成什么样 + 结构校验结果，默认 false"}
            },
            required: ['cmd']
        }
    },
    {
        name: "asset",
        description: "cmd 型入口（必填 cmd）：资源与 .meta 的统一入口。路径相对项目根，也认 db://assets/... 写法。\n- query：按通配符找资源（pattern/type/limit），返回 uuid 与路径；找不到返回空列表\n- move：移动 / 改名（from/to），会同步改引用\n- delete：删除（path + confirm:true；不传 confirm 不会真删）\n- meta-get：读 .meta（path/keys），返回**纯文本**\n- meta-set：改 .meta（path/props/subMetas）；uuid 等只读字段会被拒绝",
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["query","move","delete","meta-get","meta-set"],"description":"要做的动作：query / move / delete / meta-get / meta-set。必填；旧工具名调用时会自动补上。"},
                "pattern": {"type":"string","description":"通配符，如 db://assets/**/*.png，默认 db://assets/**"},
                "type": {"type":"string","description":"按资源类型过滤，如 texture / sprite-frame / prefab / scene"},
                "limit": {"type":"number","description":"最多返回多少条，默认 200"},
                "from": {"type":"string","description":"源路径，db:// 或项目内路径"},
                "to": {"type":"string","description":"目标路径"},
                "path": {"type":"string","description":"要删的资源路径（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "confirm": {"type":"boolean","description":"必须传 true 才会执行"},
                "keys": {"type":"array","description":"只看这几个字段（可选）","items":{"type":"string"}},
                "props": {"type":"object","description":"要改的设置，如 {\"packable\":false,\"filterMode\":\"nearest\"}"},
                "subMetas": {"type":"object","description":"子资源设置，如 {\"图名\":{\"borderTop\":8,\"borderBottom\":8}}"}
            },
            required: ['cmd']
        }
    },
    {
        name: "prefab",
        description: "cmd 型入口（必填 cmd）：预制体的建 / 查 / 比。\n- create：from=spec（默认）按描述造一个（path/root/script/mask/template），或 from=node 把场景节点固化（node/scene/prefab）\n- check-layout：查重叠 / 越界 / 尺寸异常（path/canvas/tolerance），不用截图也能定位到节点名\n- diff：两个 .fire/.prefab 的**节点级**差异（a=新文件，b 或 against=基准，limit），返回 added/removed/changed/renamed；不是字节 diff" + PREFAB_RULES,
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["create","check-layout","diff"],"description":"要做的动作：create / check-layout / diff。必填；旧工具名调用时会自动补上。"},
                "from": {"type":"string","description":"spec（默认）/ node"},
                "path": {"type":"string","description":"spec 模式：输出路径，assets 下、.prefab 结尾，如 assets/ui/Foo.prefab（已存在会拒绝）（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "prefab": {"type":"string","description":"node 模式：输出路径，必须以 .prefab 结尾"},
                "node": {"type":"string","description":"node 模式：要导出的节点路径，如 \"Canvas/panel\""},
                "scene": {"type":"string","description":"node 模式：源场景 .fire 路径；省略用编辑器当前打开的场景"},
                "root": {"type":"object","description":"spec 模式的根节点，如 {\"name\":\"Foo\",\"size\":[750,1334],\"sprite\":\"assets/ui/bg.png\",\"children\":[{\"name\":\"title\",\"pos\":[0,500],\"size\":[400,60],\"label\":\"标题\"}]}"},
                "script": {"type":"string","description":"spec 模式：根节点要挂的脚本路径，如 assets/scripts/views/Foo.ts"},
                "mask": {"type":"boolean","description":"spec 模式：给根节点挂 cc.Mask（全屏遮罩那个常见做法），默认 false"},
                "template": {"type":"string","description":"可选，优先从这个 .prefab / .fire 克隆节点和组件模板"},
                "canvas": {"type":"array","items":{"type":"number"},"description":"画布尺寸 [w,h]，省略则用根节点/Canvas 的尺寸，再兜底 750x1334"},
                "tolerance": {"type":"number","description":"容差像素，默认 1（差 1px 不算越界/重叠）"},
                "a": {"type":"string","description":"新文件路径（也可用 path）"},
                "b": {"type":"string","description":"对比基准文件路径（也可用 against）"},
                "against": {"type":"string","description":"b 的别名"},
                "limit": {"type":"number","description":"每类最多返回多少条，默认 50"}
            },
            required: ['cmd']
        }
    },
    {
        name: "build",
        description: "cmd 型入口（必填 cmd）：构建相关三件事。\n- targets：列出可用平台与当前配置（无参数）\n- start：开始构建（platform 必填，另有 buildPath/scenes/startScene/debug/md5Cache）\n- status：查构建进度 / 结果（无参数）\n构建前先 `editor {cmd:\"compile-status\"}` 确认脚本产物比源码新，stale 会打进旧代码。",
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["targets","start","status"],"description":"要做的动作：targets / start / status。必填；旧工具名调用时会自动补上。"},
                "platform": {"type":"string","description":"目标平台，如 web-mobile / wechatgame，省略则用项目配置里保存的"},
                "buildPath": {"type":"string","description":"输出目录（项目内相对路径），省略用配置里的"},
                "scenes": {"type":"array","description":"参与构建的场景列表（相对路径）","items":{"type":"string"}},
                "startScene": {"type":"string","description":"启动场景"},
                "debug": {"type":"boolean","description":"是否 debug 构建"},
                "md5Cache": {"type":"boolean","description":"是否开 md5 缓存"}
            },
            required: ['cmd']
        }
    },
    {
        name: "project_settings",
        description: "cmd 型入口（必填 cmd）：项目设置的读与写。profile 默认 project://projectSettings.json。\n- get：读设置（profile/keys；省略 keys 返回全部）\n- set：改设置（profile/settings 键值对）\n写之前先 get 看清楚有哪些键，别凭猜。",
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["get","set"],"description":"要做的动作：get / set。必填；旧工具名调用时会自动补上。"},
                "profile": {"type":"string","description":"profile 地址，默认 project://project.json（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "keys": {"type":"array","description":"只看这几个键","items":{"type":"string"}},
                "settings": {"type":"object","description":"要改的键值对，如 {\"design-resolution-width\":750,\"design-resolution-height\":1334}"}
            },
            required: ['cmd']
        }
    },
    {
        name: "runtime",
        description: "cmd 型入口（必填 cmd）：运行时观测统一入口。注意：`action` 是 inject 自己的子命令，外层分发一律用 `cmd`。\n- info：编辑器 / 预览 / 构建三条通道的连接状态（无参数）\n- read：读活场景节点树与属性（node/maxDepth/maxNodes/props/includeComponents/onlyNonDefault）\n- eval：在场景脚本里执行 JS（code 多语句可 return，或 expr 单表达式）\n- report：读运行时上报（source=scene|preview|build，另有 since/limit/level/maxAge/history/tree）\n- inject：给构建产物注入上报脚本（action=status|inject|remove，buildRoot/interval）\n三种 source 互不相通，问错来源只会得到空。",
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["info","read","eval","report","inject"],"description":"要做的动作：info / read / eval / report / inject。必填；旧工具名调用时会自动补上。"},
                "node": {"type":"string","description":"只读这个节点，如 \"Canvas/topUI\"；省略则读整棵树"},
                "maxDepth": {"type":"number","description":"树深度，默认 3"},
                "maxNodes": {"type":"number","description":"最多读多少节点，默认 200"},
                "props": {"type":"array","items":{"type":"string"},"description":"只读这些属性；不给则读所有公开属性"},
                "includeComponents": {"type":"boolean","description":"是否读组件，默认 true"},
                "onlyNonDefault": {"type":"boolean","description":"只报告和默认值不同的属性（脚本在运行时改过的痕迹），默认 false"},
                "sceneMethod": {"type":"string","description":"场景脚本里的方法名，默认 runtimeRead。一般不用填"},
                "code": {"type":"string","description":"要执行的 JS 代码，可多语句，可 return"},
                "expr": {"type":"string","description":"单个表达式，如 \"cc.director.getScene().name\"（与 code 二选一）"},
                "source": {"type":"string","description":"scene / preview / build，默认 scene"},
                "since": {"type":"number","description":"scene：只要这个时间戳之后的（毫秒），默认全部"},
                "limit": {"type":"number","description":"最多返回几条，默认 50"},
                "level": {"type":"string","description":"scene：只取某个级别 log / warn / error"},
                "maxAge": {"type":"number","description":"preview / build：超过多少毫秒算过期，默认 15000 / 20000"},
                "history": {"type":"boolean","description":"build：是否带上历史摘要，默认 false"},
                "tree": {"type":"boolean","description":"preview：是否带上场景树，默认 true"},
                "action": {"type":"string","description":"status（默认）/ inject / remove"},
                "buildRoot": {"type":"string","description":"构建目录，默认项目下的 build"},
                "interval": {"type":"number","description":"上报间隔毫秒，默认 2000"}
            },
            required: ['cmd']
        }
    },
    {
        name: "preview",
        description: "cmd 型入口（必填 cmd）：Web 预览的控制与指令。注意：`action` 是内层指令名，外层分发一律用 `cmd`。\n- control：启停预览（action=start|stop|open|bridge|status，open 控制是否自动开窗口）\n- command：向预览页发指令（action=ping|eval|read|click|dispatch|module|script|fguiClick|fguiTree...，另有 path/expr/method/args/code/timeout 等）\n预览没起来时 command 会明确报错，不会静默返回空。",
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["control","command"],"description":"要做的动作：control / command。必填；旧工具名调用时会自动补上。"},
                "action": {"type":"string","description":"start / stop / open / bridge / status，默认 status（不同 cmd 下含义略有差别，按对应 cmd 的用法传）"},
                "open": {"type":"boolean","description":"start 时是否自动开窗口，默认 true。设 false 只起服务不开窗口"},
                "path": {"type":"string","description":"节点路径（相对场景根），read/click/dispatchTouch 要用"},
                "expr": {"type":"string","description":"要求值的 JS 表达式，eval 要用"},
                "method": {"type":"string","description":"要调用的方法名，click 可选（不给就自动找 onXxx）"},
                "arg": {"description":"传给方法的参数，可选"},
                "args": {"type":"array","description":"module 动作要传的参数数组"},
                "module": {"type":"string","description":"module 动作要加载的模块路径，如 ./assets/game/scripts/game/datas/KeyData"},
                "code": {"type":"string","description":"script 动作要执行的 JS 源码（多语句）"},
                "type": {"type":"string","description":"fguiClick 动作：只点这种类型的对象，如 GButton"},
                "index": {"type":"number","description":"fguiClick 动作：同名对象取第几个，默认 0"},
                "depth": {"type":"number","description":"fguiTree 动作：遍历深度，默认 8"},
                "filter": {"type":"string","description":"fguiTree 动作：只显示名字/类型含这个关键词的"},
                "timeout": {"type":"number","description":"等结果的超时毫秒，默认 12000"}
            },
            required: ['cmd']
        }
    },
    {
        name: "editor",
        description: "cmd 型入口（必填 cmd）：编辑器状态查询。\n- log：读编辑器日志末尾几行（lines/keyword/level），返回**纯文本**\n- compile-status：检查 .ts 编译产物是否比源码新（paths/since/all/waitMs）；stale 就别构建",
        inputSchema: {
            type: 'object',
            properties: {
                "cmd": {"type":"string","enum":["log","compile-status"],"description":"要做的动作：log / compile-status。必填；旧工具名调用时会自动补上。"},
                "lines": {"type":"number","description":"读取末尾多少行，默认 80，最大 500"},
                "keyword": {"type":"string","description":"只保留包含该关键字的行（不区分大小写）"},
                "level": {"type":"string","description":"all / error / warn，默认 all"},
                "paths": {"type":"array","items":{"type":"string"},"description":"只看这几个脚本（相对项目根）；省略则扫 assets 下全部 .ts/.js"},
                "since": {"type":"number","description":"只报这个时间戳（毫秒）之后改过的源码，配合\"我刚改了哪几个\"用"},
                "all": {"type":"boolean","description":"扫描模式下是否连 ok 的也列出来，默认 false（只列有问题的）"},
                "waitMs": {"type":"number","description":"等编译完成最多多少毫秒（轮询到全部 ok 或超时），默认 0 = 只看当前快照。改完 .ts 要构建时传个 15000"}
            },
            required: ['cmd']
        }
    }
];
/**
 * 完整返回约定 —— **只进 initialize.instructions**，不再逐个工具重复。
 *
 * 之前这段被拼进每个 tool.description：54 个工具 = 106 KB 的同一段话，
 * 占 tools/list 总量的 68%。客户端的工具列表每会话都要拉一遍，纯浪费。
 */
var TOOL_CONTRACT = [
    '【返回约定】',
    '- __status: "ok" = 有数据；"empty" = 正常但当前没有数据；"partial" = 部分字段为空。',
    '  __status=empty/partial 时，__emptyFields 列出哪些字段是空的，__reason 说明为什么空。',
    '  **空值不等于调用失败** —— 大多数工具在"当前无数据"时会返回空字段而不是报错。',
    '- 真正失败会直接报错（error），错误信息里包含原因和下一步该怎么做。',
    '- 约定字段都带 __ 前缀（__status/__emptyFields/__reason/__hint），不会和业务字段冲突。',
    '- 需要文件/日志内容的工具（read_file、search_files、editor{cmd:"log"}、asset{cmd:"meta-get"}）',
    '  返回的是**纯文本原文**，不是 JSON —— 直接读即可，不用解析。',
    '- 资源标识一律用 path（相对项目根，如 "assets/game/x.prefab"）；',
    '  只有 asset{cmd:"query"} / search_files 用 pattern（搜索模式）。',
    '- 改完 .fire / .prefab 后要调 refresh_assets 让编辑器重新导入（不传参会自动刷写过的目录）。',
    '',
    '【Prefab 约定（完整版）】',
    '- 根是 [0]=cc.Prefab，data.__id__ 指向根节点；**没有 cc.Scene**。',
    '- 每个 cc.Node 都必须有 _prefab 指向自己的 cc.PrefabInfo；缺了编辑器能打开，一保存就坏。',
    '- PrefabInfo.fileId：根节点是空串，其余 22 位且唯一（节点身份凭据，重写时不能瞎换）。',
    '- 节点 _id 在预制体里一律空串（场景里才要唯一 id）。',
    '- Sprite._spriteFrame 只认 sprite-frame 的 uuid；填 png 主 uuid 会报 textureLoaded is not a function。',
    '- 组件 __type__ 用 cc.Xxx，或脚本的压缩 uuid（resolve_asset(脚本路径).compressed）。',
    '- _trs = [x, y, z, qx, qy, qz, qw, sx, sy, sz]，位置和缩放都在这里，别另造字段。',
    '- 写完必须 refresh_assets（不传参会自动刷"写过但没刷"的目录）。',
    '',
    '【合并工具怎么调】',
    'scene_edit / asset / prefab / build / project_settings / runtime / preview / editor 这 8 个是聚合入口，',
    '**必须传 cmd** 指定动作（每个工具描述里列了全部 cmd 及各自参数）。',
    'v0.8.0 之前的 30 个旧工具名仍然可调用，会自动翻译成"新名 + cmd"并在返回里带 __renamedFrom，',
    '但请优先用新名 —— 旧名只是兼容层，不在 tools/list 里。',
    '',
    '【常见链路：别靠猜，按这个顺序找工具】',
    '- 造一个预制体：prefab{cmd:"create", from:"spec"}（只给图片 / 脚本路径）',
    '  → prefab{cmd:"check-layout"} 查重叠越界 → refresh_assets → query_scene_tree 读回确认。',
    '- 改已有预制体：query_scene_tree 看结构 → scene_edit（path 直接传 .prefab）',
    '  → 需要整段重写才用 write_file（它会做结构校验、保住 fileId）。',
    '- 把预制体放进场景：scene_edit{cmd:"add-node", from:"prefab"}；固化节点：prefab{cmd:"create", from:"node"}。',
    '- 图片填进 Sprite：resolve_asset(path) 取 spriteFrames[0].uuid（**不要**用 png 主 uuid）。',
    '- 脚本组件的类型：把脚本路径直接当 type 传，或用 resolve_asset(scriptPath).compressed。',
    '- 改完 .ts 要构建前：editor{cmd:"compile-status"} 确认产物比源码新；再 build{cmd:"start"}。',
    '- 读运行时先分清来源：编辑器内用 runtime{cmd:"eval"|"read"}；',
    '  Web 预览用 runtime{cmd:"report", source:"preview"} + preview{cmd:"command"}；',
    '  构建产物用 runtime{cmd:"report", source:"build"}。三者互不相通，问错来源只会得到空。'
].join('\n');


/**
 * 跟着每个工具走的一行脚注。
 *
 * 为什么留这一行：有些客户端不把 instructions 传给模型。
 * 一句话保证「__status 怎么读」这条最关键的语义永远到得了；
 * 完整约定（字段含义、推荐链路）只在 instructions 里说一次。
 */
var TOOL_FOOTER = '\n\n【返回约定】__status: ok / empty / partial；空值≠失败，看 __reason 与 __emptyFields；真正失败会直接报错。完整约定与推荐链路见服务端 instructions。';

module.exports = {
    TOOLS: TOOLS,
    TOOL_CONTRACT: TOOL_CONTRACT,
    TOOL_FOOTER: TOOL_FOOTER
};
