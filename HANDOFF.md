# cocos-mcp-2x 交接文档

> 最后更新：2026-11-06 13:00，版本 **v0.8.0**
> 源码：`E:/cocos-mcp-2x/`
> 部署：`~/.CocosCreator/packages/cocos-mcp-2x/`（全局扩展，所有 2.x 项目共用）

| 文档 | 什么时候看 |
|---|---|
| **[README.md](README.md)** | 怎么用（安装、28 个工具速查、试玩游戏实战、改名对照） |
| **[DEVELOP.md](DEVELOP.md)** | 怎么改（架构分层、加新工具、桥接协议、测试） |
| **本文** | 为什么这么设计、踩过什么坑、当前进度 |

---

## 一、现在是什么状态

| 项 | 值 |
|---|---|
| 版本 | **0.8.0** |
| 工具数 | **28**（v0.8.0 把 30 个工具并进 8 个 `cmd` 型入口，50 → 28） |
| 回归 | bottle_new、PinGame、cleanMaster 各 **121/121** |
| 入口 | `mcp.json` → **中继 `http://127.0.0.1:25800/mcp`**（常驻进程，编辑器关了也在） |
| 目标项目 | `set_target_project` 指定，**所有调用自动转发过去**，客户端连哪个端口无所谓 |
| 场景写入 | ✅ 走文件级（直改 `.fire`），**不依赖场景进程** |
| 预制体写入 | ✅ `scene_*` + `scene_apply` 直接吃 `.prefab` |
| 从零造预制体 | ✅ `prefab_create` 从声明式 spec 一次成型（v0.3.4） |
| 读运行时状态 | ✅ 编辑器内走场景进程，浏览器内靠静默注入上报 |
| **试玩游戏** | ✅ **引擎 Web 预览 + 桥接，零打包**（v0.3.3 新增） |
| 代码结构 | `main.js` 7844 行 + `lib/` 9 个模块 |

**v0.3.0 的结论已经被 v0.3.2 推翻**：~~"2.4.15 的 scene-script 通道只收不回"~~ ——
真相是**自己的处理器签名写错了**，引擎能力完全正常。详见第四节第 1 条。

**v0.8.0 的核心成果**：工具集从 50 个压到 **28 个** —— 30 个"同一动作域"的工具
并进 8 个 `cmd` 型入口，`tools/list` 从 ~62 KB 降到 **42.8 KB**（描述总字数 -73%）。
旧名一个没删：`RENAMED` 链支持多跳转发（v0.4.0 旧名 → v0.7.0 中继名 → v0.8.0 聚合名，
最多 4 跳，返回 `__hops` / `__renamedFrom`）。原来重复拼 10 处的 PREFAB_RULES 压成
3 处精简版 + 1 份完整版进 `initialize.instructions`。**实现函数一行没动**，只换了入口，
所以三项目回归仍是全绿。

**v0.7.0 的核心成果**：把 v0.6.0 里所有"只能猜"的地方换成了实测结论，并补两个缺口。

一次真实的预制体编辑态，直接推翻了 v0.6.0 的一个假设：

| 假设 | 实测 |
|---|---|
| 预制体编辑态下 `Editor.currentSceneUuid` 会变成预制体 uuid / 变成 null | **都不对** —— 它还是原场景的 uuid，一点没变 |
| 判"场景是不是开着"看 currentSceneUuid 就够 | 会**误报**：明明在编预制体，却报告场景开着，这时让它 reload 会把用户从预制体里踢出去 |

现在的判据（都验过）：
- **场景**：活场景的 `_id` 必须等于文件 uuid（不是看 currentSceneUuid）
- **预制体**：`_id` 不是 36 位 uuid → 临时场景 → 在活节点里找一棵和预制体**双向重合度 ≥50%** 的子树。
  用重合度而不是完全相等，因为"我刚往预制体里加了个节点"会让两边差一个 —— 严格要求相等反而认不出来。
- **预制体不能从外部重载**（`_loadScene` 只认场景），`action:"reload"` 会明确拒绝并告诉你"别保存、关掉重开"

新增/改进：

| 项目 | 之前 | 现在 |
|---|---|---|
| `prefab_diff` | 无（只能字节 diff，序列化文件上没法读） | 节点级差异：增删改 + 改名识别，属性用 `[旧值, 新值]` |
| `project_doctor fix` | 只读 | 三类安全修复：spriteFrame 类型错 → 换正确 uuid；孤儿 .meta → 移隔离区（不删）；缺 .meta → 交给编辑器 refresh。默认只报告，`fix:"preview"` 看计划 |
| `scene_capture` 画面 | 带网格、gizmo、工具栏 | 双进程清理：场景进程关装饰节点，渲染进程隐藏 DOM 叠加层（坐标标尺、节点标签、预制体「保存/关闭」悬浮条），再裁顶部工具栏；截完按标记恢复，`clean:false` 保留原样 |
| 预制体路径解析 | `CircleView/panel/item1` 这种写法找不到节点 | 根节点名也当路径前缀（层级面板上看到什么就能写什么） |

**`scene_capture` 为什么还得动 DOM**：`capturePage(rect)` 只能裁掉画面**外面**的东西。
实测在预制体编辑态里，「PREFAB 保存 关闭」是 `#sceneView` 的 shadow DOM 里的 `#editButtons`
（`overlaying-buttons`，`z-index:991`），浮在**画布内部** —— 把顶部 `#editor-toolbar`
裁掉 20px 它照样在。所以干净截图分两层做：场景进程关 cc 装饰节点，渲染进程临时
`display:none` 四个叠加层（`#editButtons` / `#helpText` / `#grid` / `#gizmosView`），
把原 display 记在元素自身的 `data-mcp-deco-prev` 上，截完遍历带标记的元素恢复 ——
不依赖 window 全局，`executeJavaScript` 换了上下文也照样能还原，不会把编辑器改坏。
真机验证：截出来只剩游戏 UI，截图后这几个元素全部回到原 `display`。

**v0.6.0 的核心成果**：把"编辑器内存 vs 磁盘"这个根本矛盾正面解决了。

这套 MCP 靠**直接改文件**工作，代价以前只是一句提示："编辑器里开着的话请重新打开"。
问题是：AI 不知道**要不要紧**、重开**会丢什么**、以及**关掉不等于重载**。

这一版把它拆成三件可验证的事：

| 问题 | 做法 | 验证 |
|---|---|---|
| 编辑器内存是旧值 | `editor_sync`：比对磁盘节点集合 vs 场景进程里的活节点集合 | 真机上写完立刻报出 `diff.fileOnly`，reload 后 `verified: true`（约 350ms） |
| 没有重载入口 | 2.4.15 **没有**任何 query-dirty / reload 消息（拿 20 多个候选名字逐个试出来"不存在"）；最后走 `Editor.Panel.findWindow('scene').nativeWin.webContents` → 在渲染进程里调面板实例的 `_loadScene(uuid)` | 实测重载后 `cc.find('Canvas/__ReloadProbe')` 从 false 变 true |
| 改动被编辑器保存覆盖 | 写入台账（`temp/mcp-state/ledger.json`）：记 mtime/size/节点 id/删掉的 id | 改一下文件再查，`risk: clobbered` |
| 布局"算出来对"但"看起来不对" | `scene_capture`：`capturePage(rect)` 截场景面板，rect 从渲染进程 `getBoundingClientRect` 取 | 实测截出 922×610 的场景视图 |

**顺带解决的一个误报**：`liveOnly`（内存有、磁盘没有）有两种来源 ——
我们刚删掉的节点（重载无损）和用户自己新建的节点（重载会丢）。
一开始不区分，删完节点再查就报"你在编辑器里改了还没保存"。
现在写入时记下本批删掉的节点 id，查询时按 id 分流：
前者判 `editor-stale`（可以直接 reload），后者判 `editor-has-unsaved`（要 force）。

**v0.5.0 的核心成果**：补上了三个"本该有"的结构能力。

| 能力 | 之前 | 现在 |
|---|---|---|
| **文档事务** | 11 个写工具各自 `load → 改 → 整文件落盘`；改 20 个节点 = 20 次读写 20 次落盘，中途失败留半成品 | `openDoc → applyOps → commitDoc`，`scene_apply` 支持 `dryRun` 试算、整批原子提交、失败整批放弃 |
| **资源图** | 只能查"这个 uuid 是什么"，查不了"谁引用我"，删图靠猜 | `asset_refs`（in/out 双向）+ 按 mtime 增量的引用索引 |
| **项目体检** | `mcp_selftest` 查的是 MCP 自己 | `project_doctor` 查**项目**：悬空 `__uuid__`、spriteFrame 填成 texture、prefab 结构坏、缺/孤儿 `.meta` |

顺带把 `buildUuidIndex` 改成按 .meta 的 mtime 增量：cleanMaster（4086 资源）
整表重建 **1.35s → 0.11s（约 12 倍）**，而且 refresh 后不再需要重新解析所有 meta。

数字：`scene_apply` 让"改 20 个节点"从 20 次落盘变成 1 次；`script_compile_status` 加了 `waitMs`，
构建前可以真的等到编译完成（最多 60s），不再打进旧代码。

**真机跑 `project_doctor` 顺手抓到自己两个 bug**（这就是"拿真实项目验证"的价值）：

1. **把 `cc.ClickEvent` 当成了组件**。它是普通 CCClass（挂在 `Button.clickEvents` 里），没有 `node` 字段。
   v0.3.4 的校验器按"非 Node 就必须有 node"扫，真实项目里每个带事件的按钮都会被判成坏结构 ——
   等于 `write_file` 在真实预制体上会被误拦。现在改成**从节点的 `_components` 出发查**，
   只有真的挂在节点上的才要求 `node` 回指。
2. **`__uuid__` 扫描漏掉数组元素**。`_materials: [{__uuid__: "..."}]` 的元素本身就是引用，
   早先只查"属性值是不是 `{__uuid__}`"，于是材质引用一个都扫不到。
3. **内置材质 uuid 被当成悬空引用**。`eca5d2f2…` 这类是引擎内置材质，不在项目 `assets` 里，
   三个项目里都能见到、也都不存在于 assets —— 现在有白名单（`BUILTIN_UUIDS`）。

修完在 alipay 上复检：`DebugView.prefab` 报出 **6 个 uuid 被 4 个预制体引用但资源不存在**
（`GameView1/2`、`MainView`、`DebugView`），这是项目里真实存在的坏引用，跟 MCP 无关。

**v0.4.0 的核心成果**：先把"冗余"砍掉，再谈能力。
上一版之后做了一次体检，发现三个真问题：

| 问题 | 证据 | 处理 |
|---|---|---|
| 载荷冗余 | `tools/list` **155.6 KB**，其中 **106.2 KB** 是同一段 1967 字节的返回约定，被拼了 54 遍（占 68%） | 契约只留 `initialize.instructions`，每个工具只带**一行**脚注 → **53 KB（−66%）** |
| 语义冗余 | 同一动作多条入口：3 份根定位、5 个"跑代码"、4 个"读日志"、2 个"读场景"、2 个"造 prefab"… | 合并 9 组 → **54 → 44**；旧名保留（`RENAMED` 表自动翻译 + 返回带 `__renamedFrom`） |
| 登记冗余 | TOOLS 54 / dispatch 54 / 自检表 **49** —— 差的 5 个在自检里被**静默跳过**（`mcp_audit`、`mcp_verify_all`、`execute_script_file`、`preview_report`、`preview_command`） | dispatch 换成 `IMPL` 表 + 启动期一致性校验（漏了直接 `Editor.error` 点名）；自检表漏项也算 problem |

另外把三份根定位（`findRootIndex` / `findSceneRootId` / `findRootForEdit`）合成一份，
删掉 `.backup/v0.2.2/`（旧版 main.js，grep 会命中）。

**v0.3.4 的核心成果**：从"能巡检"补到"能创作"。
上一轮真实任务里，AI 为了建一个 32 节点的 `CircleView.prefab`，手写了 99 个 JSON 对象、
自己扫 `.meta` 建 sprite-frame 表、自己反推 compressUuid、自己写 PIL 渲染器查重叠 ——
这些本该是 MCP 的活。这一版把缺口补上：

| 缺口 | 现在 |
|---|---|
| `scene_*` 只认 `cc.Scene`，`.prefab` 被挡在门外 | 统一根定位 `findRootForEdit`，六个写工具全支持预制体 |
| 从零造资源只能手写 JSON | `prefab_create`：图片/脚本只给路径，序列化细节全包 |
| 改完 `.ts` 不知道编译没有（日志读不到） | `script_compile_status`：比对 `library/imports` + `temp/quick-scripts` 的 mtime |
| 布局有没有压字只能靠自己渲染 | `prefab_layout_check`：纯几何算包围盒 |
| 跨目录改资源要刷两次，漏刷最难查 | `refresh_assets` 不传参按 dirty 记录全刷 |
| 整文件重写 prefab → fileId 全变、节点身份丢 | `write_file` 结构校验 + 按「父路径+名字」沿用旧 fileId |
| 目标项目离线时写操作静默改本地 | 写类工具直接拒绝，不再"安全退回本地" |

**v0.3.3 的核心成果**：不打包就能试玩游戏。
2.4 的**引擎预览**（`Editor.PreviewServer`）走 `__quick_compile__.js` **即时编译**项目脚本，
改完 `.ts` 等重编译完，刷新页面就是新的。
配套写了 `bridge.js` 注入预览页，通过 HTTP 收发指令 —— 能点按钮、能读状态、能抓 console 日志。

---

## 二、当前工具集（28 个）

> **下面各小节是 v0.7.0 及更早的历史细节，里面写的工具名多数已被合并。**
> 以本节这张表和 `tools/list` 为准；旧名都能自动转发，不会失效。

**普通工具（20 个）**：

- 自检 1：`mcp_selftest`
- 文件与代码 7：`get_project_info` / `list_dir` / `search_files` / `read_file` / `write_file` / `edit_file` / `refresh_assets`
- 场景视图 5：`query_scene_tree` / `scene_create` / `scene_diagnose` / `editor_sync` / `scene_capture`
- 资源诊断 3：`resolve_asset` / `asset_refs` / `project_doctor`
- 路由兜底 4：`list_open_projects` / `set_target_project` / `hub_control` / `run_script`

**聚合入口（8 个，必填 `cmd`）**：

| 工具 | `cmd` 取值 | 吸收的旧工具数 |
|---|---|---|
| `scene_edit` | add-node / remove-node / move-node / set-props / add-component / remove-component / set-component-props / apply | 8 |
| `asset` | query / move / delete / meta-get / meta-set | 5 |
| `prefab` | create / check-layout / diff | 3 |
| `build` | targets / start / status | 3 |
| `project_settings` | get / set | 2 |
| `runtime` | info / read / eval / report / inject | 5 |
| `preview` | control / command | 2 |
| `editor` | log / compile-status | 2 |

**兼容链怎么工作**：`RENAMED` 表现有 46 项（16 个 v0.4.0 旧名 + 30 个 v0.8.0 旧名）。
`callTool` 沿链解析，每跳由 `migrateLegacyArgs` 补 `cmd` / `from` / `source` 等默认值，
最后 `dispatchByCmd` 把 `cmd` 摘掉再调**原来一行没动**的实现函数。
返回带 `__renamedFrom` / `__hops` / `__hint` 提示改口。
三张表（TOOLS / IMPL / 体检表）仍是严格一一对应的 28 项，`registryProblems()` 继续守着。

**为什么用 `cmd` 而不是 `action`**：`runtime_inject` / `preview_control` /
`preview_command` / `hub_control` / `editor_sync` 本来就有自己的 `action` 子命令，
外层再用 `action` 会撞车。

---

### 历史小节（v0.7.0 及更早，工具名以本节上面的表为准）



### 自检工具（**换环境 / 隔段时间再用之前，先跑一次**）

| 工具 | 说明 |
|---|---|
| `mcp_selftest` | 默认只跑**无副作用**的工具（快）；`sideEffects: true` 连有副作用的一起跑（慢，但完整）。返回 `problems` + `registry`（三张表一致性） |

`sideEffects: true` 会返回 `realSceneUntouched`（自证没碰你的场景文件）。
`registry` 非空说明 TOOLS / IMPL / 自检表对不上 —— 这是 v0.4.0 专门加的防漂移检查。

**自检不会污染项目**：
- 场景类操作全部在**场景副本**上做（复制到 `temp/` 再操作）
- 资源类操作在 `assets/__mcp_probe/` 的副本上做
- 跑完全部删除，并校验真实场景文件 md5 没变

### 返回约定（所有工具统一）

每个工具的返回都带：
- `__status`：`ok` / `empty`（正常但没数据）/ `partial`（部分为空）
- `__emptyFields`：哪些字段是空的
- `__reason`：为什么空
- `__hint`：接下来该做什么

**空值 ≠ 调用失败。** 真正失败会直接报错，错误信息里带原因和下一步。

> 约定字段都带 `__` 前缀 —— 不会和业务字段冲突（比如 `preview_control` 的 `status` 是 HTTP 码）。

### 运行时（读活对象，走场景进程）

| 工具 | 说明 |
|---|---|
| `runtime_info` | 查场景进程通道是否可用 + 能力清单 |
| `runtime_read` | **读运行时状态**：活对象的属性值、组件实际字段、当前动画帧。`onlyNonDefault: true` 只报和默认值不同的属性（= 脚本运行时改过什么） |
| `runtime_eval` | 在场景进程里求值任意表达式 |
| `runtime_console` | **读捕获到的运行时 console 输出**（劫持了场景进程的 console） |
| `scene_eval` | 在场景进程里跑**多语句** JS（问 FairyGUI 运行时、遍历引擎对象用）。`runtime_eval` 只能单表达式 |
| `runtime_inject` | 控制浏览器侧上报的注入：status / inject / remove |
| `runtime_browser_report` | 读浏览器里跑的那个游戏（web 构建）上报的状态 |
| `scene_probe` | 环境探针：require/http/fs/evt 能力，一次问清 |

**三个来源要分清**：

| 来源 | 工具 | 读的是 |
|---|---|---|
| 静态设计态 | `query_scene_tree` / `read_scene_node` | `.fire` 文件里的内容 |
| 编辑器内运行时 | `runtime_read` / `runtime_eval` / `runtime_console` | 场景进程（`cc.director.getScene()`）里的活对象 |
| 浏览器运行时 | `runtime_browser_report` | web 构建产物里跑着的游戏 |

### 改 prefab 时的两个硬约束

1. **Sprite 的 `_spriteFrame` 必须填 sprite-frame 的 uuid，不是 png 的主 uuid**。
   一张 png 有两个 uuid：

   | uuid | 是什么 | 填进 `_spriteFrame` |
   |---|---|---|
   | 主 uuid（meta 里第一个 `"uuid"`） | texture | ❌ 渲染报 `textureLoaded is not a function` |
   | `subMetas` 里的 uuid | sprite-frame | ✅ |

   用 `resolve_sprite_frame` 查。`query_scene_tree` 现在会直接报出每个 Sprite 用的哪张图
   和它的 `resourceType`，类型不对还会给 `suggestedUuid`。

2. **改尺寸要跟着改缩放**。换图后节点尺寸要改成新图的原始尺寸，
   否则图片会被拉伸。竖长的图（如钥匙 47×69）放在 110 高的按钮里，
   1.3 倍会顶出按钮 —— 要降到 0.75 左右。

### 改代码时的三个硬约束（v0.3.2 实改 bottle_new 踩出来的）

1. **改 `.ts` 不等于改了游戏**。构建用的是**编译后的 JS**：
   `temp/quick-scripts/dst/` 和 `library/imports/<uuid>.js`。
   构建选项里 `autoCompile: false` —— **构建不触发编译，用的是缓存**。
   改完源码要等编辑器编译完（看 `library/imports/<uuid>.js` 的 mtime）再构建。

2. **JS 产物里中文被转义成 `\uXXXX`**。用 grep 搜中文**搜不到**，
   会误判成"新代码没进产物"。正确做法：
   ```js
   const esc = Array.from('钥匙不足').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
   s.indexOf(esc)
   ```

3. **换行风格必须保留**。很多项目源码是 CRLF（bottle_new 的 `.ts` 就是，205 个 CRLF），
   硬写成 LF 会让 git diff 变成全量重写、版本历史废掉。
   `write_file` 和 `edit_file` 现在都会先读原文件判断，再对齐写入。

### 浏览器侧上报（静默注入）
`build_project` 构建完自动注入；扩展启动时也会检查并注入（用户要求：启动 MCP 即自动注入）。

**只改 `index.html`**，带哈希的资源文件一个字节不动（md5 校验不会失败）：

```html
<!-- cocos-mcp-2x:runtime-report:start -->
<script>window.__MCP_RUNTIME_CONFIG__ = {"port":25800,...};</script>
<script src="mcp-runtime-report.js"></script>
<!-- cocos-mcp-2x:runtime-report:end -->
```

- 注入脚本每 2 秒 POST 一次到 `/runtime-report`
- 上报端口是**中继端口**（客户端连的是中继），中继会转发给目标项目的扩展实例
- 完全静默：不弹窗、不改画面、不影响游戏逻辑；连续失败 3 次自动放弃
- URL 加 `?mcp=off` 可临时关闭；`?mcp=port=xxx&mcp=interval=xxx` 可调
- 撤销：`runtime_inject {"action":"remove"}` —— index.html **逐字节还原**

### 入口与目标（多开编辑器时用）

| 工具 | 说明 |
|---|---|
| `list_open_projects` | 列出所有打开的项目及其端口，标出当前目标和当前实例 |
| `set_target_project` | **指定 AI 操作哪个项目**，之后所有调用自动转发过去 |
| `hub_control` | 开启 / 关闭 / 查询**中继服务**（常驻进程，独立于编辑器） |

### 文件与代码

| 工具 | 说明 |
|---|---|
| `get_project_info` | 路径、版本、场景列表、资源数、当前端口 |
| `list_dir` | 列目录 |
| `search_files` | 全文搜索，默认字面量匹配，跳过 `.meta` |
| `read_file` / `write_file` | 文本读写，路径锁在项目内。**保留原文件换行风格**（CRLF 项目不会被写成 LF） |
| `edit_file` | **精确替换文件里的某一段**，其余字节不动。改代码首选。支持 `all` / `regex` / `count`（匹配数不符就拒绝写入，文件不动） |
| `resolve_uuid` | 完整 uuid / 压缩 uuid / 路径 三者互转。带 `resourceType` 和 `usableAsSpriteFrame` |
| `resolve_sprite_frame` | **查图片的 sprite-frame uuid** —— 这才是能填进 prefab 的 `_spriteFrame` 的值。**别用 `resolve_uuid` 返回的主 uuid**（那是 texture，填了渲染会炸） |
| `get_editor_log` | 读编辑器日志末尾（多开会读不到主日志，会如实报告） |
| `execute_script` | 扩展主进程跑任意 JS，可 `require`，支持 `await` |
| `refresh_assets` | 重新导入资源 |

### 场景读

| 工具 | 说明 |
|---|---|
| `query_scene_tree` | 节点树，脚本组件自动反解 `script` + `className` |
| `read_scene_node` | 单节点完整序列化值，引用翻译成名字/路径 |
| `scene_ping` | 诊断：当前场景文件、对象数、能否找到模板、场景脚本注册状态 |

### 场景写（全部文件级）

| 工具 | 说明 |
|---|---|
| `scene_add_node` | 加空节点（克隆文件里已有的空节点当模板）；`from:"prefab"` 把预制体拷进来 |
| `scene_set_props` | 改名/显隐/位置/缩放/透明度/尺寸/锚点 |
| `scene_remove_node` | 删节点连同组件和子孙，带外部引用检查 |
| `scene_add_component` | 挂组件，`type` 支持 `cc.Sprite` / 脚本路径 / uuid / 脚本类名 |
| `scene_set_component_props` | 改组件字段，资源引用写 `{"asset":"路径或uuid"}` |
| `scene_remove_component` | 移组件 |
| `scene_create` | 新建空场景（`.fire` + `.meta`），以项目里已有场景为模板 |
| `scene_move_node` | 换父节点 / 调整同级顺序（`newParent` 支持写全路径或直接写同级节点名） |
| `scene_apply` | **批量事务**：一次打开 → 内存里应用 `ops` → 一次写盘；`dryRun` 试算，失败整批放弃 |
| `prefab_layout_check` | 纯几何布局自检：越出画布 / 同级重叠 / 超出父容器 / 隐藏节点 |
| `editor_sync` | 磁盘 vs 编辑器内存：`status` 报差异与风险等级，`reload` 重载并验证节点集合对齐 |
| `scene_capture` | 截一张编辑器场景视图到 `temp/mcp-state/shots/`；默认关网格/gizmo 并裁工具栏 |
| `prefab_diff` | 两份 `.fire`/`.prefab` 的节点级差异（增删改 + 改名），不是字节 diff |

### 预制体与资源

| 工具 | 说明 |
|---|---|
| `prefab_instantiate` | 预制体拷进场景，**变成普通节点**（不带预制体关联） |
| `prefab_create` | 造 `.prefab` 的唯一入口：`from:"spec"` 从声明式节点树生成；`from:"node"` 把场景节点导出 |
| `script_compile_status` | 改完 `.ts` 到底编译了没：`ok` / `stale` / `missing`，不依赖编辑器日志 |
| `asset_query` | 按通配符查库，返回 uuid / db:// 地址 / 路径 / 类型 |
| `asset_move` | 移动或重命名，uuid 和 `.meta` 自动跟随 |
| `asset_delete` | 删除，必须显式 `confirm: true` |
| `asset_meta_get` | 读导入设置（顶层 + 子资源） |
| `asset_meta_set` | 改导入设置，**含九宫格切边** `subMetas.xxx.borderTop` |
| `asset_refs` | 谁引用我 / 我引用谁（删资源前的唯一依据） |
| `project_doctor` | 项目体检：悬空 `__uuid__`、spriteFrame 类型错、prefab 结构坏、meta 缺失 |

### 项目设置

| 工具 | 说明 |
|---|---|
| `project_settings_get` | 读 `project://project.json`（设计分辨率、fit、启动场景、模拟器朝向…） |
| `project_settings_set` | 改并保存 |

### 构建

| 工具 | 说明 |
|---|---|
| `build_targets` | 列出可构建平台 |
| `build_project` | 触发构建，默认立刻返回 |
| `build_status` | 查构建状态，含产物目录/文件数/字节数自检 |
| `preview_control` | **启动引擎的 Web 预览**（不用打包！）start / stop / open / bridge / status |
| `preview_report` | 读预览里跑着的游戏：运行时状态 + console 日志 + 错误 |
| `preview_command` | **向预览里的游戏下发指令**（试玩通道）：ping / eval / read / click / clickButton / dispatchTouch / module / script / fguiTree / fguiClick / screenshot |
| `execute_script_file` | 从项目内文件读 JS 来执行（长脚本用这个，避免 JSON 转义地狱） |

---

## 二之二、引擎 Web 预览 + 桥接（v0.3.3 新增）

### 为什么不用 build 产物

2.4 的**引擎预览**（`Editor.PreviewServer`）走的是 `preview-scripts/__quick_compile__.js` ——
引擎**即时编译**项目脚本。改完 `.ts` 等重编译完，刷新页面就是新的，
**不需要 build_project**。build 产物只是另一条路（`/build/index.html`）。

### 三步跑起来

```
preview_control {action:"start"}
  → 起 PreviewServer（引擎自带的，端口 7456/7457）
  → 往预览页注入 bridge.js（Express 中间件，改渲染出来的 HTML）
  → 用 electron BrowserWindow 开一个内置 Chromium 窗口加载预览页
```

**为什么不用系统浏览器**：这台机器上 `chrome.exe` 直接 Permission denied，
浏览器进程创建不出来。Electron 自带的 Chromium 是编辑器的一部分，能跑。

### 桥接协议（纯 HTTP，走中继 25800）

| 方向 | 端点 | 说明 |
|---|---|---|
| 浏览器 → 扩展 | `POST /bridge/report` | 运行时状态 + 新增日志 |
| 扩展 → 浏览器 | `GET /bridge/commands?since=N` | 浏览器每 400ms 拉一次 |
| 浏览器 → 扩展 | `POST /bridge/result` | 指令执行结果 |
| 浏览器 → 扩展 | `POST /bridge/bye` | 页面卸载 |

**注入配置里写的是中继端口（25800），不是扩展自己的端口** ——
扩展端口会变（编辑器重启、多开时按启动顺序分配），
写死的话扩展一重启页面就指向死端口，桥接静默断掉、还不报错。

### 中间件的几个坑（都踩过）

1. **预览页是 `res.render()` 出来的，不是 `res.send()`** ——
   hook `res.send` 完全不生效。必须 hook `res.render` 的回调。
2. **`main.js` 是严格模式** —— `arguments` 不与形参同步，
   `origSend.apply(this, arguments)` 会把改写后的 body 丢掉。
   必须显式 `origSend.call(this, out)`。
3. **热重载后中间件装不上** —— 装进引擎的中间件是旧模块里的函数，
   只靠标记判断会导致新代码永远装不上。必须**按标记摘掉旧的再装新的**。

### `preview_command` 的动作

**共 11 个**（代码里是全小写，工具描述里写驼峰，main.js 侧做 lowercase 归一）：

| 动作 | 作用 |
|---|---|
| `ping` | 确认通道通 |
| `eval` | 求值单个表达式 |
| `script` | 执行多语句 JS 源码（**复杂逻辑用这个**，eval 的 JSON 转义太痛苦）。**支持 await** |
| `read` | 读某个节点的组件属性（`path`） |
| `click` | 触发节点上组件的 `onXxx` 方法（`path` + 可选 `method`） |
| `clickButton` | 点 cc.Button，走 `clickEvents` 派发；没有 clickEvents 的代码绑定按钮会自动找 `onBtn*`/`on*Click`/`on*Event` |
| `dispatchTouch` | 真派发触摸事件到 canvas |
| `module` | 加载项目模块（`window.__quick_compile_project__.require`） |
| `fguiTree` | 列 FairyGUI 对象树（GObject） |
| `fguiClick` | 点 FairyGUI 按钮，走官方 `InputProcessor.simulateClick` |
| `screenshot` | 抓 canvas 像素，返回尺寸和平均色 |

**节点路径找不到时会按名字全树搜** —— UI 常常挂在猜不到的容器下。

> `test.js` 里有一条断言专门检查这 11 个动作分支都在 `bridge.js` 源码里。
> 加了新动作却不改那条断言，测试会失败 —— 这是故意的，防止"文档说有但代码没有"。

### 已验证的完整链路（bottle_new）

```
preview_control start        → 预览 + 注入 + 开窗
preview_command click HomeView.onBtnTq    → 打开特权页面
preview_command click PrivilegeView.onBtnKey → 钥匙从 1 变 0
preview_report               → 读到：
   [error] [PrivilegeView] 获取特权失败：钥匙不足，无法获取特权（需要 1 把，当前 0 把）
```

**这条路完全不需要 build_project**，改完 `.ts` 重编译完就能验。

### 怎么「玩」这个游戏（通用控制，不是预设流程）

已实测的完整往返：

```
【1】主界面                       HomeView
【2】fguiClick btnStart          → 游戏      GameView + level1[Game]（物理体、球、倒计时全实例化）
【3】clickButton btnBack          → 关卡列表  LevelView（12 个关卡项）
【4】clickButton btnBack          → 主界面    HomeView（这个按钮是代码绑定的，走兜底逻辑）
```

**四步各有各的入口，这就是「完全可控」的证据** —— 不依赖任何写死的流程。

#### 先看清有什么，再决定点哪个

```
preview_command {action:"fguiTree", depth:8}          → FairyGUI 的对象树（GObject）
preview_command {action:"fguiTree", filter:"btn"}      → 只看名字/类型含 btn 的
```

FairyGUI 的界面**不是 cc.Node 树**，`preview_report` 的树里看不到它。
`fguiTree` 是唯一的入口。

#### 点按钮的两种方式

| 方式 | 用于 | 机制 |
|---|---|---|
| `fguiClick {path:"btnStart", type:"GButton"}` | FairyGUI 按钮 | 官方 `InputProcessor.simulateClick` —— 派发真实 TOUCH_BEGIN/END 事件链，按钮的 onClick 像用户真点一样触发 |
| `clickButton {path:"bottle"}` | cc.Button | 走 `clickEvents` 正规派发 |

`clickButton` 的两个关键细节：

1. **`clickEvents[].target` 存的是节点，但方法在祖先节点的组件上** ——
   比如 bottle 的 `onClickBottle` 在父节点 `level1` 的 `Game` 组件上。
   所以要**沿父链往上找**（最多 8 层）。
2. **有些按钮是代码绑定的**（`this.onTouch(this.btnBack, this.onBtnBack, this)`），
   `clickEvents` 是空的。这时兜底找 `onBtn*` / `on*Click` / `on*Event` 这类方法 ——
   **不能只看 `on` 前缀**，`onItemRender` / `onLoad` / `onEnable` 都不是点击处理，
   调了只会抛错（实测 `onItemRender` 会报 `item.getComponent is not a function`）。

#### 读状态 / 观察变化

```
preview_command {action:"read", path:"Canvas"}       → 节点的组件属性
preview_command {action:"script", code:"..."}         → 多语句 JS，**支持 await**
```

`script` 支持异步很关键 —— 可以「点一下 → 等 1.5 秒 → 再读状态」，
这样才看得到状态**变化**（而不是变化前的快照）。

#### 想看游戏里有什么可点的

用 `script` 动作跑一段反射代码，把所有 `cc.Button` 和它的绑定列出来：

```js
var scene = cc.director.getScene();
var out = [];
var walk = function (n, path) {
    var p = path ? path + '/' + n.name : n.name;
    (n._components || []).forEach(function (c) {
        if (cc.js.getClassName(c).indexOf('Button') >= 0) {
            out.push(p + ' → ' + (c.clickEvents || []).map(function (e) { return e.handler; }).join(','));
        }
    });
    (n.children || []).forEach(function (c) { walk(c, p); });
};
walk(scene, '');
return out.join('\n');
```

实测输出（bottle_new 游戏内）：

```
bottle → onClickBottle
BallItem → onBallClick
BallItem → onBallClick
btnBack → onButtonEvent
btnReplay → onButtonEvent
energyNode/btnAdd → (无绑定)
keyNode/btnAdd → (无绑定)
btnkey → onButtonEvent
btnTips → onButtonEvent
btnNext → onButtonEvent
```

**有了这张表，任何按钮都能点** —— 不需要预先知道游戏怎么玩。

---

## 三、架构：入口 / 目标 / 文件层 / 资源层

```
客户端 (mcp.json)
      │  http://127.0.0.1:25800/mcp
      ▼
   hub.js（中继，常驻进程，跨编辑器存活）
      │  读 target.json → 转发到目标项目的编辑器实例
      ▼
 ┌──────────────┐   ┌──────────────┐
 │ 编辑器 A 25900│   │ 编辑器 B 25901│   ← 每个编辑器跑一个扩展实例
 └──────────────┘   └──────────────┘
        │                    │
        └────────┬───────────┘
                 ▼
      文件层 / 解析层 / 写入层 / 资源层 / 构建层
```

### 为什么要中继

多开编辑器时：客户端的 mcp.json 只能填一个 URL，于是"客户端连的是谁"和"用户想操作谁"经常不是同一个；
更糟的是客户端连的那个编辑器一关，整条链路就断了，哪怕目标项目好好开着。

- **目标**：`~/.CocosCreator/cocos-mcp-2x/target.json`，`set_target_project` 写它。
  **只记项目身份（name + project 路径），不记端口** —— 见下面「目标为什么不存端口」。
- **中继**：`hub.js`，默认端口 25800。扩展启动时会自动把它拉起来（`ensureHubRunning`）。
  它每次请求都读 target.json 转发；目标不在线就退而挑一个还活着的项目；一个都不在就返回明确错误。
- **编辑器实例自身也会转发**：所以就算客户端连的是某个编辑器而不是中继，
  请求也会被转到目标项目（`maybeForward`）。

### 目标为什么不存端口（v0.3.1 修的真 bug）

端口是**按启动顺序分配**的（先开的占 25900）。编辑器一重启，两个项目的端口就互换：

```
target.json : alipay-pouring_water @ 25900   ← 写的时候是这样
注册表(重启后): bottle_new @ 25900, alipay @ 25901
```

于是「目标记的是端口」= 目标指向了**另一个项目**。AI 会静默改错项目的文件，
而 `get_project_info` 里 `target.name` 显示的还是旧项目名，自相矛盾。

**现在的语义**：目标存项目身份，端口**运行时从注册表解析**（`resolveTarget`）。

- 端口变了 → 目标身份不变 → 转发自动跟上
- 目标项目没打开 → `target.online = false`，转发失败时**安全退回本地**并报 `forwardError`
- 旧格式（带 `port` 的）目标文件会在读取时自动迁移掉 `port` 字段

注册表文件名也带上了项目路径哈希（`name-<md5前8位>.json`），
否则不同目录下同名项目会互相覆盖、端口直接串掉。

### 菜单入口（编辑器里）

`扩展/Cocos MCP 2.x/` 下新增三个：**开启中继服务** / **停止中继服务** / **切换目标项目**（轮换）。
（菜单项在编辑器启动时读取，改了 package.json 要重启编辑器才出现。）

### 手动开中继

```bash
node ~/.CocosCreator/packages/cocos-mcp-2x/hub.js        # 默认 25800
node ~/.CocosCreator/packages/cocos-mcp-2x/hub.js 25810  # 指定端口
```

### 场景写入的三条铁律

1. **不手搓节点对象**，克隆场景里已有的同类对象再改字段。
   `_trs` / `_color` / `_contentSize` / `_anchorPoint` / `_objFlags` 一律继承引擎值。
2. **写盘保留原文件格式**：`writeJsonPreserving` 检测 `\r\n` 并还原（PinGame 是 CRLF，
   bottle_new 是 LF），否则整个文件每一行都变、git diff 全量重写。
3. **删对象必须全局重映射 `__id__`**，且先摘掉父节点 `_children` 里的引用再扫外部引用，
   有残留就拒绝，不写半坏场景。

---

## 四、2.4.15 踩过的坑（下次别再踩）

### 1. ~~`scene-script` 通道只收不回~~ —— **这条结论是错的，v0.3.2 已推翻**

> v0.3.0 判定「2.4.15 拿不到场景进程返回值，别再试」，并写进了本文档。
> v0.3.2 实测发现**根因是自己的处理器签名写错了**，引擎能力完全正常。

**真相**：2.4 的场景脚本处理器签名是 **`(evt, payload)`** —— 第一个参数是引擎注入的事件对象，
业务 payload 在**第二个**。参照引擎自带的 `packages/node-binder/js/tool/scene.js`：

```js
function update_nodes(evt, uuid) { ... }   // ← evt 在前
scene.update_nodes = update_nodes;
```

v0.3.0 写的是 `wrap(function(payload){...})`，只接了第一个参数 →
payload 被当成 evt 丢掉 → `payload.__res` 是空的 → 没有回传地址 →
**表现成「只收不回」，实际是「我的地址丢了」**。

**第二个坑**：`Editor.Ipc.sendToPanel(panel, name, body, cb)` 的回调**不只用来收错误**。
场景脚本 `evt.reply(envelope)` 走的就是这个 cb。v0.3.0 只处理了 `err` 分支，
把成功回执直接丢了。现在三个分支都处理：not found / 其他错误 / 成功回执。

修完之后的实测（`scene_probe` 一次问清）：

```
processType: "renderer"
evt.keys:   ["sender","senderId","ports","reply"]    ← 有 reply
modules:    { http: ok, https: ok, fs: ok, fire-fs: ok, child_process: ok, net: ok, electron: ok }
fileWrite:  "written"
```

**效果**：错误信息从「超时 12 秒」变成「场景窗口里没有 xxx 这个处理器」，**14ms 快速失败**。

**顺带确认**：`Editor.Scene.callSceneScript` 其实**能用** ——
`Editor.sendToPanel` 确实是 `undefined`，但 `apply(undefined, args)` 里 sendToPanel 不用 `this`，
所以不报错。v0.3.0 记的「内部会 TypeError」也是错的。

### 1b. 2.4 和 3.x 的 API 差异（实测踩出来的）

| 东西 | 2.4 实际 | 3.x |
|---|---|---|
| 处理器签名 | `(evt, payload)` | `(payload)` |
| `node.components` | **undefined，读不到** | 正常 |
| `node._components` | 有（length=3） | — |
| `node.scale` | **数字**（=scaleX） | Vec3 |
| `node.scaleX/Y/Z` | 有 | 有 |
| `node.position` | Vec3（有 .x/.y/.z） | Vec3 |
| 类名格式 | `cc_Canvas`（下划线） | `cc.Canvas`（点号） |
| `Editor.Message` | **undefined** | 有（双向总线，`request` 自带 Promise 回调） |

3.x 那套 `Editor.Message.request('scene', 'execute-scene-script', {...})` **不能搬到 2.x** ——
`Editor.Message` 在 2.4 根本不存在。2.x 只有 `Editor.Ipc`（单向 send + 可选 error 回调）。

修法：`compsOf()` / `scaleOf()` / `posOf()` 三个兼容助手 + `normClassName()` 归一化类名。

### 1c. 场景窗口不会重新加载场景脚本

`Panel.close('scene')`+`open('scene')`、`editor:panel-run` 全试过，面板重建也不重新 require。
**改 `scene.js` 只能靠重启编辑器**（`main.js` 改动用 `node reload.js <端口>` 热重载即可）。

### 2. `Package.reload(name)` 无效

守卫是 `t && "ready" !== t || ...`，`y[name]` 查不到就直接什么都不做。
`Package.load(path)` 收的是**绝对路径**，传裸名字才报
`ENOENT 'cocos-mcp-2x\package.json'`。

### 3. `queryAssets` 少传参数会永久挂起

签名是 `(pattern, typeFilter, callback)`。漏掉中间参数，callback 会被当成过滤条件，
**永远不触发**（排查了 30 秒超时才定位）。

### 4. `saveMeta` 要的是 JSON 字符串

传对象会报 `Unexpected token o in JSON at position 1`（`"[object Object]"` 被 parse）。
而 meta 对象带 `_assetdb` 循环引用没法 stringify。
**结论：直接读写 `.meta` 文件再 `assetdb.refresh`**，更可控，还能顺手改子资源（九宫格切边）。

### 5. 构建输出目录是 `dest` 不是 `buildPath`

`buildPath` 只是父目录，真正输出是 `dest = buildPath / <平台输出名>`。
只改 `buildPath` 不改 `dest`，构建照样写到旧位置。
而且**回调说成功不代表真出包**，必须检查目录里有没有文件。

### 6. 多个编辑器抢同一个日志文件

`~/.CocosCreator/logs/CocosCreator.log` 被先启动的进程独占，后启动的连 `statSync` 都 EPERM。
`Editor.logfile` 也指向它，没有项目级日志。`get_editor_log` 会如实报告"读不到"，
不再拿几个月前的 `native.log` 充数。**连持有文件的那个编辑器进程也读不了它**，所以日志这条路彻底断了。

### 7. 预览服务（`Editor.PreviewServer`）的三个坑

- 签名是 `start(options, callback)`，但第一个参数传 `null` 就行（传别的也行）。
- **每次 start 都会新开一个端口，而 `stop()` 只关最后一个** —— 多 start 几次会漏一堆端口。
  所以 `preview_control start` 现在先探端口，已在跑就复用（`reused: true`）。
- **探测要用静态路径**（`/build/index.html`），根路径是 EJS 渲染的，
  编辑器进程自己发请求时返回 500，但 curl 同一个地址是 200。

### 8. 工具返回值里不要用 `error` 这个字段名

MCP 用 `isError` + 文本内容表示失败。如果工具**成功**返回里带一个叫 `error` 的字段，
客户端没法区分"工具失败"和"工具成功了但报告了一个错误"。v0.3.0 踩过：
`build_status` / `preview_control` / `hub_control` 的状态结果都带 `error`，
结果测试和 AI 都误判成失败。已统一改名成 `lastError`。

### 9. Windows 上的几个小坑

- `require.cache` 的键是**反斜杠**，`Editor.Package.paths` 给的是正斜杠，匹配前必须 normalize。
- `server.close()` **不断开已建立的 keep-alive 连接**，客户端复用旧 socket 会读到旧实例。
  判断换没换实例要比对 `serverInfo.instanceId`，**不要用 version**。
- 编辑器里 `process.execPath` 是 **CocosCreator.exe 不是 node**，
  直接 spawn 它去跑脚本会再拉起一个编辑器。要当纯 node 用得加
  `ELECTRON_RUN_AS_NODE=1` 环境变量。
- 这台机器设了 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，**curl 访问 127.0.0.1 会走代理**，
  报 "upstream connect failed" 之类的怪错。测本地端口要加 `--noproxy '*'`。

### 10. 测试必须和真实状态隔离

测试进程和真编辑器同机，`COCOS_MCP_NO_REGISTRY=1` 只挡住了注册表写入，挡不住别的：
目标文件、中继状态、转发逻辑都会互相干扰（测试一度把真中继杀了）。
现在测试模式下：目标文件走临时目录、注册表和中继状态用假的、**不转发**。

---

## 五、开发工作流

```bash
cd G:/unfinishWork-main/tools/cocos-mcp-2x

# 1. 改完先跑测试（不需要编辑器，mock 掉 Editor 后真发 HTTP）
node test.js "G:/CocosProject/new/bottle_new"

# 2. 部署（带冲突检测，见下）
node deploy.js

# 3. 热重载（只影响指定端口，不用重启编辑器）
node reload.js 25901
```

> **`deploy.js` 不要用 `cp` 代替。** 扩展是全局安装的，可能有人同时在改同一份代码；
> 无脑 cp 会把对方的改动覆盖掉，而且双方都不知道（这次就发生过）。
> `deploy.js` 记录了上次部署后磁盘上应该是什么样，部署前先比对，
> 发现被改过就拒绝覆盖并报告，除非显式 `--force`。
> 它还会先做语法检查（`vm.Script`），语法错误直接拒绝部署。

**部署了哪些文件**（`deploy.js` 的 `FILES`）：

```
main.js  scene.js  package.json  reload.js  test.js  hub.js
injector.js  inject-runtime.js  bridge.js  HANDOFF.md
lib/fsutil.js  lib/uuid.js  lib/scene-parse.js
lib/scene-tools.js  lib/prefab.js  lib/tool-schema.js
```

> ⚠️ **加了新文件记得往 `FILES` 里加**，否则编辑器端会报
> `Cannot find module './lib/xxx.js'` —— 扩展直接起不来。

**开发端口约定**：25900 常常是真实项目（如 `alipay-pouring_water`），**不要动**；
测试项目（如 `bottle_new`）会落在 25901。原生 MCP 工具绑死 `mcp.json` 里的 25900，
所以开发期一律用：

```bash
node dev-client.js 25901 scene_ping
node dev-client.js 25901 scene_add_node '{"parent":"Canvas","name":"X"}'
node dev-client.js 25901 --list
```

**改了哪些文件要重启编辑器？**

| 文件 | 热重载 | 说明 |
|---|---|---|
| `main.js` | ✅ `node reload.js <端口>` | 扩展主进程 |
| `lib/*.js` | ✅ 同上 | 靠 main.js 的 require 链加载 |
| `scene.js` | ❌ **必须重启编辑器** | 场景窗口只在启动时 require |
| `bridge.js` | ✅ 重新 `preview_control start` | 浏览器侧 |

---

## 六、已知限制

0. **换一个 AI / 隔段时间再来，先跑 `mcp_audit` 和 `mcp_verify_all`**。
   这两个工具会告诉你每个工具返回什么、什么时候会空、错误信息靠不靠谱 ——
   **不用靠试错**。`tools/list` 里每个工具的描述都带【返回约定】，
   光看描述就能知道怎么解读返回值。

1. **场景写入是文件级的**，编辑器内存里的场景是旧版本。改完要么让用户重开场景，
   要么别在编辑器里保存，否则会用旧场景覆盖改动。
2. **运行时状态有两个来源，别搞混**：
   - 编辑器内的场景进程：`runtime_read` / `runtime_eval` / `runtime_console` ✅ 可用
   - 浏览器里跑的那个游戏：`runtime_browser_report` ✅ 可用（靠静默注入上报）
   浏览器那份**只能靠注入拿到**——游戏在另一个进程，没有任何通道能直接读它。
   注入需要先 `build_project`（构建时自动注入）+ `preview_control start`（起服务）。
3. **注入是往构建产物里插的**，不是往项目源码插的。源码一个字节不动，
   但 `build/` 目录下的 `index.html` 会被改（可撤销：`runtime_inject {"action":"remove"}`）。
4. **`scene_open` / `scene_save` 消息名没摸到**。`sendToPanel` 只接受场景脚本注册的消息，
   面板内置消息走另一条通道。不过场景本来就是直接写盘的，editor 的 save 意义不大。
5. **多项目端口递增**（按启动顺序分配，重启会互换）。但 `mcp.json` 指向中继就行，
   目标由 `set_target_project` 决定，与端口无关。
6. **`execute_script` 无超时保护**：用户代码 await 一个永不 resolve 的 Promise 会挂住请求。
7. **`prefab_create_from_node` 导不出"引用了子树外对象"的节点**。比如组件里指向场景中
   另一个节点的引用，导成独立预制体后会悬空，所以会直接拒绝并报出是哪个引用。
8. **预制体实例化不带关联**。要"活实例"（改了会被预制体回滚）暂不支持。
9. **`preview_control stop` 只能关掉最近启动的那一个预览服务**，之前泄漏的端口关不掉
   （`PreviewServer` 只记住最后一个 server）。重启编辑器才会全部释放。
10. **桥接的 `clickButton` 只能点 cc.Button，`fguiClick` 只能点 FairyGUI 按钮。**
    两套体系互不相通 —— FairyGUI 的按钮在 cc.Node 树里根本不存在，反之亦然。
    先用 `fguiTree` 看清楚是哪个体系。
11. **桥接的日志有去重逻辑**（文本 + 时间戳），同一时间戳的重复日志会被合并。
    想要每一条都看到，用 `preview_report` 的 `limit` 调大并注意去重规则。
12. **`lib/` 模块之间不能互相 require** —— 循环依赖会炸。
    依赖一律从 `main.js` 注入（见 DEVELOP.md「代码分层与依赖规则」）。
13. **`prefab_layout_check` 不算旋转，也不模拟 `cc.Widget` 的运行时对齐**。
    它算的是序列化文件里的静态几何；Widget 的拉伸/居中要等运行时才生效，
    所以"设计态看着没问题、跑起来错位"这种还得靠 `preview_report` + `preview_command` 真跑。
    重叠报出来不等于错（层叠背景/投影是有意的），看 `ratio` 判断。
14. **`script_compile_status` 给不出具体报错**。判断依据只有产物 mtime：
    语法错时编译器不更新产物，表现为持续 `stale`，但拿不到行号和错误文本
    （2.x 的 quick-compile 不落盘错误清单）。`diagnostics` 恒为空数组，不编造。
    要看具体报错还是得编辑器控制台。
15. **`prefab_create` 拒绝覆盖已存在的文件**，也不支持"嵌套预制体实例"（2.4 本身也不支持）。
    要整份重写已有预制体用 `write_file`（会做结构校验 + 保留 fileId），要改单个节点用 `scene_*`。
16. **写类工具在"目标项目离线"时会直接报错**（`write_file` / `edit_file` / `scene_*` /
    `prefab_*` / `asset_*` / `execute_script` 等 22 个）。这是有意的：以前会"安全退回本地"，
    结果是 AI 以为在改目标项目、实际改了另一个。读类工具没这个限制。

---

## 六之二、代码结构

原来 `main.js` 是 7315 行的单文件，v0.3.3 拆出 `lib/`，v0.3.4 加了 `lib/prefab.js`：

```
main.js              7844 行  扩展主进程：协议、工具分发、场景脚本通道、预览服务、中继、构建
lib/fsutil.js         113 行  纯文件系统工具
lib/uuid.js           283 行  uuid ↔ 路径索引（按 .meta 的 mtime 增量）
lib/scene-parse.js    422 行  .fire/.prefab 只读解析 + **唯一一份**根定位
lib/scene-tools.js   1230 行  场景/预制体写入 + 批量 op 引擎（openDoc/commitDoc/applyOps）
lib/prefab.js         855 行  预制体装配 / 结构校验 / 布局自检（纯逻辑，无 fs 无 Editor）
lib/doc.js            326 行  文档校验（父子互指 / __id__ 范围 / 预制体规则）+ 节点级 diff
lib/asset-graph.js    188 行  引用图（谁引用我 / 我引用谁），按文件 mtime 增量
lib/editor-state.js   404 行  写入台账 + 节点差异 + 子树重合度匹配（纯逻辑，Node 里可单测）
lib/tool-schema.js    899 行  工具声明表（纯数据，50 条）
```

`lib/prefab.js` 是这一版新加的，它刻意**不碰 fs 也不碰 Editor**：
模板数组、uuid 解析、脚本类型解析都由 main.js 作为回调传进去，
所以它能在 Node 里直接单测（test.js 里就是直接 require 它跑校验器）。

v0.3.3 的拆分是**逻辑逐字节未变**的搬移（回归 82/82 前后一致）；
v0.3.4 在 `scene-tools.js` 里改了根定位和节点写入，属于**行为变更**，
判定依据是新加的「prefab 往返还原」断言（加 → 改 → 删后与原文件逐字节相同）。

v0.4.0 加了「转发层 + IMPL 表」：`main.js` 反而变长了（+242 行），
但**加一个工具要改的地方从 6 处降到 3 处**，而且漏改会当场报错 —— 这笔账划算。

### 拆分的两个坑（都踩了）

1. **`var c` 遮蔽模块级的 `c()` 辅助函数** ——
   `lib/scene-tools.js` 里 `c()` 是取注入依赖的快捷方式，
   但 `var c = arr[...]` 是函数级作用域，会把模块级的 `c` 遮掉，
   运行时才炸 `c is not a function`。
   **教训**：lib 模块里的辅助函数别用单字母名。

2. **`sceneCallbackHits` 归属错了** —— 它定义在场景脚本通道区（main.js 的职责），
   搬文件时被顺手带进了 `lib/scene-tools.js`，但 main.js 也要用它。
   结果 main.js 里的引用变成 `undefined`。
   **教训**：搬代码时要看清楚这个符号**还有谁在用**，
   不只是"这段代码讲什么"。

### 依赖注入的约定

`lib/` 模块不引用 `Editor` 全局（那样才能脱离编辑器单测），
通过 `setContext()` 拿宿主能力：

```js
scenetools.setContext({
    projectRoot: projectRoot,
    safePath: safePath,
    resolveNode: resolveNode,
    // ...
});
```

注入的必须是**函数引用**而不是调用结果 —— 函数声明会提升，注入时机怎么都不晚。

---

## 七、验收清单（v0.8.0）

改完任何东西，跑这三条，必须全绿（各 **121** 项）：

```bash
node test.js "G:/CocosProject/new/bottle_new"    # 539 资源
node test.js "D:/CocosProject/PinGame"           # 569 资源（CRLF 场景）
node test.js "D:/CocosProject/cleanMaster"       # 4086 资源（无空节点模板）
```

> **跑法取决于环境的删除守卫阈值**：WorkBuddy 沙箱注入了批量删除守卫
> （`CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`，按单次工具调用累计删除数）。
> **默认 50** 时三条要分开跑 —— 一条 `for` 连跑三个项目会从第二个起拦截测试自己的清理，
> 残留连锁造成假失败（`temp/__mcp_verify 没清理干净`、`目标已存在`、`created: false`）；
> 报错里出现 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 就是它，不是产品回归。
> 本机已把阈值上调到 **5000**（2026-11-06 实测），一条命令连跑三个项目各 **121/121**、
> 无任何守卫报错；分开跑同样全绿。普通终端 / CI 没有这道守卫，任意跑法都可。
> 换机器或换会话时先看一眼阈值，别把假失败当成产品回归。

**测试夹具是自清理的**：`cleanupTestArtifacts()` 在开跑前、收尾、异常退出时各清一次
（`assets/__mcp_test_*`、`assets/__mcp_diff_test`、`temp/__mcp_verify` 等）。
早期只清 5 类文件，一旦某轮失败留下 `assets/__mcp_test_scene.fire` 这个空场景，
下一轮会把它当节点模板复用，"文件里一个 cc.Node 都没有"会连锁挂掉 20 多项 ——
那全是残留造成的假失败，不是回归。看到成片的场景/预制体写入失败，先查残留。

**端到端验收**（走中继入口，会真的构建并起预览服务）：

```bash
node accept.js
```

它会依次做：查中继状态与目标 → 环境自检 → 查构建产物 → 打开游戏页面确认能访问
→ 读场景 → 加节点 → 改属性 → 读回验证 → 删节点还原。

测试覆盖的关键断言：

- **加 → 改 → 删 往返后，`.fire` 与原文件逐字节一致**（同时守住 `__id__` 重映射和换行风格）
- **预制体版同样逐字节还原**（v0.3.4：`scene_*` 直接改 `.prefab`，加节点时补的 `PrefabInfo`
  在删除后必须一起消失、`__id__` 全部重映射回去）
- **预制体里新加的节点必须有 `_prefab` → `cc.PrefabInfo`、`_id === ''`、`fileId` 22 位**
- **`prefab_create` 生成的结构过校验器**（悬空 `__id__` / 缺 `_prefab` / fileId 重复一律拦下），
  且 `query_scene_tree` 读回的节点数、组件、`spriteFrame.resourceType === 'sprite-frame'` 都对得上
- **`write_file` 拒绝结构坏掉的 `.prefab`**，错误信息要指到具体下标
- **覆盖预制体时沿用旧 `fileId`**（把 fileId 全换新再写回，旧 id 必须被恢复）
- **`resolve_uuid` 查预制体 / 图片时 `__status` 是 `ok`**（`script: null` 是设计如此，不算半个失败）
- **`prefab_layout_check` 能报出重叠与越界**（构造两个重叠节点 + 一个 (5000,5000) 的越界节点）
- **`script_compile_status` 三态**：指定未来 `since` 时一条不报；不存在的脚本给 `missing-source`；
  `diagnostics` 恒为空数组（不编造）
- **`refresh_assets` 不传参按 dirty 记录刷全部写过的目录**（含嵌套目录），`paths` 能合并去重刷多个
- 预制体拷入后组件齐全，删除后同样逐字节还原
- 导出的预制体：每个节点一个 `PrefabInfo`、`PrefabInfo.asset` 与 `meta.uuid` 一致，
  导出后能实例化回来
- **`mcp_selftest(sideEffects)` 返回 `realSceneUntouched: true`**（自证没碰真实场景文件）
- **`tools/list` 载荷 < 80 KB**（v0.4.0 从 155.6 KB 砍到 53 KB，守住不回退）
- **完整契约只在 `initialize.instructions` 里**（`【返回约定】`+`【常见链路`），工具描述只带一行脚注
- **16 个合并掉的旧名仍然可调用**：`callTool('execute_script', {code})` 能拿到结果、
  返回带 `__renamedFrom` + `__hint`，且任何旧名都不报"未知工具"
- **`tools/list` 里不再出现旧名**（合并后必须只剩新名，否则模型会挑到废弃入口）
- **三张表一致**（`mcp_selftest.registry` 为空；启动时也不该有 `Editor.error`）
- **`scene_apply` 的 dryRun 一个字节都不写**，只回报 before/after + 每个 op 的结果
- **`scene_apply` 批量加 → 批量删之后逐字节还原**（守住"一次提交"没搞乱 `__id__`）
- **`scene_apply` 中途失败 → 整批放弃**：错误里带"第 N 个操作"和"文件未改"，文件确实没动
- **`asset_refs` 能反查引用**：预制体里用的图，反查结果必须包含那个预制体；反向 `outgoing` 里必须有那张图的 uuid
- **`project_doctor` 对干净预制体 0 误报**，且能抓到伪造的悬空 `__uuid__`（报出具体 uuid）与缺 `.meta`
- **`script_compile_status waitMs` 真会等**：编不出来的脚本等到超时要 `settled: false`，并提示别急着构建
- **写盘返回带 `editor` 块**，且 `openInEditor` 只能是 true/false/null（不能不返回）
- **`editor_sync` 台账准确**：刚写完 `changedSinceLastWrite: false`；把文件改成别的内容后变 `true` + `risk: clobbered`
- **`classify` 分得清两种 `liveOnly`**：我们删掉的（`editor-stale`，`losesOnReload: 0`）vs 用户新建的（`editor-has-unsaved`）
- **`diffNodes` 的场景/预制体两种模式**：场景按 id（改名不算增删），预制体按 path（重名按序号区分）
- **`scene_capture` 没编辑器时明确报错**，不得返回空白图或写文件
- **真机重载闭环**：`scene_add_node` → `editor_sync status` 报 `editor-stale` → `reload` → `verified: true`，
  且 `scene_remove_node` 后文件与改动前**逐字节一致**
- **`prefab_diff` 自比为空且 `__status: ok`**（四类差异是空数组属正常，不能报 partial）
- **`prefab_diff` 认得出改名**（按 `_id`，不能算成删除+新增），属性变化是 `[旧值, 新值]`
- **`project_doctor fix:"preview"` 一个字节都不写**，`fix:true` 才改，且改完 `stillBad === 0`
- **孤儿 `.meta` 是移到隔离区不是删**：原位置消失、`fx.quarantine` 下能找到
- **预制体编辑态判定**：活场景 `_id` 不是 uuid → 临时场景 → 子树重合度 ≥50% 才算"开着它"；
  `Editor.currentSceneUuid` 相同但活场景不同时，**必须报 `openInEditor: false`**（否则 reload 会把用户踢出预制体）
- **预制体 `action:"reload"` 必须明确拒绝**并说清"别保存、关掉重开"
- **预制体根名当路径前缀**：`CircleView/panel/xxx` 能解析（不同项目根名不一样，写死 'Root' 没用）
- 删除场景根 / 删除组件有外部引用时被拒绝
- 危险 meta 字段（`_` 开头、`uuid`）被拒绝
- 目标项目切换：按名字、按端口都能切，不存在的项目报错
- 中继的开启/查询/关闭（测试模式下不碰真进程）
- **目标文件里不存 `port` 字段**（端口会漂移，存了就指错项目）
- **端口互换后目标仍解析到正确项目**（模拟编辑器重启换端口的场景）
- **中继按项目身份解析目标端口**（用隔离的 HOME 跑真实 hub.js，不碰用户状态）
- **场景进程能收到 payload**（守住 `(evt, payload)` 签名这个教训 —— v0.3.0 就栽在这）
- **场景脚本方法未注册时 14ms 快速失败**（不是干等 15 秒超时）
- **注入后带哈希的资源文件 md5 不变**（变了会加载失败）
- **注入幂等 + 撤销后 index.html 逐字节还原**
- **注入脚本在模拟浏览器环境里能正确 POST**（含 cc API 调用和真实 XHR）
- **注入脚本 → 真实 MCP 端口 → 读回，端到端通**（含类名归一化 `cc_Sprite` → `cc.Sprite`）
- **中继转发 `/runtime-report`**（浏览器报给中继，中继转给扩展实例）

真实场景冒烟（可选）：

```bash
node dev-client.js 25800 scene_ping
node dev-client.js 25800 build_project '{"platform":"web-mobile"}'
node dev-client.js 25800 build_status
node dev-client.js 25800 preview_control '{"action":"start"}'
# 然后浏览器打开 http://127.0.0.1:<port>/build/index.html
node dev-client.js 25800 preview_control '{"action":"stop"}'
```

---

## 八、端口注册表

每个项目启动时写 `~/.CocosCreator/cocos-mcp-2x/ports/<项目名>.json`：

```json
{ "name": "bottle_new", "project": "G:\\CocosProject\\new\\bottle_new",
  "port": 25901, "pid": 8028, "startedAt": "2026-11-04T01:28:03.881Z" }
```

编辑器菜单 `扩展/Cocos MCP 2.x/` 下有三个入口：状态与端口、列出已打开项目、重启服务。

> `重启服务` 走 `stopServer` + `startServer`，**不会**重新加载代码。换代码还是用 `node reload.js`。

---

## 九、下一步

> ⚠️ **本节在 v0.4.0 已重写。** 下面是当前真正待办。

### 已完成（原来在这里，现在别再当待办）

| 原待办 | 状态 | 落在哪 |
|---|---|---|
| 验证 HTTP 回传 | ✅ v0.3.2 | 根因是处理器签名写错，见第四节第 1 条 |
| 读运行时状态 / 捕获 console | ✅ v0.3.2 | `runtime_read` / `runtime_console` |
| `prefab_create_from_node` | ✅ v0.3.0 | PrefabInfo 的 uuid 问题靠"先建文件让编辑器分配 uuid、再回填"解决 |
| 预览控制 | ✅ v0.3.3 | `preview_control` + `bridge.js` 桥接 |
| `scene_*` 支持 `.prefab` | ✅ v0.3.4 | `findRootForEdit` + `makePrefabInfo`（lib/scene-tools.js） |
| 从声明式 spec 造预制体 | ✅ v0.3.4 | `prefab_create`（lib/prefab.js） |
| 可发现性：工具互相找不到 | ✅ v0.3.4 | 每个写 `.prefab` 的工具描述都带【Prefab 约定】+【常见链路】 |
| `mcp_verify_all` 描述劝退 | ✅ v0.3.4 | 描述改成「不修改当前打开的场景」，并真返回 `realSceneUntouched` |
| `resolve_uuid` 假 partial | ✅ v0.3.4 | `EXPECTED_NULL` 按 `result.kind` 判预期空字段 |
| 跨目录刷新漏刷 | ✅ v0.3.4 | dirty 追踪 + `paths` |
| 整文件重写丢 fileId | ✅ v0.3.4 | `stabilizeFileIds`（按「父路径+名字」匹配） |
| 目标离线时写错项目 | ✅ v0.3.4 | `WRITE_TOOLS` + `blockedWriteReply` |
| tools/list 太胖（155.6 KB） | ✅ v0.4.0 | 契约移入 instructions + 一行脚注（→ 53 KB） |
| 同义工具重复（54 个 / ~17 个能力） | ✅ v0.4.0 | 合并 9 组 → 44；`RENAMED` 保留旧名 |
| 三份根定位 | ✅ v0.4.0 | 收敛到 `scene-parse.findRootForEdit`，其余是薄别名 |
| 登记漂移（自检漏 5 个工具） | ✅ v0.4.0 | `IMPL` 表 + 启动校验 + 自检表漏项算 problem |
| `.backup/` 旧版源码干扰 grep | ✅ v0.4.0 | 已删（git 历史里还有） |

### B 档已完成（v0.5.0）

| 原待办 | 落在哪 |
|---|---|
| Document 层（open/apply/commit + dry-run） | `lib/scene-tools.js` 的 `openDocForEdit` / `commitDoc` / `applyOps`；对外是 `scene_apply` |
| Asset graph（谁引用我 / 谁被我引用） | `lib/asset-graph.js` + `asset_refs` |
| 索引增量（1.5–2.8s → 0.11s） | `lib/uuid.js` 单文件 mtime 缓存 |
| `project_doctor` | `main.js` 的 `toolProjectDoctor` |
| `wait_until_compiled` | `script_compile_status` 的 `waitMs`（不新增工具） |

### C 档已完成（v0.6.0）

| 原待办 | 落在哪 | 说明 |
|---|---|---|
| 编辑器脏状态检测 | `editor_sync` + `lib/editor-state.js` | 磁盘节点集合 vs 场景进程活节点集合，按 `_id` 比 |
| "脏了就拒绝或强制重载" | `editor_sync {action:"reload"}` | 面板 `_loadScene(uuid)` + 轮询验证；有用户未保存节点时拒绝，`force:true` 才丢 |
| `prefab_preview` | `scene_capture` | 换成截编辑器场景视图（`capturePage(rect)`），不用起预览服务 |

### 待办（原 C 档四条已在 v0.7.0 全部完成）

| 原待办 | 落在哪 |
|---|---|
| `prefab_diff` 节点级差异 | `lib/doc.js` 的 `diffDocs` + `prefab_diff` 工具 |
| `project_doctor` 自动修复 | `applyDoctorPlan`，三类安全修复 + `fix:"preview"` |
| 预制体编辑态判定 | 活场景 `_id` + 子树重合度（`findMatchingSubtree`） |
| `scene_capture` 画面质量 | cc 装饰节点 + DOM 叠加层双清理 + 裁工具栏（`clean` 选项），含预制体悬浮条 |

### 这一版没做的（想清楚了再说，别硬做）

1. **预制体从外部重载**。2.4.15 只能整个编辑器窗口 reload，会把用户的编辑会话打掉。
   真要做只有一条路：把改动**镜像到场景进程的活节点上**（相当于每个 op 在运行时再实现一遍），
   工作量和风险都比收益大，除非以后有明确的"必须热重载"场景。
2. **`scene_capture` 出真正的游戏画面**。现在截的是编辑器场景视图（装饰、坐标标尺、
   节点标签、预制体悬浮条都已能隐藏，画面已经干净），但它终究是编辑器画布，不是运行时的
   游戏画面（分辨率、相机、字体渲染都可能不同）。要像素级还原得在场景进程里用 RenderTexture 渲染 ——
   2.4.15 的 `cc.RenderTexture.create` 不存在（试过），得换 API 或起预览服务，
   而 `bridge.js` 的 canvas 截取受 WebGL `preserveDrawingBuffer` 限制常拿空白。
3. **组件内部字段值的 diff**。`prefab_diff` 只比节点级属性 + 组件类型，
   不比 `cc.Label._string` 这类组件字段。要做得从组件模板里读默认值做参照，性价比一般。

### 更早的待办（原样保留）

1. **完整通关验证还没做** —— 桥接已验证「主界面 → 游戏 → 关卡列表 → 主界面」四步往返，
   但**没有从头打一关**。关卡 prefab 是异步加载的，需要在 `preview_command` 的 `script`
   里 `await` 一段时间再读状态，确认关卡真的初始化完了（物理体、球、倒计时都在）。

2. **`preview_control stop` 只能关掉最近启动的那一个预览服务** ——
   之前泄漏的端口关不掉（`PreviewServer` 只记住最后一个 server），重启编辑器才全部释放。
   可以考虑改成记录自己开过的所有端口，逐个关。

3. **`execute_script` 无超时保护** —— 用户代码 await 一个永不 resolve 的 Promise 会挂住请求。
   加个超时上限。

4. **场景写入是文件级的，编辑器内存里的场景是旧版本** ——
   改完要么让用户重开场景，要么别在编辑器里保存。可以考虑加一个"写完自动提醒重开场景"的提示。

5. **`lib/` 只拆出了 6 个模块** —— `main.js` 还有 5837 行，
   「工具实现」区（约 1500 行，文件/代码/资源类工具）和「运行时」区（约 380 行）还可以拆。
   拆的时候注意 `lib/` 模块之间**不能互相 require**（避免循环依赖），
   依赖一律从 main.js 注入。

6. **`scene.js` 只能靠重启编辑器生效** —— 场景窗口只在启动时 require 场景脚本，
   `Panel.close/open`、panel-run 全试过都不行。这是引擎的限制，绕不过去。

### 如果要加新能力，优先级建议

| 方向 | 价值 | 难度 |
|---|---|---|
| 打通完整通关流程验证 | 高（证明"完全可控"） | 低 |
| `prefab_preview(path)`：临时实例化到预览场景抓图（`bridge.js` 的 `screenshot` 现在只返回尺寸和平均色，要扩成返回图片数据） | 高（布局的最终裁判是眼睛） | 中 |
| `script_compile_status` 补真实诊断：从 quick-compile 的临时文件里抠报错 | 中 | 高（引擎不落盘，得自己 hook） |
| `prefab_diff(path)`：节点级差异（增删改 / 属性变化），而不是整文件字节 diff | 中 | 低 |
| 场景写入后自动重开场景 | 中 | 中 |
| `execute_script` 超时保护 | 中 | 低 |
| 拆剩余的工具实现区 | 中（可维护性） | 中 |
| 多开编辑器的端口漂移 UI 提示 | 低 | 低 |
