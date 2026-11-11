# cocos-mcp-2x

[简体中文](README.md) | **English**

> An MCP server for Cocos Creator **2.x** — lets an AI read and write project files directly, create and edit scenes and prefabs, launch the engine's web preview, and **actually play the game**.

`v0.8.0` · 28 tools · targets **Cocos Creator 2.4.x** (verified on 2.4.15) · MIT

Cocos Creator 3.x has a completely different extension API (`Editor.Message` replaces `Editor.Ipc`,
scenes are a pure 3D structure). This repository targets **2.x only**. Do not mix them.

---

## Contents

- [What it can do](#what-it-can-do)
- [Quick start](#quick-start)
- [Design principles](#design-principles)
- [Architecture and code structure](#architecture-and-code-structure)
- [Tool reference (28)](#tool-reference-28)
- [Walkthrough: build a project from zero](#walkthrough-build-a-project-from-zero)
- [Walkthrough: edit scenes and prefabs](#walkthrough-edit-scenes-and-prefabs)
- [Walkthrough: play the game](#walkthrough-play-the-game)
- [Return contract](#return-contract)
- [Deployment](#deployment)
- [Testing and self-check](#testing-and-self-check)
- [Troubleshooting](#troubleshooting)
- [Compatibility and limitations](#compatibility-and-limitations)

---

## What it can do

| Capability | Tools | Why it matters |
|---|---|---|
| **Read/write project files** | `read_file` `write_file` `edit_file` `search_files` | Writing `.prefab` validates structure, preserves `fileId`, and keeps the original line endings |
| **Inspect scenes** | `query_scene_tree` `scene_capture` | Know what is in a scene, and what it looks like, without opening the editor |
| **Create scenes** | `scene_create` | **Works in an empty project**: built-in engine-equivalent template emits SceneAsset + Scene + Canvas + Main Camera |
| **Create prefabs** | `prefab` `cmd:create` | Declarative spec: images by path, scripts by path, all serialization details handled |
| **Edit nodes/components** | `scene_edit` (8 cmds) | Batched transactions with `dryRun`; 20 nodes, one write |
| **Check layout** | `prefab` `cmd:check-layout` | Find "text on top of icon" and "outside the canvas" without screenshots |
| **Project health check** | `project_doctor` | Catches what the importer accepts but the runtime blows up on (dangling uuid, wrong spriteFrame, orphan meta) |
| **Run and observe** | `preview` `runtime` | Instant compilation — edit `.ts`, refresh, done. **No build step** |
| **Actually play it** | `preview` `cmd:command` | Click buttons, dispatch touches, read state, capture console, screenshot |
| **Consistency self-check** | `mcp_selftest` | Three tables (declaration / implementation / probes) must match one-to-one; anything unregistered lands in `problems` |

The design goal is **verifiable automation**: never "the command was sent, so it worked", but
evidence you can read back (`verified: true`, `errorTotal: 0`, 8/8 assertions passing).

---

## Quick start

### 1. Deploy the extension

The extension is installed **globally**; every 2.x project shares one copy:

```bash
cd <this repository>
node deploy.js
```

Installs to `~/.CocosCreator/packages/cocos-mcp-2x/`, or falls back to `.../packages/mcp/`
when that directory does not exist (the directory name the editor actually loads varies by install method).
See [Deployment](#deployment).

### 2. Open the editor

Cocos Creator 2.x auto-loads global extensions. After launch, the menu **Extensions / Cocos MCP 2.x** appears:

| Menu item | What it does |
|---|---|
| Status & port | Which port this instance runs on, which project is targeted |
| List open projects | Every project with an open editor on this machine |
| Start / stop relay | The relay is a resident process; the link survives closing the editor |
| Switch target project | Rotate which project the AI operates on |
| Restart service | Hot restart after editing `main.js` |

### 3. Configure your MCP client

`~/.workbuddy/mcp.json` (same idea for Claude Desktop, Cursor, etc.):

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

**Point at 25800 (the relay), not at the editor's 25900.**

Editor ports are assigned by launch order (25900, 25901, ...) and swap on restart — hard-coding an
editor port eventually targets the wrong project. The relay is resident and resolves the target by
**project identity** (not by port) on every request, so it is always right.

### 4. Verify

```bash
node dev-client.js 25800 get_project_info
node dev-client.js 25800 mcp_selftest
```

You should see the project path, engine version, and `problems: []`.

---

## Design principles

These nine principles explain most of the tool's behavior. When something looks odd, come back here first.

### 1. File layer first — avoid editor IPC unless necessary

`.fire` / `.prefab` are plain JSON. The file layer can do more than the editor's private API:
diffable, testable offline, usable while the editor is closed, and a failure never leaves
a half-modified in-memory state.

That is why the eight write commands of `scene_edit` report `writeRoute: 'file'` —
they **rewrite the JSON on disk and do not depend on the scene-script channel**. The scene script is
only used when live objects are required (reading runtime properties, executing JS).

### 2. Empty is not failure

Every tool returns `__status` / `__emptyFields` / `__reason` / `__hint`:

- `empty` is a **normal result** ("no files matched in this directory"), not an error
- Only real failures throw, and the message must state **the cause and the next step**
- Contract fields are `__`-prefixed so they never collide with payload fields
  (`preview`'s `status` is an HTTP code)

Every tool description in `tools/list` includes this contract, so you can interpret results from the
description alone instead of by trial and error.

### 3. Shrink the protocol surface, keep behavior identical

v0.8.0 merged 30 single-action tools into 8 `cmd`-style entries (50 → 28), cutting the `tools/list`
payload by roughly a third. `dispatchByCmd` does exactly two things: pick the original implementation by
`cmd`, and strip `cmd` before calling it. **No implementation was modified** — merging only changed the
entry points, which is what makes the equivalence provable by the regression suite.

All 46 legacy tool names still work. `callTool` follows the `RENAMED` chain (up to 2 hops, 4 to prevent
cycles) and returns `__renamedFrom` / `__hops` / `__hint`. **Old scripts and old prompts do not break.**

### 4. Never hand-write `.meta`

`.meta` files are the AssetDB identity (`uuid` / `importer` / `subMetas`); hand-writing one is giving the
project a new identity. When a `.meta` is missing, the correct fix is `refresh_assets` on the directory so
the editor generates it.

Same for uuids: **self-assigned uuids are wrong**. `prefab` `cmd:create` writes the file first, then
re-reads the real uuid from the imported `.meta` and patches both references — otherwise `project_doctor`
reports dangling uuids.

### 5. Write ledger: who touched this file

Each write records mtime / size / node ids into `temp/mcp-state/ledger.json`. Before the next write it
compares:

| Situation | Verdict | What to do |
|---|---|---|
| On disk, not in editor memory | `diff.fileOnly` | File is newer → `editor_sync` reload |
| In memory, not on disk (we just deleted it) | `risk: editor-stale` | Reload is lossless |
| In memory, not on disk (you created it) | `risk: editor-has-unsaved` | Reload loses it — save first |
| Modified after our last write | `risk: clobbered` | The previous batch was overwritten; redo it |

The ledger lives in `temp/`, never inside `assets`, is never imported, and is git-ignored.

### 6. Never hand-construct serialized objects

Clone an existing sibling object from the scene and edit fields. `_trs` / `_color` / `_contentSize` /
`_anchorPoint` / `_objFlags` all inherit engine values. These are easy to get subtly wrong per engine
version — `_trs` is a 10-element TypedArray, one position off means wrong placement, and it fails silently.

### 7. Preserve the original file format on write

A CRLF project must not be rewritten as LF; that produces a full-file git diff and destroys history.
`write_file` / `edit_file` inspect the existing file and align line endings.

### 8. Removing an object requires a global `__id__` remap

Removing one object in a serialized file shifts every subsequent `__id__`. So the code first unlinks the
reference from the parent's `_children`, then scans the whole file for external references. **Any leftover
reference rejects the whole operation** rather than writing a half-broken scene.

### 9. Deployment is itself a verifiable operation

`deploy.js` does two things before copying: a **syntax pre-check** (`vm.Script` compilation — a syntax
error would break the extension at startup and report something unrelated), and **conflict detection**
(if the deployed copy was modified elsewhere, stop and report unless `--force`).

---

## Architecture and code structure

### Overview

```
┌─────────────────────────────────────────────────────┐
│ Client (mcp.json)                                    │
│   "url": "http://127.0.0.1:25800/mcp"                │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────┐
│ hub.js — resident relay (separate process)           │
│   reads target.json per request → resolves project   │
│   identity → forwards                                │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌────────────────┐          ┌────────────────┐
│ Editor A (25900)│          │ Editor B (25901)│
│  main.js ext.  │          │  main.js ext.  │
└────────┬───────┘          └────────┬───────┘
         │                           │
         ├─→ file layer    → .fire / .prefab / assets (most reliable)
         ├─→ scene script  → scene.js (renderer process, has `cc`)
         ├─→ preview server→ PreviewServer → bridge.js (browser side)
         └─→ build output  → injector.js → inject-runtime.js (browser side)
```

### Four channels, four different truths

**This is the easiest thing to get wrong.** The same game, seen four ways:

| Channel | Tools | Reads | Status |
|---|---|---|---|
| **Static design state** | `query_scene_tree` (`detail:true` for one node) | What is in the `.fire` file | ✅ Always available |
| **In-editor runtime** | `runtime` `cmd:read` / `eval` / `report(source=scene)` | Live objects in the scene process | ✅ Available |
| **Engine web preview** | `runtime` `cmd:report(source=preview)`, `preview` `cmd:command` | The game running in the preview page | ✅ Available, **no build needed** |
| **Build output runtime** | `runtime` `cmd:report(source=build)` | The web artifacts from `build` | ✅ Available, but build first |

**Prefer preview**: it goes through the engine's `__quick_compile__.js` instant compiler — edit `.ts`,
wait for recompilation, refresh. The build path (`build` + `runtime` `cmd:inject`) is the fallback, for
"the game as it runs from a build".

### File layout

```
mcp/
├── main.js            7948 ln  Extension main process: MCP protocol, tool dispatch, scene-script channel, preview server, relay, build
├── scene.js            993 ln  Scene script (renderer process): access to `cc`, JS execution, result reporting
├── bridge.js          1094 ln  Browser-side bridge: receive command, execute, report
├── injector.js         251 ln  Build-output injector (reversible)
├── inject-runtime.js   365 ln  Injected runtime reporter
├── hub.js              345 ln  Resident relay: forward by project identity (standalone Node process)
├── reload.js           207 ln  Dev-time hot reload (only affects the given port)
├── deploy.js           165 ln  Deployment with conflict detection + syntax pre-check
├── test.js            3309 ln  Regression suite (mocked Editor, real HTTP)
├── bootstrap-probe.js  209 ln  Cold-start probe: builds a temp empty project, runs 8 assertions, cleans up
├── accept.js            99 ln  End-to-end acceptance
├── dev-client.js       109 ln  Direct-port debug client (intentionally not deployed)
├── package.json                Extension manifest: main / scene-script / main-menu
├── lib/
│   ├── fsutil.js       113 ln  Pure filesystem helpers
│   ├── uuid.js         283 ln  uuid ↔ path index (incremental by mtime)
│   ├── scene-parse.js  422 ln  **Read-only** `.fire` / `.prefab` parsing + unique-root resolution
│   ├── scene-tools.js 1230 ln  Scene / prefab **writes** + batch op engine
│   ├── scene-template.js 207 ln Built-in empty-scene template: buildEmptyScene / attachCanvas / hasCanvas
│   ├── prefab.js       864 ln  Prefab assembly / structural validation / layout check (pure logic, no fs, no Editor)
│   ├── doc.js          326 ln  Document validation + node-level diff (the core of prefab diff)
│   ├── asset-graph.js  188 ln  Reference graph (who references me / whom do I reference), incremental by mtime
│   ├── editor-state.js 404 ln  Write ledger + node diff + subtree overlap matching (pure logic)
│   └── tool-schema.js  613 ln  Tool declaration table (pure data, 28 entries)
├── README.md / README.en.md / DEVELOP.md / HANDOFF.md
└── .deploy-manifest.json       md5 snapshot of the last deployment
```

### Layering rules

```
        main.js (orchestration)
              │
    ┌─────────┼──────────┬─────────────┐
    ▼         ▼          ▼             ▼
lib/       scene.js    bridge.js     hub.js
(pure)     (renderer)  (browser)     (relay)
```

Three hard rules:

1. **`lib/` never references the `Editor` global** — it receives host capabilities through `setContext()`.
   Why: `lib/` is the part most in need of unit tests; binding it to `Editor` makes it untestable outside the editor.
2. **`lib/` modules never `require` each other** — dependencies are injected by `main.js`, the single assembly point.
   Why: no circular dependencies, and the graph stays readable.
3. **Tool declaration and implementation are separate** — `lib/tool-schema.js` holds data only;
   `callTool()` in `main.js` holds dispatch. Why: adding a tool touches two obvious places instead of a 8000-line file.

Step-by-step instructions for adding a tool: [DEVELOP.md](DEVELOP.md).

---

## Tool reference (28)

> The 8 aggregate entries **require `cmd`**. Each `cmd`'s parameters are documented in the tool
> description (visible in `tools/list`). 46 legacy names still work and return `__renamedFrom` /
> `__hint`; see the [appendix](#appendix-legacy-tool-names).

### Plain tools (20)

| Group | Tools | Notes |
|---|---|---|
| Self-check (1) | `mcp_selftest` | Runs the tools for real and checks return shape, empty marking, error messages. By default only side-effect-free tools; `sideEffects: true` includes the rest (**on a copy**, deleted afterwards with an md5 check). Returns `problems` + `registry` |
| Files & code (7) | `get_project_info` · `list_dir` · `search_files` · `read_file` · `write_file` · `edit_file` · `refresh_assets` | Project info / list dir / full-text search / read / write (validates `.prefab` structure, preserves `fileId` and line endings) / exact replace / re-import. After editing `.fire`/`.prefab` you **must** call `refresh_assets` (no args re-imports the directories you wrote) |
| Scene views (5) | `query_scene_tree` · `scene_create` · `scene_diagnose` · `editor_sync` · `scene_capture` | Node tree / **create scene (built-in template, works in an empty project)** / channel diagnostics / disk vs editor memory diff / clean scene screenshot |
| Asset diagnostics (3) | `resolve_asset` · `asset_refs` · `project_doctor` | Path↔uuid (`spriteFrames` for images) / who references me · whom do I reference / project health check (`fix:"preview"` plans, `fix:true` applies) |
| Routing & escape hatches (4) | `list_open_projects` · `set_target_project` · `hub_control` · `run_script` | List open projects / choose target / relay on-off / run arbitrary JS in the main process (`path` for long scripts) |

Two key `scene_create` parameters: `withCanvas` (default `true`, guarantees Canvas + Main Camera) and
`startScene` (default `true`, writes `start-scene` and the design resolution). An empty project needs no
template — it creates a scene directly.

### Aggregate entries (8, `cmd` required)

| Tool | `cmd` values | Legacy tools absorbed |
|---|---|---|
| `scene_edit` | `add-node` · `remove-node` · `move-node` · `set-props` · `add-component` · `remove-component` · `set-component-props` · `apply` | 8 `scene_*` tools (`apply` is the batch transaction / `dryRun` entry) |
| `asset` | `query` · `move` · `delete` · `meta-get` · `meta-set` | `asset_query` etc. (5) |
| `prefab` | `create` · `check-layout` · `diff` | `prefab_create` (spec or node), `prefab_layout_check`, `prefab_diff` |
| `build` | `targets` · `start` · `status` | `build_targets` / `build_project` / `build_status` |
| `project_settings` | `get` · `set` | `project_settings_get` / `_set` |
| `runtime` | `info` · `read` · `eval` · `report` · `inject` | `runtime_info` / `runtime_read` / `eval_scene` / `runtime_report` / `runtime_inject` |
| `preview` | `control` · `command` | `preview_control` (start / stop / open / bridge / status), `preview_command` (11 actions) |
| `editor` | `log` · `compile-status` | `get_editor_log` / `script_compile_status` |

**All eight writing `scene_edit` cmds accept both `.fire` and `.prefab`**: pass a `.prefab` as `path`.
Omit `path` and they operate on the editor's current scene.

**Why the outer key is `cmd`, not `action`**: `runtime` `cmd:inject`, `preview` `cmd:control`/`command`,
`hub_control`, and `editor_sync` already have their own `action` sub-command; reusing `action` outside
would collide.

---

## Walkthrough: build a project from zero

New in v0.8.0 — **no need to create a scene by hand in the editor first**.

```jsonc
// 1. Create a scene (works in an empty project: built-in template + Canvas + Main Camera + start-scene)
{ "name": "scene_create", "arguments": { "path": "assets/scene/Main.fire", "canvas": [750, 1334] } }

// 2. Create a prefab (images and scripts by path; serialization handled for you)
{
  "name": "prefab",
  "arguments": {
    "cmd": "create",
    "path": "assets/resources/prefab/ChoiceItem.prefab",
    "root": {
      "name": "ChoiceItem", "size": [640, 88],
      "sprite": "assets/art/panel.png",
      "children": [{ "name": "Label", "size": [580, 60], "label": "Choice text" }]
    },
    "script": "assets/scripts/ChoiceItem.ts"
  }
}

// 3. Write scripts (read long files from disk via path to avoid JSON escaping hell)
{ "name": "write_file", "arguments": { "path": "assets/scripts/ChoiceItem.ts", "content": "..." } }

// 4. Import and check compilation
{ "name": "refresh_assets", "arguments": {} }
{ "name": "editor", "arguments": { "cmd": "compile-status" } }

// 5. Start the preview and confirm it actually runs
{ "name": "preview", "arguments": { "cmd": "control", "action": "start" } }
{ "name": "runtime", "arguments": { "cmd": "report", "source": "preview", "limit": 50 } }

// 6. Health check before delivery
{ "name": "project_doctor", "arguments": {} }
```

The trap in step 1 (fixed in v0.8.0): previously an empty project with no `.fire` to clone simply failed.
It now goes through `buildEmptyScene()` in `lib/scene-template.js`, emitting the **complete field set** of
the built-in canvas prefab. A missing `_id` or a misordered `_trs` will not fail at import — it fails at runtime.

`bootstrap-probe.js` exists to verify exactly this path: it builds a temporary empty project, runs 8
assertions, then cleans up.

---

## Walkthrough: edit scenes and prefabs

### Change node properties

```jsonc
{ "name": "scene_edit", "arguments": {
    "cmd": "set-props", "node": "Canvas/topUI/btnKey", "position": { "x": 100, "y": 200 } } }
```

### Swap an image (the most common trap)

```jsonc
{ "name": "resolve_asset", "arguments": { "input": "assets/game/images/ys01.png" } }
```

**A PNG has two uuids:**

| uuid | What it is | Valid for `_spriteFrame` |
|---|---|---|
| Main uuid (first `"uuid"` in the meta) | texture | ❌ throws `textureLoaded is not a function` |
| The uuid inside `subMetas` | sprite-frame | ✅ |

Check `usableAsSpriteFrame` in the result (images also return `spriteFrames` directly).
After swapping, update size and scale — the new image's native size must fit the button, or it stretches.

### Batch-edit one screen (single write)

Do not call `set-props` 20 times for 20 nodes — that is 20 full-file read/writes, and a failure midway
leaves a half-finished file.

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

`dryRun: true` only simulates: it reports `before`/`after` object counts, each op's outcome, and structural
validation, **without writing**. Remove `dryRun` to apply — a single write; any failing step aborts the whole
batch and leaves the file byte-identical.

### Layout check (no screenshot needed)

```jsonc
{ "name": "prefab", "arguments": { "cmd": "check-layout", "path": "assets/ui/Foo.prefab" } }
```

Reports `outOfBounds` (outside the canvas), `overlaps` (sibling overlap, **with overlap ratio**),
`outsideParent` (outside the parent container), and `inactiveHidden` (`active:false` but siblings still reserve space).

### Looking beats calculating

```jsonc
{ "name": "scene_capture", "arguments": {} }
```

Returns `{file: "temp/mcp-state/shots/scene-<timestamp>.png", width: 915, height: 594}` — just open it.

By default it **temporarily disables the grid, design-resolution frame, and gizmos** before capturing
(they are decoration nodes `Editor Scene Background` / `Editor Scene Foreground`; restored immediately,
without touching files or settings) and crops the toolbar. Pass `clean: false` to keep the editor as-is.

It reveals what geometry checks cannot: ugly text overlap, wrong 9-slice borders, stretched images, fonts
that failed to apply. Conversely `check-layout` gives you **exact node names and overlap ratios**.
Use both: screenshot to spot the problem, layout check to locate it.

### What actually changed

```jsonc
{ "name": "prefab", "arguments": { "cmd": "diff",
    "a": "assets/ui/Foo.prefab", "against": "temp/Foo.bak.prefab" } }
```

Adding a node shifts every subsequent `__id__`, so a byte diff reports "everything changed" and is
unreadable. This pairs nodes by path and answers only four questions:

```
added   1  CircleView/panel/__DiffA  (with 1 component)
removed 0
changed 1  CircleView/panel/titleBg  opacity: [255, 128]
renamed 0
```

Renames are matched by `_id`, not as a delete plus an add. Node `_id` is an empty string inside prefabs, so
**renaming inside a prefab** shows as delete + add — that is the engine's convention, not the tool's.

### After writing: let the editor catch up (the riskiest step)

This MCP **edits files directly**. The cost: the editor still holds the old version in memory. Press Ctrl+S
once and the file is overwritten by the stale in-memory copy — **with no warning at all**.

Check the `editor` field in the write result:

```jsonc
{ "saved": true,
  "editor": { "openInEditor": true, "needsReload": true, "reloadWith": "editor_sync (action: reload)" } }
```

When `openInEditor: true`, follow up with:

```jsonc
{ "name": "editor_sync", "arguments": { "action": "reload" } }
```

It reloads the scene panel from disk, then **polls until the node set matches the file** before returning
`verified: true` (measured ~350ms). It is not "command sent, therefore success".

`editor_sync` also surfaces problems early — see the table in
[Design principle 5](#5-write-ledger-who-touched-this-file).

**Prefabs cannot be reloaded from outside** (`_loadScene` only handles scenes), so `action:"reload"` is
explicitly rejected for prefabs, telling you "do not save, close and reopen" — instead of pretending to succeed.

### Fix what the health check finds

```jsonc
{ "name": "project_doctor", "arguments": { "fix": "preview" } }   // plan only, no writes
{ "name": "project_doctor", "arguments": { "fix": true } }        // apply
```

Only three kinds are fixed, all of which **cannot make things worse**:

| Problem | Fix | Why it is safe |
|---|---|---|
| `Sprite._spriteFrame` holds a PNG main uuid | Replace with that image's sprite-frame uuid | It is the only correct value; there is no second possibility |
| Orphan `.meta` (asset deleted) | Move to `temp/mcp-state/quarantine/<timestamp>/` | **Not a deletion** — always recoverable |
| Missing `.meta` | `refresh_assets` on the directory, let the editor generate it | No hand-written uuid / importer |

Dangling `__uuid__` is **never fixed**: fixing it requires knowing what was intended, which cannot be guessed.

---

## Walkthrough: play the game

The most valuable capability here: **no build step, edit and refresh**.

```jsonc
// Start preview: returns the URL and opens a window
{ "name": "preview", "arguments": { "cmd": "control", "action": "start" } }
```

### See what is there before clicking

FairyGUI screens are **not a cc.Node tree**, so they do not appear in the runtime node tree. Use `fguiTree`:

```jsonc
{ "name": "preview", "arguments": { "cmd": "command", "action": "fguiTree", "depth": 8 } }
{ "name": "preview", "arguments": { "cmd": "command", "action": "fguiTree", "filter": "btn" } }
```

### Two ways to click a button

| Action | For | Mechanism |
|---|---|---|
| `fguiClick` | FairyGUI buttons | Official `InputProcessor.simulateClick` — dispatches a real TOUCH_BEGIN/END chain |
| `clickButton` | cc.Button | Proper `clickEvents` dispatch (auto-detects `onBtn*` / `on*Click` for code-bound buttons) |

```jsonc
{ "name": "preview", "arguments": { "cmd": "command", "action": "fguiClick", "path": "btnStart", "type": "GButton" } }
```

**When a node path is not found it searches the whole tree by name** — UI is often nested under
containers you would never guess.

### Read state / observe change

`script` **supports await** — that is how you observe a **transition** rather than a snapshot taken before it:

```js
var btn = findButton('btnStart');
if (btn) btn.click();
await new Promise(function (r) { setTimeout(r, 1000); });
return cc.director.getScene().name;
```

### All 11 actions of `preview` `cmd:command`

| Action | Purpose |
|---|---|
| `ping` | Confirm the channel is live |
| `eval` | Evaluate a single expression |
| `script` | Execute multi-statement JS (**await supported**) — use this for complex logic |
| `read` | Read a node's component properties (`path`) |
| `click` | Invoke a component's `onXxx` method (`path`, optional `method`) |
| `clickButton` | Click a cc.Button (via clickEvents) |
| `dispatchTouch` | Dispatch a real touch event to the canvas |
| `module` | Load a project module (`window.__quick_compile_project__.require`) |
| `fguiTree` | List the FairyGUI object tree |
| `fguiClick` | Click a FairyGUI button (official simulateClick) |
| `screenshot` | Capture canvas pixels; returns size and mean color |

### Capture logs

```jsonc
{ "name": "runtime", "arguments": { "cmd": "report", "source": "preview", "limit": 50 } }
```

Returns runtime state + console logs + errors, plus `noiseFiltered` (how many noise lines were dropped).
`console.error` is never rate-limit-dropped.

### A verified end-to-end chain

```
preview control start     → preview + inject + open window
fguiClick btnStart        → GameView + level1[Game] (physics bodies, ball, countdown all instantiated)
clickButton btnBack       → LevelView (12 level items)
clickButton btnBack       → HomeView (this button is code-bound, takes the fallback path)
```

**Each step has its own entry point — that is the evidence of full controllability.** No hard-coded flow.

---

## Return contract

**Every tool** returns these four fields:

| Field | Meaning |
|---|---|
| `__status` | `ok` (has data) / `empty` (normal, no data right now) / `partial` (some fields empty) |
| `__emptyFields` | Which fields are empty |
| `__reason` | Why they are empty |
| `__hint` | What to do next |

**Empty is not failure.** Real failures throw, with cause and next step in the message.
Contract fields are `__`-prefixed so they never collide with payload fields.

### Identifier conventions

- Asset paths always use `path` (project-root relative, e.g. `assets/game/x.prefab`)
- Only `asset` `cmd:query` and `search_files` use `pattern` (a search pattern)
- Node paths use slash form: `Canvas/panel/title`; duplicate names require the full path

---

## Deployment

### One command

```bash
node deploy.js            # normal deploy (refuses on conflict)
node deploy.js --check    # check only: report pending files, write nothing
node deploy.js --force    # force overwrite (only after confirming the conflicts)
```

Target: `~/.CocosCreator/packages/cocos-mcp-2x/`; **falls back** to `~/.CocosCreator/packages/mcp/`
when the former does not exist (the directory name the editor loads varies by install method). The
standard name is preferred so code never lands where the editor does not look.

`--check` is safe: no writes, no manifest update. Useful in CI or before committing, to confirm the
editor is really running this code.

### What gets deployed

The `FILES` allowlist in `deploy.js` — **nothing else enters the extension directory**:

- Extension core: `main.js` `scene.js` `package.json` `reload.js` `test.js` `hub.js` `injector.js` `inject-runtime.js` `bridge.js`
- Docs: `README.md` `README.en.md` `DEVELOP.md` `HANDOFF.md`
- Pure logic layer: the 10 modules under `lib/` (**miss one and startup fails with `Cannot find module`**)

`dev-client.js` / `deploy.js` / `bootstrap-probe.js` / `accept.js` are dev-time tools and are
**deliberately not deployed**.

### Manual deployment

```bash
# Check the target directory
ls ~/.CocosCreator/packages/
# Copy the whole directory (keep the lib/ structure)
cp -r . ~/.CocosCreator/packages/cocos-mcp-2x/
```

The cost of manual deployment is losing conflict detection and the syntax pre-check. A syntactically
invalid JS file in the extension directory makes the editor report something like "unknown tool", which
does not match the real cause and is painful to debug. **Use `deploy.js`.**

### After deploying

1. Menu **Extensions / Cocos MCP 2.x / Restart service** (or restart the editor)
2. `node dev-client.js 25800 get_project_info` to verify
3. `node dev-client.js 25800 mcp_selftest` and confirm `problems` is empty

---

## Testing and self-check

Four layers, from cheapest to most expensive:

| Layer | Command / tool | Needs editor | Verifies |
|---|---|---|---|
| **Self-check** | `node dev-client.js 25800 mcp_selftest` | Yes | Runs each tool for real: return shape, empty marking, error messages, three-table consistency |
| **Regression** | `node test.js` | **No** (mocked `Editor`, real HTTP) | 120+ assertions: serialization correctness, delete remapping, batch transactions, rename chain, argument bounds |
| **Cold start** | `node bootstrap-probe.js` | **No** | Builds a temp empty project, verifies 8 "from zero" assertions, cleans up |
| **End-to-end** | `node accept.js` | Yes | A full chain in a real editor, checking `errorTotal` |

`mcp_selftest` with `sideEffects: true` runs side-effecting tools **on a copy**, deletes it afterwards, and
verifies the md5 is unchanged — it will not pollute your project. After changing machines, switching
projects, or coming back after a while, run both:

```bash
node dev-client.js 25800 mcp_selftest
node dev-client.js 25800 mcp_selftest '{"sideEffects":true}'
```

### Making code changes take effect

```bash
node test.js                    # 1. regression (no editor needed)
node deploy.js                  # 2. deploy (syntax pre-check + conflict detection)
node reload.js                  # 3. hot reload (given port only, no editor restart)
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `textureLoaded is not a function` | `_spriteFrame` holds the PNG **main uuid** | Use `resolve_asset`, check `usableAsSpriteFrame` |
| `Cannot find module './lib/xxx.js'` | `lib/` not deployed | `node deploy.js` |
| `路径越界：xxx 不在项目目录内` | An absolute path was used | Use a project-root-relative path |
| Edited scene not visible in the editor | Not refreshed, or stale in-memory scene | `refresh_assets` + `editor_sync` reload |
| `找不到节点：xxx` | Wrong path | The error lists current scene node names; call `query_scene_tree` first |
| `有 N 个节点叫"xxx"，请写完整路径` | Duplicate node names | Write the full path |
| `拒绝删除：还有 N 处外部引用` | Dangling reference risk | Remove the references first (`asset_refs` shows who uses it) |
| `Editor.assetdb 不可用` | Not running inside the editor | This tool only works in-editor |
| Full-file git diff | Line endings changed | Use `edit_file`; do not rewrite whole files |
| `scene-script 通道超时` | Scene window not open | Open the scene window; check channels with `runtime` `cmd:info` |
| `未知工具 xxx` | Deploy did not take effect / typo in a legacy name | `deploy.js --check`; legacy names in the [appendix](#appendix-legacy-tool-names) |

### Two traps worth calling out

**1. Chinese text is escaped in compiled output**

`.ts` compiles to JS where Chinese is `\uXXXX`, so grepping for Chinese finds nothing — and you may
wrongly conclude "the new code is not in the output":

```js
const esc = Array.from('钥匙不足').map(function (c) {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
}).join('');
s.indexOf(esc)
```

**2. Editing `.ts` is not editing the game (on the build path)**

Builds use **compiled JS** (`temp/quick-scripts/dst/` and `library/imports/<uuid>.js`). The build option
`autoCompile: false` means **a build does not trigger compilation — it uses the cache.** After editing,
wait for the editor to compile (watch the mtime of `library/imports/<uuid>.js`) before building, and use
`editor` `cmd:compile-status` to check for staleness.

The engine preview does not have this problem — it uses the instant compiler.

---

## Compatibility and limitations

**Target**: Cocos Creator 2.4.x (verified on 2.4.15). 3.x is not supported.

- **2.4 bundles an old Node** — main-process code cannot use optional chaining `?.`, nullish coalescing
  `??`, or top-level `await`. The syntax pre-check in `deploy.js` catches it, but the reported location may
  be off: when you see "syntax error", suspect new syntax sugar first.
- **The scene window does not reload scene scripts** — after editing `scene.js`, restart the editor (or use `reload.js`).
- **Prefabs cannot be reloaded from outside** — close and reopen.
- **`__id__` shifts are structural** — any insert or delete renumbers every subsequent object, so use the
  node-level diff rather than a byte diff.
- **In-editor runtime (`source: scene`) requires an open scene window**
- **`errorTotal` includes editor noise** — `runtime` `cmd:report` filters it and reports `noiseFiltered`

More war stories: [HANDOFF.md](HANDOFF.md). Architecture and dev conventions: [DEVELOP.md](DEVELOP.md).

---

## Appendix: legacy tool names

**v0.8.0 merge table** (8 `cmd` entries absorbing 30 tools):

| Legacy name | Now | `cmd` |
|---|---|---|
| `scene_add_node` · `scene_remove_node` · `scene_move_node` · `scene_set_props` · `scene_add_component` · `scene_remove_component` · `scene_set_component_props` · `scene_apply` | `scene_edit` | `add-node` · `remove-node` · `move-node` · `set-props` · `add-component` · `remove-component` · `set-component-props` · `apply` |
| `asset_query` · `asset_move` · `asset_delete` · `asset_meta_get` · `asset_meta_set` | `asset` | `query` · `move` · `delete` · `meta-get` · `meta-set` |
| `prefab_create` · `prefab_layout_check` · `prefab_diff` | `prefab` | `create` · `check-layout` · `diff` |
| `build_targets` · `build_project` · `build_status` | `build` | `targets` · `start` · `status` |
| `project_settings_get` · `project_settings_set` | `project_settings` | `get` · `set` |
| `runtime_info` · `runtime_read` · `eval_scene` · `runtime_report` · `runtime_inject` | `runtime` | `info` · `read` · `eval` · `report` · `inject` |
| `preview_control` · `preview_command` | `preview` | `control` · `command` |
| `get_editor_log` · `script_compile_status` | `editor` | `log` · `compile-status` |

**v0.4.0 merge table** (same action, different input shapes; legacy names still forward):

| Legacy name | Now | Parameter change |
|---|---|---|
| `read_scene_node` | `query_scene_tree` | Add `detail: true` |
| `mcp_audit` | `mcp_selftest` | No-side-effects mode is the default |
| `mcp_verify_all` | `mcp_selftest` | Add `sideEffects: true` |
| `resolve_uuid` / `resolve_sprite_frame` | `resolve_asset` | Unified as `input` (old fields still accepted) |
| `execute_script` / `execute_script_file` | `run_script` | Use `code` / `path` |
| `prefab_instantiate` | `scene_edit` `add-node` | Add `from: "prefab"` |
| `prefab_create_from_node` | `prefab` `create` | Add `from: "node"` |
| `scene_ping` / `scene_probe` | `scene_diagnose` | Add `probe: true` |
| `runtime_console` / `preview_report` / `runtime_browser_report` | `runtime` `report` | Add `source: scene` / `preview` / `build` |
| `runtime_eval` / `scene_eval` | `runtime` `eval` | Use `expr` / `code` |

Legacy names may need 2 hops (v0.4.0 name → v0.7.0 relay name → v0.8.0 aggregate). `callTool` follows the
chain and reports `__hops` and the final `__hint`. Cycles are capped at 4 hops.

---

MIT License · author UC-RX0
