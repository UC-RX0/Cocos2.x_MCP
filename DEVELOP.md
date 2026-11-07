# cocos-mcp-2x 开发文档

给要改这个 MCP 的人看。想知道**怎么用**看 [README.md](README.md)，
想知道**为什么这么设计、踩过什么坑**看 [HANDOFF.md](HANDOFF.md)。

---

## 目录

- [架构全景](#架构全景)
- [文件职责表](#文件职责表)
- [代码分层与依赖规则](#代码分层与依赖规则)
- [加一个新工具](#加一个新工具)
- [桥接协议](#桥接协议)
- [场景脚本通道](#场景脚本通道)
- [开发工作流](#开发工作流)
- [测试](#测试)
- [部署](#部署)
- [兼容性约束](#兼容性约束)
- [排错](#排错)

---

## 架构全景

```
┌─────────────────────────────────────────────────────┐
│ 客户端 (mcp.json)                                    │
│   "url": "http://127.0.0.1:25800/mcp"                │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────┐
│ hub.js —— 常驻中继（独立进程，编辑器关了也在）        │
│   每次请求读 target.json → 解析目标项目身份 → 转发     │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌────────────────┐          ┌────────────────┐
│ 编辑器 A (25900)│          │ 编辑器 B (25901)│
│  main.js 扩展   │          │  main.js 扩展   │
└────────┬───────┘          └────────┬───────┘
         │                           │
         ├─→ 场景脚本通道 ─→ scene.js（渲染进程，能用 cc）
         ├─→ 预览服务   ─→ PreviewServer → bridge.js（浏览器侧）
         └─→ 文件层     ─→ .fire / .prefab / assets
```

### 三条执行通道

| 通道 | 走什么 | 特点 |
|---|---|---|
| **文件层** | 直接读写 `.fire` / `.prefab` JSON | 最可靠。可 diff、可离线测、不碰编辑器 IPC |
| **场景进程** | `scene.js`（渲染进程） | 能用 `cc`、能读活对象、能执行 JS |
| **Web 预览** | `bridge.js`（浏览器侧） | 能点按钮、能抓日志、能截图 |

**设计原则**：能不碰编辑器私有 IPC 就不碰。`.fire` 是纯 JSON，文件层能做的事比编辑器 API 还多。

---

## 文件职责表

| 文件 | 行数 | 职责 | 跑在哪 |
|---|---|---|---|
| `main.js` | 7844 | 扩展主进程：MCP 协议、工具分发、场景脚本通道、预览服务、中继、构建 | 编辑器主进程 |
| `scene.js` | 993 | 场景脚本：能访问 `cc`、能执行 JS、能回传结果 | 场景窗口（渲染进程） |
| `bridge.js` | 1094 | 浏览器侧桥接：接收指令、执行、回报 | Web 预览页 |
| `hub.js` | 345 | 常驻中继：按项目身份转发 | 独立 Node 进程 |
| `injector.js` | 251 | 构建产物注入器（可逆） | 主进程调用 |
| `inject-runtime.js` | 349 | 被注入的运行时上报脚本 | 浏览器 |
| `reload.js` | 207 | 热重载 | 开发期 CLI |
| `deploy.js` | 159 | 带冲突检测的部署 | 开发期 CLI |
| `test.js` | 3273 | 回归测试（mock Editor + 真发 HTTP） | 开发期 CLI |
| `accept.js` | 99 | 端到端验收 | 开发期 CLI |
| `dev-client.js` | 109 | 直连指定端口的调试客户端 | 开发期 CLI |
| `lib/fsutil.js` | 113 | 纯文件系统工具 | 被 main.js require |
| `lib/uuid.js` | 283 | uuid ↔ 路径索引（按 mtime 增量） | 被 main.js require |
| `lib/scene-parse.js` | 422 | `.fire`/`.prefab` **只读**解析 + 唯一根定位 | 被 main.js require |
| `lib/scene-tools.js` | 1230 | 场景/预制体**写入** + 批量 op 引擎 | 被 main.js require |
| `lib/prefab.js` | 864 | 预制体装配 / 结构校验 / 布局自检（**纯逻辑，无 fs 无 Editor**） | 被 main.js require |
| `lib/doc.js` | 326 | 文档校验 + **节点级 diff**（`diffDocs`，prefab_diff 的核心） | 被 main.js require |
| `lib/asset-graph.js` | 188 | 引用图（谁引用我 / 我引用谁），按文件 mtime 增量 | 被 main.js require |
| `lib/editor-state.js` | 404 | 写入台账 + 节点差异 + 子树重合度匹配（**纯逻辑**，Node 里可单测） | 被 main.js require |
| `lib/scene-template.js` | 207 | 内置空场景模板：`buildEmptyScene` / `attachCanvas` / `hasCanvas`（**空项目也能建场景**） | 被 main.js require |
| `lib/tool-schema.js` | 613 | 工具声明表（纯数据，28 条；8 个 `cmd` 型聚合入口） | 被 main.js require |
| `bootstrap-probe.js` | 209 | 冷启动探针：自建临时空项目，跑 8 项断言后清理 | 开发期 CLI |

---

## 代码分层与依赖规则

```
        main.js（编排层）
              │
    ┌─────────┼──────────┬─────────────┐
    ▼         ▼          ▼             ▼
lib/       scene.js    bridge.js     hub.js
(纯逻辑)   (渲染进程)   (浏览器)      (中继)
```

### 三条硬规则

**1. `lib/` 里的模块不引用 `Editor` 全局**

它们通过 `setContext()` 拿宿主能力：

```js
// lib/uuid.js
var ctx = {
    projectRoot: function () { throw new Error('uuid 模块未初始化'); },
    // ...
};
function setContext(next) {
    for (var k in next) {
        if (Object.prototype.hasOwnProperty.call(next, k)) ctx[k] = next[k];
    }
}
```

**为什么**：`lib/` 里的逻辑是最需要单测的部分。绑死 `Editor` 就没法脱离编辑器测。
注入的必须是**函数引用**而不是调用结果 —— 函数声明会提升，注入时机怎么都不晚。

**2. `lib/` 模块之间不互相 require**

`scene-tools.js` 需要 `resolveNode`（在 `scene-parse.js` 里），
但它不 require `scene-parse.js` —— 而是从 main.js 注入。

**为什么**：避免循环依赖。`main.js` 是唯一的组装点，依赖关系一目了然。

**3. 工具声明和工具实现分离**

`lib/tool-schema.js` 只放数据（name / description / inputSchema），
`main.js` 的 `callTool()` 放分发逻辑。

**为什么**：加工具时改两个明确的地方，不用在一个 5000 行文件里翻。

**v0.8.0 补充：加 / 合并工具要动哪儿**

1. `lib/tool-schema.js` 的 `TOOLS` 加一条。聚合工具必须声明 `cmd` 枚举并写进 `required`。
2. `main.js` 的 `IMPL` 加一条；聚合工具再写一个 `dispatchByCmd(...)` 分发函数，
   按 `cmd` 挑原来的实现，并把 `cmd` 从参数里摘掉再传下去。
3. `main.js` 的 `buildAuditProbes()` 加一条探针（有副作用就给 `null`）。
4. 如果是**合并**旧工具：在 `RENAMED` 里加 `旧名: { to: '新名', cmd: '...' }`。
   旧名不用进 `TOOLS` / `IMPL`，`callTool` 会沿链转发，支持"v0.4.0 旧名 →
   v0.7.0 中继名 → v0.8.0 聚合名"这种 2 跳链（最多 4 跳防环）。
5. `test.js` 同步工具数断言与旧名清单，再跑三项目回归。

`registryProblems()` 校验 `TOOLS` / `IMPL` 严格一一对应；
`mcp_selftest` 校验体检表覆盖全部工具，漏登记会直接进 `problems`。

### `lib/` 模块的调用约定

用 `c('name')` 取注入的依赖：

```js
function c(name) {
    var fn = ctx[name];
    if (!fn) throw new Error('scene-tools 未注入依赖：' + name);
    return fn;
}
```

⚠️ **注意变量遮蔽**：`c` 是个很短的变量名。别在同一个函数里写 `var c = ...` ——
`var` 是函数级作用域，会把模块级的 `c` 遮掉，
运行时才炸 `c is not a function`（这个坑踩过）。

---

## 加一个新工具

### 三步

**1. 在 `lib/tool-schema.js` 的 `TOOLS` 里加一条**

```js
{
    name: 'my_tool',
    description: '一句话说清做什么。' +
        '**说清楚什么时候会空、什么时候会报错。**',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '目标路径' }
        },
        required: []
    }
}
```

**2. 在 `main.js` 写实现**

放在合适的 region 里。文件/资源类的放「工具实现」区，
场景写入类的放 `lib/scene-tools.js`，
预制体装配/校验/几何计算这类**纯逻辑**放 `lib/prefab.js`（它靠注入拿 `newNodeId`，
不碰 fs 也不碰 Editor，能在 Node 里直接单测）。

```js
function toolMyTool(args) {
    // 失败就 throw，错误信息要带「原因 + 下一步」
    if (!args.path) throw new Error('缺少 path。要指定目标文件，比如 {"path":"assets/a.json"}');
    return { ok: true, data: '...' };
}
```

**3. 在 `main.js` 的 `IMPL` 表里加一条，并在自检表 `buildAuditProbes()` 里加一条**

```js
// IMPL 表（工具名 → 实现函数）
var IMPL = {
    // ...
    my_tool: toolMyTool
};

// buildAuditProbes()：没有副作用的给参数，有副作用的写 null，自检自己写 'self'
my_tool: { path: 'assets' },
```

漏了 IMPL：启动时 `Editor.error` 点名，`mcp_selftest.registry` 也会报。
漏了自检表：`mcp_selftest` 报 `missingProbe`（v0.4.0 之前是**静默跳过**，工具等于白做验证）。

**4. 在 `test.js` 加一条断言**

```js
await check('my_tool 正常工作', async function () {
    const r = await callTool('my_tool', { path: 'xxx' });
    assert.ok(r.ok);
});
```

然后：

```bash
node test.js "G:/CocosProject/new/bottle_new"
```

**必须全绿才能提交。**

### description 的写法要求

description 会自动追加「返回约定」，所以**只需要写这个工具自己的语义**。

必须说清：
- **做什么**（一句话）
- **什么时候会空**（`__status=empty` 的条件）
- **什么时候会报错**（什么输入会导致 throw）
- **参数怎么用**（`inputSchema` 里每个字段的含义）

反例：`description: '处理场景数据'` —— AI 不知道传什么、不知道什么时候失败。

正例：
```
'改场景里某个节点的属性（名字 / 激活 / 位置 / 缩放 / 不透明度 / 尺寸 / 锚点），直接写 .fire。改名会自动检查同级重名。'
```

### 返回值的硬要求

- **成功**：返回对象，字段用业务名。**不要用 `error` 这个字段名** ——
  MCP 用 `isError` 表示失败，成功返回里带 `error` 会让客户端误判。
  要表达"有错误但成功"就用 `lastError`。
- **失败**：`throw new Error('原因。下一步该怎么做。')`
- **空但不失败**：返回 `__status: 'empty'` + `__emptyFields` + `__reason` + `__hint`

---

## 桥接协议

浏览器侧（`bridge.js`）和扩展侧（`main.js`）之间的纯 HTTP 协议。

| 方向 | 端点 | 说明 |
|---|---|---|
| 浏览器 → 扩展 | `POST /bridge/report` | 运行时状态 + 新增日志 |
| 扩展 → 浏览器 | `GET /bridge/commands?since=N` | 浏览器每 400ms 拉一次 |
| 浏览器 → 扩展 | `POST /bridge/result` | 指令执行结果 |
| 浏览器 → 扩展 | `POST /bridge/bye` | 页面卸载 |

**注入配置里写的是中继端口（25800），不是扩展自己的端口** ——
扩展端口会变（编辑器重启、多开时按启动顺序分配），
写死的话扩展一重启页面就指向死端口，桥接静默断掉、还不报错。

### 扩展侧状态

```js
var bridgeState = {
    connected: false,
    logs: [],           // 环形缓冲，最多 500 条
    results: {},        // cmdId → 执行结果
    resultOrder: [],    // 结果的到达顺序（用于"取最新一条"）
    errors: [],         // console.error / 未捕获异常
    seenLogKeys: {},    // 日志去重（文本+时间戳）
    byeAt: null
};
```

### 加一个新桥接动作

**1. 在 `bridge.js` 的指令分派里加分支**

```js
if (action === 'myaction') {
    var r = doMyAction(cmd.arg);
    return { ok: true, value: r };
}
```

注意代码里动作名是**全小写**（`clickbutton` / `dispatchtouch` / `fguitree`），
`main.js` 侧做了 lowercase 归一，工具描述里写驼峰。

**2. 在 `main.js` 的 `preview_command` schema 里加说明**

**3. 在 `test.js` 的"11 个动作都在"那条断言里加上**

那条断言会检查 `bridge.js` 的源码里有没有对应分支，
**不加的话测试会失败**（这是故意的，防止"文档说有但代码没有"）。

---

## 场景脚本通道

主进程 → 场景窗口（渲染进程）。

### 关键事实

**2.4 的场景脚本处理器签名是 `(evt, payload)`** —— payload 在**第二个**参数。

```js
function update_nodes(evt, uuid) { ... }   // ← evt 在前
scene.update_nodes = update_nodes;
```

参照引擎自带的 `packages/node-binder/js/tool/scene.js`。

⚠️ **这个坑踩过一整轮**。v0.3.0 判定"2.4 拿不到场景进程返回值"并写进了文档，
v0.3.2 实测发现是**自己的处理器签名写错了** —— 引擎能力完全正常。

**第二个坑**：`Editor.Ipc.sendToPanel(panel, name, body, cb)` 的回调**不只用来收错误**。
场景脚本 `evt.reply(envelope)` 走的就是这个 cb。三个分支都要处理：
not found / 其他错误 / 成功回执。

### 2.4 和 3.x 的 API 差异

| 东西 | 2.4 实际 | 3.x |
|---|---|---|
| 处理器签名 | `(evt, payload)` | `(payload)` |
| `node.components` | **undefined** | 正常 |
| `node._components` | 有 | — |
| `node.scale` | **数字**（=scaleX） | Vec3 |
| `node.scaleX/Y/Z` | 有 | 有 |
| 类名格式 | `cc_Canvas`（下划线） | `cc.Canvas`（点号） |
| `Editor.Message` | **undefined** | 有 |

3.x 那套 `Editor.Message.request(...)` **不能搬到 2.x** —— 2.4 只有 `Editor.Ipc`。

修法在 `scene.js` 里：`compsOf()` / `scaleOf()` / `posOf()` 三个兼容助手 +
`normClassName()` 归一化类名。

### 场景窗口不会重新加载场景脚本

`Panel.close('scene')`+`open('scene')`、editor:panel-run 全试过，面板重建也不重新 require。

**改 `scene.js` 只能靠重启编辑器。**（`main.js` 改动用 `node reload.js <端口>` 热重载即可。）

---

## 开发工作流

```bash
cd G:/unfinishWork-main/tools/cocos-mcp-2x

# 1. 改完先跑测试（不需要编辑器，mock 掉 Editor 后真发 HTTP）
node test.js "G:/CocosProject/new/bottle_new"

# 2. 部署（带冲突检测）
node deploy.js

# 3. 热重载（只影响指定端口，不用重启编辑器）
node reload.js 25901
```

### 开发端口约定

- **25900** 常常是真实项目（如 `alipay-pouring_water`），**不要动**
- 测试项目（如 `bottle_new`）会落在 **25901**
- 原生 MCP 工具绑死 `mcp.json` 里的 25900，所以开发期一律用 `dev-client.js`：

```bash
node dev-client.js 25901 scene_ping
node dev-client.js 25901 scene_add_node '{"parent":"Canvas","name":"X"}'
node dev-client.js 25901 --list
```

### 改 main.js vs 改 scene.js

| 文件 | 热重载 | 说明 |
|---|---|---|
| `main.js` | ✅ `node reload.js <端口>` | 扩展主进程 |
| `lib/*.js` | ✅ 同上 | 靠 main.js 的 require 链加载 |
| `scene.js` | ❌ **必须重启编辑器** | 场景窗口只在启动时 require |
| `bridge.js` | ✅ 重新 `preview_control start` | 浏览器侧 |

---

## 测试

### 怎么测的

`test.js` 在 Node 里 mock 掉 `Editor` 全局，然后**真发 HTTP 请求**测这个扩展。

**为什么要这么测**：直接 require 函数只能测纯逻辑，
测不到「HTTP 层 → 协议层 → 工具分发 → 实际返回」这条链。
真发 HTTP 才能保证整条链路是通的。

### 跑法

```bash
node test.js "G:/CocosProject/new/bottle_new"    # 539 资源
node test.js "D:/CocosProject/PinGame"           # 569 资源（CRLF 场景）
node test.js "D:/CocosProject/cleanMaster"       # 4086 资源（无空节点模板）
```

**三个项目都要过**（各 121 项）。它们覆盖的场景不一样：
换行风格、资源规模、场景里有没有空节点模板。

### 测试隔离

测试进程和真编辑器同机，`COCOS_MCP_NO_REGISTRY=1` 只挡住了注册表写入，挡不住别的。
测试模式下：目标文件走临时目录、注册表和中继状态用假的、**不转发**。

**自检工具不污染项目**：
- 场景类操作全部在**场景副本**上做（复制到 `temp/` 再操作）
- 资源类操作在 `assets/__mcp_probe/` 的副本上做
- 跑完全部删除，并校验真实场景文件 md5 没变

### 关键断言（都在 `test.js` 里）

- **加 → 改 → 删 往返后，`.fire` 与原文件逐字节一致**（守住 `__id__` 重映射和换行风格）
- 预制体拷入后组件齐全，删除后同样逐字节还原
- 导出的预制体：每个节点一个 `PrefabInfo`、`PrefabInfo.asset` 与 `meta.uuid` 一致，导出后能实例化回来
- 删除场景根 / 删除组件有外部引用时被拒绝
- 危险 meta 字段（`_` 开头、`uuid`）被拒绝
- **目标文件里不存 `port` 字段**（端口会漂移，存了就指错项目）
- **端口互换后目标仍解析到正确项目**（模拟编辑器重启换端口）
- **场景进程能收到 payload**（守住 `(evt, payload)` 签名这个教训）
- **场景脚本方法未注册时 14ms 快速失败**（不是干等 15 秒超时）
- **注入后带哈希的资源文件 md5 不变**（变了会加载失败）
- **注入脚本在模拟浏览器环境里能正确 POST**（含 cc API 调用和真实 XHR）
- **bridge.js 的 11 个动作分支都在**（防止"文档说有但代码没有"）
- **所有工具描述都带返回约定**（离开对话也能看懂）

### 端到端验收

```bash
node accept.js
```

依次做：查中继状态与目标 → 环境自检 → 查构建产物 → 打开游戏页面确认能访问
→ 读场景 → 加节点 → 改属性 → 读回验证 → 删节点还原。

---

## 部署

```bash
node deploy.js            # 正常部署（有冲突会拒绝）
node deploy.js --check    # 只检查不部署
node deploy.js --force    # 强制覆盖
```

### 冲突检测

扩展是**全局安装**的，可能有人（另一个会话、用户自己）在同时改同一份代码。
无脑 cp 会把对方的改动覆盖掉，而且双方都不知道（这次就发生过）。

`deploy.js` 记录了上次部署后磁盘上应该是什么样（`.deploy-manifest.json`），
部署前先比对，发现被改过就**拒绝覆盖并报告**。

**不要用 `cp` 代替 `deploy.js`。**

### 部署了哪些文件

```
main.js  scene.js  package.json  reload.js  test.js  hub.js
injector.js  inject-runtime.js  bridge.js
README.md  README.en.md  DEVELOP.md  HANDOFF.md
lib/fsutil.js  lib/uuid.js  lib/scene-parse.js
lib/scene-tools.js  lib/prefab.js  lib/doc.js  lib/asset-graph.js
lib/editor-state.js  lib/tool-schema.js  lib/scene-template.js
```

`dev-client.js` / `deploy.js` / `bootstrap-probe.js` / `accept.js` 是开发期工具，
**故意不进扩展目录**。

> 加了新文件记得往 `deploy.js` 的 `FILES` 里加，否则编辑器端会报
> `Cannot find module './lib/xxx.js'`。
> （`lib/scene-template.js` 就漏过一次：`main.js` require 了它但没进白名单，
> 部署后扩展直接起不来。）

### `--force` 到底做什么

`--force` 语义是「**我已确认那些改动可以丢，覆盖掉**」：

| 场景 | 不带 `--force` | 带 `--force` |
|---|---|---|
| 部署目录被别处改过 | 列出冲突文件、**exit 1**、一个字节不动 | 列出冲突文件、把源码覆盖上去 |
| `--check --force` | — | 只报告「会覆盖谁、待部署哪些」，**不写盘**、exit 0 |

冲突文件在扫描阶段会被 `continue` 跳过、不进 `changed` 清单，
所以强制分支要把它补回去（`srcMd5 !== depMd5` 才补）——
早期版本漏了这步，导致提示写着「加 --force 重跑」、加了还是同样的报错。

### 部署前自动语法检查

`deploy.js` 用 `vm.Script` 编译每个 js 文件，**语法错误直接拒绝部署**。
（语法错误的 js 进了编辑器会直接让扩展崩掉，
而且报错信息跟真实原因对不上，很难查。）

---

## 兼容性约束

### Cocos Creator 2.4 内置 Node 版本较老

**本项目刻意不使用**：

- 可选链 `?.`
- 空值合并 `??`
- `Array.flat` / `flatMap`
- `Object.fromEntries`
- `String.replaceAll`
- `async` 迭代器

**可以用**：`const` / `let` / `async` / `await` / 模板字符串 / 箭头函数 / 展开运算符。

> 测试脚本（`test.js` 等）不在编辑器里跑，可以用新语法。

### Windows 特有的坑

- `require.cache` 的键是**反斜杠**，`Editor.Package.paths` 给的是正斜杠，
  匹配前必须 normalize
- `server.close()` **不断开已建立的 keep-alive 连接**，
  客户端复用旧 socket 会读到旧实例。
  判断换没换实例要比对 `serverInfo.instanceId`，**不要用 version**
- 编辑器里 `process.execPath` 是 **CocosCreator.exe 不是 node**，
  直接 spawn 它去跑脚本会再拉起一个编辑器。要当纯 node 用得加
  `ELECTRON_RUN_AS_NODE=1` 环境变量
- 这台机器设了 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，
  **curl 访问 127.0.0.1 会走代理**，报 "upstream connect failed" 之类的怪错。
  测本地端口要加 `--noproxy '*'`

---

## 排错

### 改了代码但行为没变

| 检查 | 命令 |
|---|---|
| 部署了吗 | `node deploy.js --check` |
| 热重载了吗 | `node reload.js <端口>` |
| 端口对吗 | `node dev-client.js --list` |
| 是 `scene.js` 吗 | 改 `scene.js` **必须重启编辑器** |
| 缓存 | `uuid` 索引缓存 30 秒，`refresh_assets` 会失效 |

### 自检工具报错

```bash
node dev-client.js 25800 mcp_audit
node dev-client.js 25800 mcp_verify_all
```

`problems` 数组非空就是有问题。每条都带原因和建议。

### 场景改坏了

**场景写入是文件级的，编辑器内存里的场景是旧版本。**

改完要么让用户重开场景，要么别在编辑器里保存 ——
否则会用旧场景覆盖你的改动。

如果已经改坏：`git checkout` 那个 `.fire` 文件，然后重做。

### 想知道某个设计的来龙去脉

看 [HANDOFF.md](HANDOFF.md) 的「2.4.15 踩过的坑」章节 ——
每一条都是实际卡住过的，不是理论推测。
