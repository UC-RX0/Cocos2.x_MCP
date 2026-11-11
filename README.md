# cocos-mcp-2x

**简体中文** | [English](README.en.md)

> Cocos Creator **2.x** 的 MCP 服务端 —— 让 AI 直接读写项目文件、增删改场景与预制体、启动引擎 Web 预览并**真的把游戏玩一遍**。

`v0.8.0` · 28 个工具 · 面向 **Cocos Creator 2.4.x**（开发验证环境 2.4.15）· MIT

Cocos Creator 3.x 的扩展 API 与 2.x 完全不同（`Editor.Message` 取代了 `Editor.Ipc`，场景是纯 3D 结构），
本仓库**只管 2.x**，不要混用。

---

## 目录

- [它能做什么](#它能做什么)
- [30 秒上手](#30-秒上手)
- [核心思想](#核心思想)
- [架构与代码结构](#架构与代码结构)
- [工具速查（28 个）](#工具速查28-个)
- [实战：从零搭一个能跑的工程](#实战从零搭一个能跑的工程)
- [实战：改场景 / 改预制体](#实战改场景--改预制体)
- [实战：试玩一个游戏](#实战试玩一个游戏)
- [返回约定](#返回约定)
- [部署](#部署)
- [测试与自检](#测试与自检)
- [常见报错与处理](#常见报错与处理)
- [兼容性与已知限制](#兼容性与已知限制)

---

## 它能做什么

| 能力 | 靠什么工具 | 为什么这件事重要 |
|---|---|---|
| **读写项目文件** | `read_file` `write_file` `edit_file` `search_files` | 写 `.prefab` 时做结构校验、保住 `fileId`、保持原换行风格 |
| **读场景结构** | `query_scene_tree` `scene_capture` | 不打开编辑器也能知道场景里有什么、长什么样 |
| **造场景** | `scene_create` | **空项目也能起**：内置引擎同款模板，直接产出 SceneAsset + Scene + Canvas + Main Camera |
| **造预制体** | `prefab` `cmd:create` | 声明式 spec：图片只给路径、脚本只给路径，序列化细节全包 |
| **改节点 / 组件** | `scene_edit`（8 个 cmd） | 批量事务 + `dryRun`，20 个节点一次写盘 |
| **检查布局** | `prefab` `cmd:check-layout` | 不截图就能发现「文字压在图标上」「越出画布」 |
| **项目体检** | `project_doctor` | 抓编辑器导入不报、运行时才炸的问题（悬空 uuid、错 spriteFrame、孤儿 meta） |
| **跑起来看** | `preview` `runtime` | 走即时编译，改完 `.ts` 刷新页面就是新的，**不用打包** |
| **真的玩一遍** | `preview` `cmd:command` | 点按钮、派发触摸、读状态、抓 console、截图 |
| **一致性自检** | `mcp_selftest` | 三张表（声明 / 实现 / 探针）必须一一对应，漏登记直接进 `problems` |

设计目标是**可验证的自动化**：不是"发出指令就算成功"，而是每一步都能回读证据
（`verified: true`、`errorTotal: 0`、8/8 断言通过）。

---

## 30 秒上手

### 1. 部署扩展

扩展是**全局安装**的，所有 2.x 项目共用一份：

```bash
cd <本仓库目录>
node deploy.js
```

部署到 `~/.CocosCreator/packages/cocos-mcp-2x/`（该目录不存在时自动回退 `.../packages/mcp/`，
即编辑器实际加载的那个）。详见[部署](#部署)。

### 2. 打开编辑器

Cocos Creator 2.x 会自动加载全局扩展。启动后菜单栏出现 **扩展 / Cocos MCP 2.x**：

| 菜单项 | 作用 |
|---|---|
| 状态与端口 | 当前实例跑在哪个端口、目标项目是谁 |
| 列出已打开项目 | 本机所有开着编辑器的项目 |
| 开启 / 停止中继服务 | 中继是常驻进程，编辑器关了链路也在 |
| 切换目标项目 | 轮换 AI 操作的项目 |
| 重启服务 | 改了 `main.js` 后热重启 |

### 3. 配置 MCP 客户端

`~/.workbuddy/mcp.json`（Claude Desktop / Cursor 等同理）：

```json
{
  "mcpServers": {
    "cocos-mcp-2x": {
      "type": "http",
      "url": "http://127.0.0.1:25800/mcp"
    }
  }
}
```

**指向 25800（中继），不要指向编辑器的 25900。**

编辑器端口按启动顺序分配（25900、25901…），一重启就可能互换 —— 写死编辑器端口会指错项目。
中继常驻，每次请求都按**项目身份**（不是端口）解析目标，所以永远指得对。

### 4. 验证

```bash
node dev-client.js 25800 get_project_info
node dev-client.js 25800 mcp_selftest
```

看到项目路径、引擎版本、`problems: []` 就成了。

---

## 核心思想

这九条是整套工具的行为来源，出问题时先回来对一遍。

### 1. 文件层优先，能不碰编辑器 IPC 就不碰

`.fire` / `.prefab` 是纯 JSON。文件层能做的事比编辑器私有 API 还多：可 diff、可离线测、
可在编辑器没开的时候跑、失败不会留下半改的内存状态。

所以 8 个写盘的 `scene_edit` 走的是 `writeRoute: 'file'` ——
**直改磁盘 JSON，不依赖场景脚本通道**。场景脚本只用于「必须访问活对象」的场合（读运行时属性、执行 JS）。

### 2. 空值 ≠ 失败

每个工具的返回都带 `__status` / `__emptyFields` / `__reason` / `__hint`：

- `empty` 是**正常结果**（"这个目录下没有匹配文件"），不是错误
- 真正失败才抛错，且错误信息必须写清**原因 + 下一步**
- 约定字段一律带 `__` 前缀，不会和业务字段撞名（`preview` 的 `status` 是 HTTP 码）

`tools/list` 里每个工具的描述都自动追加这份约定 —— 光看描述就知道该怎么解读返回值，不用试错。

### 3. 协议面收敛，行为不变

v0.8.0 把 30 个「同一动作域」的工具并成 8 个 `cmd` 型入口（50 → 28），`tools/list` 载荷缩了约三分之一。
`dispatchByCmd` 只做两件事：按 `cmd` 挑原实现、把 `cmd` 从参数里摘掉。
**原实现一行没改** —— 合并只动入口不动行为，回归测试才能证明等价。

旧的 46 个工具名仍然可调用，`callTool` 沿 `RENAMED` 链自动翻译（最多 2 跳，防环 4 跳），
返回里带 `__renamedFrom` / `__hops` / `__hint` 提示改口。**老脚本、老提示词不会突然失效。**

### 4. 决不手写 `.meta`

`.meta` 是 AssetDB 的身份（`uuid` / `importer` / `subMetas`），手写等于给项目换身份。
缺 `.meta` 时正确做法是对所在目录 `refresh_assets`，让编辑器自己生成。

同理：**自分配 uuid 是错的**。`prefab` `cmd:create` 先写文件，等导入完成再回读 `.meta` 的真实 uuid，
把文件里两处引用改齐 —— 否则 `project_doctor` 会报悬空 uuid。

### 5. 写入台账：谁动过这个文件

每次写盘记下那一刻的 mtime / size / 节点 id 到 `temp/mcp-state/ledger.json`。
下次写之前比一下：

| 情况 | 判定 | 该怎么办 |
|---|---|---|
| 磁盘有、内存没有 | `diff.fileOnly` | 文件是新的 → `editor_sync` reload |
| 内存有、磁盘没有（刚删的） | `risk: editor-stale` | 重载无损 |
| 内存有、磁盘没有（你建的） | `risk: editor-has-unsaved` | 重载会丢，先 Ctrl+S |
| 上次写入后被改过 | `risk: clobbered` | 上一批改动已被覆盖，要重做 |

台账放在 `temp/`，不进 `assets`、不会被导入、git 里本来就忽略。

### 6. 不手搓序列化对象

克隆场景里已有的同类对象再改字段。`_trs` / `_color` / `_contentSize` / `_anchorPoint` / `_objFlags`
一律继承引擎值 —— 这些字段的手工值极易和引擎版本对不上（`_trs` 是 10 元素 TypedArray，
顺序错一位就是位置错乱，而且不报错）。

### 7. 写盘保留原文件格式

CRLF 项目不能被写成 LF，否则 git diff 全量重写、版本历史废掉。
`write_file` / `edit_file` 都先读原文件判断换行风格再对齐写入。

### 8. 删对象必须全局重映射 `__id__`

序列化文件里删一个对象会让后面所有 `__id__` 平移。所以先摘掉父节点 `_children` 里的引用，
再扫全文件外部引用，**有残留就整体拒绝**，不写半坏场景。

### 9. 部署也是一次可验证操作

`deploy.js` 部署前做两件事：**语法预检**（`vm.Script` 编译，语法错直接拒绝，否则扩展开机就崩、
报错信息还跟真实原因对不上）、**冲突检测**（部署目录被别处改过就停下报告，除非 `--force`）。

---

## 架构与代码结构

### 全景

```
┌─────────────────────────────────────────────────────┐
│ 客户端 (mcp.json)                                    │
│   "url": "http://127.0.0.1:25800/mcp"                │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────┐
│ hub.js —— 常驻中继（独立进程，编辑器关了也在）        │
│   每次请求读 target.json → 解析项目身份 → 转发        │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌────────────────┐          ┌────────────────┐
│ 编辑器 A (25900)│          │ 编辑器 B (25901)│
│  main.js 扩展   │          │  main.js 扩展   │
└────────┬───────┘          └────────┬───────┘
         │                           │
         ├─→ 文件层     → .fire / .prefab / assets（最可靠）
         ├─→ 场景脚本   → scene.js（渲染进程，能用 cc）
         ├─→ 预览服务   → PreviewServer → bridge.js（浏览器侧）
         └─→ 构建产物   → injector.js → inject-runtime.js（浏览器侧）
```

### 四条通道，读的东西不一样

**这是最容易搞混的地方。** 同一个游戏，四种"看到它的方式"：

| 通道 | 工具 | 读的是 | 状态 |
|---|---|---|---|
| **静态设计态** | `query_scene_tree`（`detail:true` 读单节点） | `.fire` 文件里的内容 | ✅ 一直可用 |
| **编辑器内运行时** | `runtime` `cmd:read` / `eval` / `report(source=scene)` | 场景进程里的活对象 | ✅ 可用 |
| **引擎 Web 预览** | `runtime` `cmd:report(source=preview)`、`preview` `cmd:command` | 预览页里跑着的游戏 | ✅ 可用，**不用打包** |
| **构建产物运行时** | `runtime` `cmd:report(source=build)` | `build` 出来的 web 产物 | ✅ 可用，但要先 build |

**优先用预览**：走引擎的 `__quick_compile__.js` 即时编译，改完 `.ts` 等重编译完刷新就是新的。
构建那条路（`build` + `runtime` `cmd:inject`）是备选，用于「构建产物里跑起来的游戏」。

### 文件结构

```
mcp/
├── main.js              7948 行  扩展主进程入口：MCP 协议、工具分发、场景脚本通道、预览服务、中继、构建
├── scene.js              993 行  场景脚本（渲染进程）：能用 cc、能执行 JS、能回传结果
├── bridge.js            1094 行  浏览器侧桥接：接收指令、执行、回报
├── injector.js           251 行  构建产物注入器（可逆）
├── inject-runtime.js     365 行  被注入的运行时上报脚本
├── hub.js                345 行  常驻中继：按项目身份转发（独立 Node 进程）
├── reload.js             207 行  开发期热重载（只影响指定端口）
├── deploy.js             165 行  带冲突检测 + 语法预检的部署
├── test.js              3309 行  回归测试（mock Editor + 真发 HTTP）
├── bootstrap-probe.js    209 行  冷启动探针：自建临时空项目，跑 8 项断言后清理
├── accept.js              99 行  端到端验收
├── dev-client.js         109 行  直连端口的调试客户端（故意不进扩展目录）
├── package.json                  扩展清单：main / scene-script / main-menu
├── lib/
│   ├── fsutil.js         113 行  纯文件系统工具
│   ├── uuid.js           283 行  uuid ↔ 路径索引（按 mtime 增量）
│   ├── scene-parse.js    422 行  .fire / .prefab **只读**解析 + 唯一根定位
│   ├── scene-tools.js   1230 行  场景 / 预制体**写入** + 批量 op 引擎
│   ├── scene-template.js 207 行  内置空场景模板：buildEmptyScene / attachCanvas / hasCanvas
│   ├── prefab.js         864 行  预制体装配 / 结构校验 / 布局自检（纯逻辑，无 fs 无 Editor）
│   ├── doc.js            326 行  文档校验 + 节点级 diff（prefab diff 的核心）
│   ├── asset-graph.js    188 行  引用图（谁引用我 / 我引用谁），按 mtime 增量
│   ├── editor-state.js   404 行  写入台账 + 节点差异 + 子树重合度匹配（纯逻辑）
│   └── tool-schema.js    613 行  工具声明表（纯数据，28 条）
├── README.md / README.en.md / DEVELOP.md / HANDOFF.md
└── .deploy-manifest.json         上次部署后的 md5 快照
```

### 分层与依赖规则

```
        main.js（编排层）
              │
    ┌─────────┼──────────┬─────────────┐
    ▼         ▼          ▼             ▼
lib/       scene.js    bridge.js     hub.js
(纯逻辑)   (渲染进程)   (浏览器)      (中继)
```

三条硬规则：

1. **`lib/` 不引用 `Editor` 全局** —— 通过 `setContext()` 拿注入的宿主能力。
   为什么：`lib/` 是最需要单测的部分，绑死 `Editor` 就没法脱离编辑器测。
2. **`lib/` 模块之间不互相 require** —— 依赖统一由 `main.js` 注入，`main.js` 是唯一组装点。
   为什么：避免循环依赖，依赖关系一目了然。
3. **工具声明与工具实现分离** —— `lib/tool-schema.js` 只放数据，`main.js` 的 `callTool()` 放分发。
   为什么：加工具时改两个明确的地方，不用在 8000 行文件里翻。

加工具的具体步骤见 [DEVELOP.md](DEVELOP.md#加一个新工具)。

---

## 工具速查（28 个）

> 8 个聚合入口**必须传 `cmd`**，每个 cmd 要哪些参数都写在工具描述里（`tools/list` 可见）。
> 46 个旧工具名仍可调用，返回带 `__renamedFrom` / `__hint`，对照见[附录](#附录旧工具名对照)。

### 普通工具（20 个）

| 分组 | 工具 | 说明 |
|---|---|---|
| 自检（1） | `mcp_selftest` | 把工具实际跑一遍，检查返回值形态、空值标注、错误信息。默认只跑无副作用的；`sideEffects: true` 连有副作用的一起跑（**在副本上做**，跑完删除并校验 md5 没变）。返回 `problems` + `registry`（三张表一致性） |
| 文件与代码（7） | `get_project_info` · `list_dir` · `search_files` · `read_file` · `write_file` · `edit_file` · `refresh_assets` | 项目信息 / 列目录 / 全文搜索 / 读原文 / 写文件（写 `.prefab` 做结构校验、保住 `fileId`、对齐换行风格）/ 精确替换 / 重新导入。改完 `.fire`/`.prefab` **必须** `refresh_assets`（不传参自动刷写过的目录） |
| 场景视图（5） | `query_scene_tree` · `scene_create` · `scene_diagnose` · `editor_sync` · `scene_capture` | 读节点树 / **建场景（内置模板，空项目也能起）** / 诊断通道 / 磁盘与编辑器内存差异 / 截干净场景图 |
| 资源诊断（3） | `resolve_asset` · `asset_refs` · `project_doctor` | 路径↔uuid 互转（图片给 `spriteFrames`）/ 谁引用我·我引用谁 / 项目体检（`fix:"preview"` 看计划，`fix:true` 才修） |
| 路由与兜底（4） | `list_open_projects` · `set_target_project` · `hub_control` · `run_script` | 列出打开的项目 / 指定操作哪个项目 / 中继开关 / 主进程跑任意 JS（长脚本用 `path` 从文件读） |

`scene_create` 的两个关键参数：`withCanvas`（默认 `true`，保证有 Canvas + Main Camera）、
`startScene`（默认 `true`，自动写 `start-scene` 与设计分辨率）。空项目不传任何模板也能直接建场景。

### 聚合入口（8 个，必填 `cmd`）

| 工具 | `cmd` 取值 | 吸收的旧工具 |
|---|---|---|
| `scene_edit` | `add-node` · `remove-node` · `move-node` · `set-props` · `add-component` · `remove-component` · `set-component-props` · `apply` | `scene_add_node` 等 8 个（`apply` 是批量事务 / `dryRun`） |
| `asset` | `query` · `move` · `delete` · `meta-get` · `meta-set` | `asset_query` 等 5 个 |
| `prefab` | `create` · `check-layout` · `diff` | `prefab_create`（spec / node 两种造法）、`prefab_layout_check`、`prefab_diff` |
| `build` | `targets` · `start` · `status` | `build_targets` / `build_project` / `build_status` |
| `project_settings` | `get` · `set` | `project_settings_get` / `_set` |
| `runtime` | `info` · `read` · `eval` · `report` · `inject` | `runtime_info` / `runtime_read` / `eval_scene` / `runtime_report` / `runtime_inject` |
| `preview` | `control` · `command` | `preview_control`（start / stop / open / bridge / status）、`preview_command`（11 个动作） |
| `editor` | `log` · `compile-status` | `get_editor_log` / `script_compile_status` |

**8 个写盘的 `scene_edit` cmd 都支持 `.fire` 和 `.prefab`**：`path` 直接传 `.prefab` 即可，
不传 `path` 才是"编辑器当前场景"。

**为什么外层用 `cmd` 而不是 `action`**：`runtime` `cmd:inject`、`preview` `cmd:control`/`command`、
`hub_control`、`editor_sync` 本来就有自己的 `action` 子命令，外层再用 `action` 会撞车。

---

## 实战：从零搭一个能跑的工程

这是 v0.8.0 新增的能力 —— **不需要先在编辑器里手工建场景**。

```jsonc
// 1. 建场景（空项目也能用：内置引擎同款模板 + Canvas + Main Camera + 写 start-scene）
{ "name": "scene_create", "arguments": { "path": "assets/scene/Main.fire", "canvas": [750, 1334] } }

// 2. 建预制体（图片只给路径，脚本只给路径，序列化细节全包）
{
  "name": "prefab",
  "arguments": {
    "cmd": "create",
    "path": "assets/resources/prefab/ChoiceItem.prefab",
    "root": {
      "name": "ChoiceItem", "size": [640, 88],
      "sprite": "assets/art/panel.png",
      "children": [{ "name": "Label", "size": [580, 60], "label": "选项文案" }]
    },
    "script": "assets/scripts/ChoiceItem.ts"
  }
}

// 3. 写脚本（长文件用 path 从文件读，避免 JSON 转义地狱）
{ "name": "write_file", "arguments": { "path": "assets/scripts/ChoiceItem.ts", "content": "..." } }

// 4. 导入 + 看编译状态
{ "name": "refresh_assets", "arguments": {} }
{ "name": "editor", "arguments": { "cmd": "compile-status" } }

// 5. 起预览，验证真的跑起来了
{ "name": "preview", "arguments": { "cmd": "control", "action": "start" } }
{ "name": "runtime", "arguments": { "cmd": "report", "source": "preview", "limit": 50 } }

// 6. 交付前体检
{ "name": "project_doctor", "arguments": {} }
```

第 1 步的坑（已在 v0.8.0 修掉）：以前空项目没有 `.fire` 可克隆就直接失败。
现在走 `lib/scene-template.js` 的 `buildEmptyScene()`，按内置 canvas prefab 的**完整字段**生成
—— 少一个 `_id`、`_trs` 顺序差一位都不会立刻报错，但会在运行时炸。

`bootstrap-probe.js` 就是专门验证这条链路的：自建临时空项目，跑 8 项断言，然后清理。

---

## 实战：改场景 / 改预制体

### 改节点属性

```jsonc
{ "name": "scene_edit", "arguments": {
    "cmd": "set-props", "node": "Canvas/topUI/btnKey", "position": { "x": 100, "y": 200 } } }
```

### 换图片（最容易踩坑的地方）

```jsonc
{ "name": "resolve_asset", "arguments": { "input": "assets/game/images/ys01.png" } }
```

**一张 png 有两个 uuid：**

| uuid | 是什么 | 填进 `_spriteFrame` |
|---|---|---|
| 主 uuid（meta 里第一个 `"uuid"`） | texture | ❌ 报 `textureLoaded is not a function` |
| `subMetas` 里的 uuid | sprite-frame | ✅ |

看返回的 `usableAsSpriteFrame` 字段（图片还会直接给 `spriteFrames`）。
换图后记得同步改尺寸和缩放 —— 新图原始尺寸要塞进按钮，否则会被拉伸。

### 批量改一个界面（一次写盘）

改 20 个节点时不要连续调 20 次 `set-props` —— 那是 20 次整文件读写，中途失败会留半成品。

```jsonc
{
  "name": "scene_edit", "arguments": {
    "cmd": "apply",
    "path": "assets/ui/Foo.prefab",
    "dryRun": true,
    "ops": [
      { "op": "addNode", "parent": "panel", "name": "title", "position": { "x": 0, "y": 500 } },
      { "op": "setProps", "node": "panel/title", "size": { "width": 400, "height": 60 } },
      { "op": "addComponent", "node": "panel/title", "type": "cc.Label" },
      { "op": "addPrefab", "prefab": "assets/ui/Item.prefab", "parent": "panel" }
    ]
  }
}
```

`dryRun: true` 只试算：给出 `before`/`after` 对象数、每个 op 的结果、结构校验有没有问题，**不写盘**。
确认后去掉 `dryRun` 再跑 —— 只有一次写盘；任何一步失败整批放弃，文件一个字节没动。

### 布局自检（不用截图）

```jsonc
{ "name": "prefab", "arguments": { "cmd": "check-layout", "path": "assets/ui/Foo.prefab" } }
```

报 `outOfBounds`（越出画布）、`overlaps`（同级重叠，**带重叠比例**）、`outsideParent`（超出父容器）、
`inactiveHidden`（`active:false` 但兄弟仍占位）。

### 看一眼，比算一遍更靠得住

```jsonc
{ "name": "scene_capture", "arguments": {} }
```

返回 `{file: "temp/mcp-state/shots/scene-<时间戳>.png", width: 915, height: 594}`，直接打开看。

默认会**临时关掉网格、设计分辨率框和 gizmo** 再截（它们是场景里的装饰节点
`Editor Scene Background` / `Editor Scene Foreground`，截完立刻恢复，不改文件也不改设置），并裁掉顶部工具栏。
传 `clean: false` 保留编辑器原样。

能看出几何检查算不出的问题：文字压得难看、九宫格切边画错、图片被拉伸、字体没生效。
反过来 `check-layout` 能给到**具体节点名和重叠比例** —— 两个一起用：先截图看到问题，再定位到是哪个节点。

### 改完到底改了什么

```jsonc
{ "name": "prefab", "arguments": { "cmd": "diff",
    "a": "assets/ui/Foo.prefab", "against": "temp/Foo.bak.prefab" } }
```

序列化文件里加一个节点会让后面所有 `__id__` 平移，字节 diff 会从头到尾全是"变了"，没法读。
这个按节点路径配对，只回答四件事：

```
added   1  CircleView/panel/__DiffA（含 1 个组件）
removed 0
changed 1  CircleView/panel/titleBg  opacity: [255, 128]
renamed 0
```

改名按 `_id` 匹配，不会被算成一删一增。预制体里节点 `_id` 是空串，
所以**预制体内部**改名会显示成删除+新增 —— 这是引擎约定，不是工具的锅。

### 改完之后，让编辑器跟上（最容易出事的一步）

这套 MCP 是**直接改文件**的。代价是编辑器内存里还是旧的：你在编辑器里按一次 Ctrl+S，
文件就被内存里的旧版本覆盖，而且**没有任何提示**。

写完 `scene_edit` 之后看返回里的 `editor` 字段：

```jsonc
{ "saved": true,
  "editor": { "openInEditor": true, "needsReload": true, "reloadWith": "editor_sync（action: reload）" } }
```

`openInEditor: true` 就接着调：

```jsonc
{ "name": "editor_sync", "arguments": { "action": "reload" } }
```

它会把场景面板重新从磁盘加载，然后**轮询到节点集合和文件一致**才返回 `verified: true`
（实测约 350ms）。不是"发出指令就算成功"。

`editor_sync` 也能提前发现问题，看[核心思想 5](#5-写入台账谁动过这个文件) 的那张表。

**预制体没法从外部重载**（`_loadScene` 只认场景），所以 `action:"reload"` 对预制体会明确拒绝，
告诉你"别保存，关掉重开" —— 而不是假装成功。

### 体检发现问题，能修的直接修

```jsonc
{ "name": "project_doctor", "arguments": { "fix": "preview" } }   // 先看清单，不动文件
{ "name": "project_doctor", "arguments": { "fix": true } }        // 真修
```

只修三类**不会把事情弄更糟**的：

| 问题 | 怎么修 | 为什么安全 |
|---|---|---|
| `Sprite._spriteFrame` 填了 png 主 uuid | 换成同一张图的 sprite-frame uuid | 那是唯一正确的值，没有第二种可能 |
| 孤儿 `.meta`（资源已删） | 移到 `temp/mcp-state/quarantine/<时间戳>/` | **不是删除**，随时能搬回去 |
| 缺 `.meta` | 对所在目录 `refresh_assets`，让编辑器自己生成 | 不手写 uuid / importer |

悬空 `__uuid__` **一律不修**：修它得先知道原来想引什么，猜不出来。

---

## 实战：试玩一个游戏

这是这个 MCP 最有价值的能力：**不用打包，改完代码刷新就能玩**。

```jsonc
// 起预览：返回地址 + 自动开窗
{ "name": "preview", "arguments": { "cmd": "control", "action": "start" } }
```

### 先看清有什么，再决定点哪个

FairyGUI 的界面**不是 cc.Node 树**，运行时上报的树里看不到。用 `fguiTree`：

```jsonc
{ "name": "preview", "arguments": { "cmd": "command", "action": "fguiTree", "depth": 8 } }
{ "name": "preview", "arguments": { "cmd": "command", "action": "fguiTree", "filter": "btn" } }
```

### 点按钮的两种方式

| 方式 | 用于 | 机制 |
|---|---|---|
| `fguiClick` | FairyGUI 按钮 | 官方 `InputProcessor.simulateClick` —— 派发真实 TOUCH_BEGIN/END 事件链 |
| `clickButton` | cc.Button | 走 `clickEvents` 正规派发（代码绑定的按钮会自动找 `onBtn*` / `on*Click`） |

```jsonc
{ "name": "preview", "arguments": { "cmd": "command", "action": "fguiClick", "path": "btnStart", "type": "GButton" } }
```

**节点路径找不到时会按名字全树搜** —— UI 常常挂在猜不到的容器下。

### 读状态 / 观察变化

`script` **支持 await** —— 这样才能看到状态**变化**，而不是变化前的快照：

```js
var btn = findButton('btnStart');
if (btn) btn.click();
await new Promise(function (r) { setTimeout(r, 1000); });
return cc.director.getScene().name;
```

### `preview` `cmd:command` 全部 11 个动作

| 动作 | 作用 |
|---|---|
| `ping` | 确认通道通 |
| `eval` | 求值单个表达式 |
| `script` | 执行多语句 JS 源码（**支持 await**），复杂逻辑用这个 |
| `read` | 读某个节点的组件属性（`path`） |
| `click` | 触发节点上组件的 `onXxx` 方法（`path` + 可选 `method`） |
| `clickButton` | 点 cc.Button（走 clickEvents） |
| `dispatchTouch` | 真派发触摸事件到 canvas |
| `module` | 加载项目模块（`window.__quick_compile_project__.require`） |
| `fguiTree` | 列 FairyGUI 对象树 |
| `fguiClick` | 点 FairyGUI 按钮（官方 simulateClick） |
| `screenshot` | 抓 canvas 像素，返回尺寸和平均色 |

### 抓日志

```jsonc
{ "name": "runtime", "arguments": { "cmd": "report", "source": "preview", "limit": 50 } }
```

返回运行时状态 + console 日志 + 错误，并带 `noiseFiltered`（过滤掉多少噪声行）。
`console.error` 不会被限流丢掉。

### 已验证的完整链路

```
preview control start     → 预览 + 注入 + 开窗
fguiClick btnStart        → GameView + level1[Game]（物理体、球、倒计时全实例化）
clickButton btnBack       → LevelView（12 个关卡项）
clickButton btnBack       → HomeView（这个按钮是代码绑定的，走兜底逻辑）
```

**四步各有各的入口，这就是"完全可控"的证据** —— 不依赖任何写死的流程。

---

## 返回约定

**每个工具**的返回都带这四个字段：

| 字段 | 含义 |
|---|---|
| `__status` | `ok`（有数据）/ `empty`（正常但当前没数据）/ `partial`（部分字段为空） |
| `__emptyFields` | 哪些字段是空的 |
| `__reason` | 为什么空 |
| `__hint` | 接下来该做什么 |

**空值 ≠ 调用失败。** 真正失败会直接报错，错误信息里带原因和下一步。
约定字段都带 `__` 前缀 —— 不会和业务字段撞名。

### 资源标识的约定

- 资源路径一律用 `path`（相对项目根，如 `assets/game/x.prefab`）
- 只有 `asset` `cmd:query` / `search_files` 用 `pattern`（搜索模式）
- 节点路径用 `Canvas/panel/title` 这种斜杠路径；同名节点必须写完整路径

---

## 部署

### 一条命令

```bash
node deploy.js            # 正常部署（有冲突会拒绝）
node deploy.js --check    # 只检查：报告待部署的文件，不落盘
node deploy.js --force    # 强制覆盖（确认过冲突内容再用）
```

部署目标：`~/.CocosCreator/packages/cocos-mcp-2x/`；
**该目录不存在时自动回退** `~/.CocosCreator/packages/mcp/`（编辑器实际加载的目录名在不同安装方式下不统一）。
优先标准名，避免把代码部署到编辑器根本不看的目录。

`--check` 是安全的：不写盘、不改清单，适合在 CI 或提交前确认「编辑器里跑的确实是这份代码」。

### 部署了哪些文件

`deploy.js` 的 `FILES` 白名单，**其余文件不进扩展目录**：

- 扩展本体：`main.js` `scene.js` `package.json` `reload.js` `test.js` `hub.js` `injector.js` `inject-runtime.js` `bridge.js`
- 文档：`README.md` `README.en.md` `DEVELOP.md` `HANDOFF.md`
- 纯逻辑层：`lib/` 下 10 个模块（**少一个就是 `Cannot find module` 的启动失败**）

`dev-client.js` / `deploy.js` / `bootstrap-probe.js` / `accept.js` 是开发期工具，**故意不部署**。

### 手动部署（不想用脚本）

```bash
# 确认目标目录
ls ~/.CocosCreator/packages/
# 整目录拷过去（注意保留 lib/ 结构）
cp -r . ~/.CocosCreator/packages/cocos-mcp-2x/
```

手工部署的代价是没有冲突检测和语法预检 —— 语法错的 js 进了扩展目录，
编辑器启动时只会报"未知工具"之类，跟真实原因对不上，很难查。**建议还是用 `deploy.js`。**

### 部署后

1. 菜单 **扩展 / Cocos MCP 2.x / 重启服务**（或重开编辑器）
2. `node dev-client.js 25800 get_project_info` 验证
3. `node dev-client.js 25800 mcp_selftest` 看 `problems` 是否为空

---

## 测试与自检

三层，从便宜到贵：

| 层次 | 命令 / 工具 | 需要编辑器 | 验的是什么 |
|---|---|---|---|
| **自检** | `node dev-client.js 25800 mcp_selftest` | 需要 | 每个工具实际跑一遍，返回值形态、空值标注、错误信息、三张表一致性 |
| **回归** | `node test.js` | **不需要**（mock `Editor` 后真发 HTTP） | 120+ 条断言：序列化正确性、删除重映射、批量事务、改名链、参数边界 |
| **冷启动** | `node bootstrap-probe.js` | **不需要** | 自建临时空项目，验证「从零搭建」8 项断言，跑完清理 |
| **端到端** | `node accept.js` | 需要 | 真编辑器里走一条完整链路，看 `errorTotal` |

`mcp_selftest` 的 `sideEffects: true` 会在**副本上**跑有副作用的工具，跑完删除并校验 md5 ——
不会污染你的项目。换机器、换项目、隔段时间再用，先跑这两个：

```bash
node dev-client.js 25800 mcp_selftest
node dev-client.js 25800 mcp_selftest '{"sideEffects":true}'
```

### 改完代码怎么生效

```bash
node test.js                    # 1. 回归（不需要编辑器）
node deploy.js                  # 2. 部署（带语法预检 + 冲突检测）
node reload.js                  # 3. 热重载（只影响指定端口，不用重启编辑器）
```

---

## 常见报错与处理

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `textureLoaded is not a function` | `_spriteFrame` 填了 png 的**主 uuid** | 用 `resolve_asset` 查 `usableAsSpriteFrame` |
| `Cannot find module './lib/xxx.js'` | 部署漏了 lib 目录 | `node deploy.js` |
| `路径越界：xxx 不在项目目录内` | 用了绝对路径 | 用相对项目根的相对路径 |
| 编辑器里看不到刚改的场景 | 没刷新，或内存里是旧场景 | `refresh_assets` + `editor_sync` reload |
| `找不到节点：xxx` | 路径不对 | 错误信息会列出当前场景的节点名；先 `query_scene_tree` |
| `有 N 个节点叫"xxx"，请写完整路径` | 同名节点 | 写完整路径 |
| `拒绝删除：还有 N 处外部引用` | 悬空引用风险 | 先解除引用（`asset_refs` 查谁在用） |
| `Editor.assetdb 不可用` | 没在编辑器里跑 | 这是编辑器内才能用的工具 |
| git diff 全量重写 | 换行风格被改了 | 用 `edit_file`，别整体重写 |
| `scene-script 通道超时` | 场景窗口没起 | 编辑器里打开场景窗口；先 `runtime` `cmd:info` 查通道 |
| `未知工具 xxx` | 部署没生效 / 拼错旧名 | `deploy.js --check` 确认；旧名见[附录](#附录旧工具名对照) |

### 两个特别容易踩的坑

**1. 中文在编译产物里被转义**

`.ts` 编译出的 JS 里中文是 `\uXXXX`，grep 搜中文搜不到 —— 会误判成"新代码没进产物"：

```js
const esc = Array.from('钥匙不足').map(function (c) {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
}).join('');
s.indexOf(esc)
```

**2. 改 `.ts` 不等于改了游戏（构建这条路）**

构建用的是**编译后的 JS**（`temp/quick-scripts/dst/` 和 `library/imports/<uuid>.js`）。
构建选项里 `autoCompile: false` —— **构建不触发编译，用的是缓存**。
改完源码要等编辑器编译完（看 `library/imports/<uuid>.js` 的 mtime）再构建，
用 `editor` `cmd:compile-status` 查有没有 stale。

用引擎预览则没这个问题 —— 预览走即时编译。

---

## 兼容性与已知限制

**目标环境**：Cocos Creator 2.4.x（开发验证环境 2.4.15）。3.x 不支持。

- **2.4 内置 Node 版本较老** —— 主进程代码不能用可选链 `?.`、空值合并 `??`、顶层 `await`。
  `deploy.js` 的语法预检会拦住，但报错位置可能不准，看到"语法错误"先怀疑新语法糖。
- **场景窗口不会重新加载场景脚本** —— 改了 `scene.js` 要重启编辑器（或用 `reload.js`）。
- **预制体不能从外部重载** —— 只能关掉重开。
- **`__id__` 平移是结构性的** —— 任何插入/删除都会让后面所有对象 id 变化，所以用节点级 diff，别看字节 diff。
- **编辑器内运行时（`source: scene`）依赖场景窗口打开**
- **`errorTotal` 里混有编辑器自身噪声** —— `runtime` `cmd:report` 会过滤并给出 `noiseFiltered` 计数

更多踩坑记录见 [HANDOFF.md](HANDOFF.md)，架构与开发约定见 [DEVELOP.md](DEVELOP.md)。

---

## 附录：旧工具名对照

**v0.8.0 合并表**（8 个 `cmd` 型入口吸收的 30 个工具）：

| 旧名 | 现在 | `cmd` |
|---|---|---|
| `scene_add_node` · `scene_remove_node` · `scene_move_node` · `scene_set_props` · `scene_add_component` · `scene_remove_component` · `scene_set_component_props` · `scene_apply` | `scene_edit` | `add-node` · `remove-node` · `move-node` · `set-props` · `add-component` · `remove-component` · `set-component-props` · `apply` |
| `asset_query` · `asset_move` · `asset_delete` · `asset_meta_get` · `asset_meta_set` | `asset` | `query` · `move` · `delete` · `meta-get` · `meta-set` |
| `prefab_create` · `prefab_layout_check` · `prefab_diff` | `prefab` | `create` · `check-layout` · `diff` |
| `build_targets` · `build_project` · `build_status` | `build` | `targets` · `start` · `status` |
| `project_settings_get` · `project_settings_set` | `project_settings` | `get` · `set` |
| `runtime_info` · `runtime_read` · `eval_scene` · `runtime_report` · `runtime_inject` | `runtime` | `info` · `read` · `eval` · `report` · `inject` |
| `preview_control` · `preview_command` | `preview` | `control` · `command` |
| `get_editor_log` · `script_compile_status` | `editor` | `log` · `compile-status` |

**v0.4.0 合并表**（同名参数合流，旧名仍转发）：

| 旧名 | 现在 | 参数怎么变 |
|---|---|---|
| `read_scene_node` | `query_scene_tree` | 加 `detail: true` |
| `mcp_audit` | `mcp_selftest` | 默认就是无副作用模式 |
| `mcp_verify_all` | `mcp_selftest` | 加 `sideEffects: true` |
| `resolve_uuid` / `resolve_sprite_frame` | `resolve_asset` | 统一用 `input`（旧字段仍认） |
| `execute_script` / `execute_script_file` | `run_script` | 用 `code` / `path` |
| `prefab_instantiate` | `scene_edit` `add-node` | 加 `from: "prefab"` |
| `prefab_create_from_node` | `prefab` `create` | 加 `from: "node"` |
| `scene_ping` / `scene_probe` | `scene_diagnose` | 加 `probe: true` |
| `runtime_console` / `preview_report` / `runtime_browser_report` | `runtime` `report` | 加 `source: scene` / `preview` / `build` |
| `runtime_eval` / `scene_eval` | `runtime` `eval` | 用 `expr` / `code` |

旧名可能要走 2 跳（v0.4.0 名 → v0.7.0 中继名 → v0.8.0 聚合名），
`callTool` 沿链转发并在返回里写明 `__hops` 与最终 `__hint`。最多 4 跳防环。

---

MIT License · 作者 UC-RX0
