# 提交审查：补丁累积分析与合并方向

> 仓库：`/home/plana/Repos/dsh-rtk-filter`
> 分支：`refactor/consolidate-patches`（= `main` 17 个提交 + 基础提交 `2bf5660`，共 18 个提交）
> 审查基准：当前工作树 HEAD `2bf5660`（下文的 `file:line` 均以该工作树为准；历史提交用 `sha` 标注）
> 方法：`git log --format="%h %ad %s" --date=short --stat`、`git show <sha> -- <paths>`、`git show <sha> --stat`，并逐一对照当前源码与 `HANDOFF.md` §5/§6/§7。
> 性质：只读考古 + 证据整理；本文件是后续重构评审的输入，不是重构本身。

## 0. 结论摘要

1. 18 个提交里，6 个纯能力提交贡献了 3946/6969 行新增（57%），其中 `40e582b`（+1220）与 `ee4fba8`（+1395）两个提交就占新增总量的 37%：能力以“一次性大提交”落地，随后被多条小补丁修补。
2. 5 个提交是在修早先提交的对外契约（`3226c23`、`0c4d48b`、`4de2b78`、`3239aea`、`8e6832d`），占全部提交的 28%；其中 `0c4d48b` 修 `3226c23`、`8e6832d` 修 `103d846`、`4de2b78` 修 `aef731e`，是“补丁的补丁”。
3. 补丁集中在 4 条链：**预设 bash 形状**（2 个提交）、**PATH 覆盖层**（2 个）、**persistent-shell 提示**（2 个）、**安装器**（5 个能力/重构提交 + 1 个文档提交），另有 **Settings 面板**（2 个）。每条链的症状都能落到当前一个具体函数上。
4. 收敛路径已经清晰：`lib/proc.js`（`2bf5660`）是通用的子进程/中止/错误文本基座；剩余的重复可以归结为 4 个新边界——`lib/shell.js`（shell profile）、`lib/config.js`（默认值唯一来源）、`lib/fsx.js`+`lib/store.js`（安装器状态）、以及 `rewrite.js`/`status.js` 中的两个纯函数解释器/构造器。

---

## 1. 审查口径

分类定义（按提交**实际效果**，而非标题）：

| 类型 | 判定 |
|---|---|
| `初始化` | 仓库第一个提交，一次性建立可运行基线 |
| `feat` | 新增用户可见能力（安装器、面板、作用域提示等） |
| `fix` | 修正既有提交的行为缺陷（schema、PATH、文案/布局） |
| `docs` | 只改文档；若同时改运行时文本则单独注明 |
| `refactor` | 不改变行为的结构收敛 |

判断“补丁”的标准：该提交的改动对象是**更早提交引入的代码/契约**，并且提交信息或 diff 明确写出先前的症状。

---

## 2. 逐提交表（17 个 main 提交 + 1 个分支基础提交）

| # | sha | 日期 | 类型 | 规模 | 做了什么（证据） | 能力 or 修复前作 | 所属族 |
|---|---|---|---|---|---|---|---|
| 1 | `732e840` | 11-09 | 初始化 | 17 files +1446 | 首个完整插件：同名 bash 影子、`rtk rewrite` 协议、awareness 文本、激活生命周期（`lib/shadow.js`、`lib/rewrite.js`、`lib/activate.js` 均由本提交建立） | 建立基线 | 基线 |
| 2 | `af367a8` | 11-09 | docs | +203 | 新增 `HANDOFF.md`（`A HANDOFF.md`），补 README | 无运行时变化 | 文档 |
| 3 | `a052c06` | 11-09 | refactor | 3 files +174/-22 | 把 semver 解析与最低版本门禁从 `rewrite.js` 抽到 `lib/version.js:17-97`；`rewrite.js:21` 改 re-export；`probeRtk` 增加 `signal`（`lib/rewrite.js:29-33`）；删除 `RewriteAbortedError` | 无行为变化；为安装器预备共享版本逻辑 | 安装器 |
| 4 | `f28e436` | 11-09 | feat | 3 files +322 | 新建 `lib/tar.js`：`TarError`（`:18`）、`extractFromTarGz`（`:93`），拒绝路径穿越/链接/重复/截断/超限 | 新增能力 | 安装器 |
| 5 | `4474db5` | 11-09 | feat | 2 files +486 | 新建 `lib/release.js`：`fetchLatestTag`（`:189`，redirect 优先、GitHub API 回退）、`downloadRelease`（`:235`，SHA-256 校验）、`request/readBuffer/readText`（`:131-178`） | 新增能力 | 安装器 |
| 6 | `40e582b` | 11-09 | feat | 2 files +1220 | 新建 `lib/sidecar.js`（744 行）：`createRtkManager`（`:239`）巨型闭包 + 15 个嵌套函数；文件/状态/GC 辅助 `:95-216`；锁 `:427`、安装 `:493`、更新 `:596` | 新增能力；同时是后续重构的主要对象 | 安装器 |
| 7 | `aef731e` | 11-09 | feat | 2 files +108/-6 | `lib/shadow.js` 增加 `shellQuote`（`:19`）、`withRtkPath`（`:32`）与 `getPathPrefix`，每条委托命令前置 PATH 覆盖层 | 新增能力 | PATH/shell |
| 8 | `7e987a8` | 11-09 | feat | 6 files +415/-50 | 把 manager 接入激活：`activate.js:144-487` 惰性影子、ready 后加提示；`DEFAULTS` 扩充安装/更新/版本项（`lib/activate.js:17-29`）；配置项与冒烟测试 | 新增能力 | 安装器/激活 |
| 9 | `5536a75` | 11-09 | docs | 3 files +449/-91 | HANDOFF §5-§7 与 README 描述自安装二进制、缓存布局、更新策略 | 无运行时变化 | 文档 |
| 10 | `ee4fba8` | 11-10 | feat | 12 files +1395/-10 | 新建 `lib/status.js`（`aggregateGain:95`、`runGain:148`、`registerStatusRoute:211`）与 `lib/client.js`（625 行浏览器 bundle）；`activate.js:194-222` 注册状态端点；`package.json:10,27-33` 暴露 client | 新增能力；单提交跨 12 文件，随后即被修 | 面板 |
| 11 | `a87a960` | 11-10 | docs | 2 files +83 | README/README_zh 架构图 | 无运行时变化 | 文档 |
| 12 | `3239aea` | 11-10 | fix(ui) | 1 file +6/-6 | `client.js`：指标文案澄清（`节省比例`→`Token 节省率`，`:29-32,70-73`）、KPI 网格 4 列→2 列（`:117,158`） | **修复 `ee4fba8`** | 面板 |
| 13 | `3226c23` | 11-11 | fix | 5 files +243/-25 | `activate.js`：`EXPECTED_SHELL`（`:72-74`）、`presetOf`、`shapeAccepts`（`:108-116`）、注册守卫（`:317-326`）、`tools/change` 重捕获（`:380-397`）、capture 结构化（`:338-342`） | **修复 `732e840` 的影子捕获假设**（症状：minimal 会话报 `missing required property "description"`） | 预设 shell |
| 14 | `0c4d48b` | 11-12 | fix | 5 files +143/-34 | `presetOf` 改读 `agentPresets.presetForSession`（`:85-98`）；新增 `drop`（`:353-365`）与 `agent-preset/selected` 处理（`:410-416`）；reconcile 增加形状复检（`:386-392`） | **修复 `3226c23` 用创建 header 判定 preset** | 预设 shell |
| 15 | `4de2b78` | 11-12 | fix | 3 files +33/-7 | `shadow.js:32-38`：用 `case ":$PATH:"` 判重、目录存 `__rtk_prefix`，只在缺失时 export | **修复 `aef731e`**（症状：persistent shell 里 9 次调用出现 9 份目录） | PATH/shell |
| 16 | `103d846` | 11-12 | docs | 3 files +11/-3 | `awareness.js:8` 的全局提示追加“command-only shell 没有 workdir/timeoutMs” | 文档标题，但**改运行时提示**；这份过宽文案正是 `8e6832d` 要修的对象 | persistent-shell 提示 |
| 17 | `8e6832d` | 11-12 | feat | 4 files +122/-8 | `awareness.js:19,22` 拆出 `shellOnlyNote`/`awarenessTextWithShell`；`activate.js:119-124` `isCommandOnly`、`:239-267` `showShellNote`/`dropShellNote`，随影子生命周期增删 | **修正 `103d846` 的全局提示**（标题写 feat，效果是 fix） | persistent-shell 提示 |
| 18 | `2bf5660` | 11-12 | refactor | 5 files +110/-111 | 新建 `lib/proc.js`（`DEFAULT_MAX_BUFFER:14`、`isAbortError:22`、`abortError:28`、`describeError:36`、`runProcess:53`）；4 个模块改 import（`release.js:12`、`rewrite.js:18`、`sidecar.js:18`、`status.js:16`），删除各自的 exec/abort/describe 副本 | 收敛重复，无行为变化（提交信息：测试 108/108） | 共享基座（分支基础） |

> 统计口径：全部 18 个提交合计 **+6969 / -373** 行。

---

## 3. 补丁链分析（症状 → 根因 → 补丁 → 合并设计）

### 3.1 预设 bash 形状：`3226c23` → `0c4d48b`（+386 行，集中在 `lib/activate.js`）

**症状**

- 极简会话里调用 bash 报 `invalid arguments: missing required property "description"`（`3226c23` 提交信息；`HANDOFF.md:278-280` 记录同一症状）。
- 在 `ops-ptc` 下创建、随后切到 `minimal` 的会话，模型始终只看到标准 `dsh-tool-bash` 的 schema，每次调用新起 shell，并且 `run_in_background` 暴露了 minimal 组合根本没有挂载的 job controller（`0c4d48b` 提交信息）。

**根因**

- 影子在注册前捕获 `ctx.tools.get('bash', agent)`，但捕获结果可能是**另一个平面**的标准 bash（`lib/activate.js:307` 的注释；`HANDOFF.md:210-212`）。把标准 schema 镜像进 minimal 会话，等于同时改掉模型可见 schema 与执行语义。
- 第一版 `3226c23` 用 `agent.session.header.agentPreset` 判定 preset（该函数原实现被 `0c4d48b` 替换，见 diff 的 `-` 行）。Web 端先用 registry 默认 preset 建会话、再 `select()` 用户 preset，header 永远停在创建时（`HANDOFF.md:282-287`），于是判据失效。
- 影子一旦占住 `bash` 名字，`ctx.tools.get` 只会返回影子自身（`lib/activate.js:374-378` 的注释），**preset 的 bash 永远不再可见**，只有“capture 的形状”这一条证据能反推 preset 是否变化。

**补丁**

1. `3226c23`：引入 `EXPECTED_SHELL` 策略表与 `shapeAccepts` 守卫（当前 `lib/activate.js:72-116`），形状不符就**不过滤**；捕获记录改为 `{ definition, base, dispose }`（`:338-342`），并在 `tools/change` 时 reconcile（`:380-397,420-422`）。
2. `0c4d48b`：`presetOf` 改读 registry 投影（`:85-98`）；新增 `drop`（`:353-365`）；监听 `agent-preset/selected`，先丢弃影子再重捕获（`:410-416`）；reconcile 在“可见==影子”分支里追加 preset 形状复检（`:386-392`）。

**合并设计**

- 当前 5 个散落函数（`EXPECTED_SHELL`、`presetOf`、`shapeAccepts`、`isCommandOnly`、`describeBase`，`lib/activate.js:66-131`）本质是**一个 shell profile 模型**：`deriveProfile(base, preset) -> { mode: 'command-only'|'standard'|'custom', accepted, note, overlayPolicy }`。
- `activate.js` 只应保留“何时捕获/何时丢弃/何时注册”的生命周期，不再持有形状知识。归入 task-1 的 `lib/shell.js`。

### 3.2 PATH 覆盖层叠加：`aef731e` → `4de2b78`（+141 行）

**症状**：minimal 会话（persistent shell 跨调用保留环境）中，一次探测会话 9 次调用后 `PATH` 里出现 9 份托管目录（`4de2b78` 提交信息；`HANDOFF.md:289-294`）。

**根因**：`aef731e` 为每条委托命令无条件前置 `export PATH='<dir>':"$PATH";`。这对标准 bash（每次新 shell）无副作用，但 minimal 的 persistent shell 复用环境，于是每调用一次叠加一层。

**补丁**：`4de2b78` 改为幂等覆盖层——目录写入 `__rtk_prefix`，用 `case ":$PATH:"` 判重，只在缺失时 export（当前 `lib/shadow.js:32-38`）。

**合并设计**：覆盖层是“shell 是否持久”的派生结果，不是 shadow 的字符串模板细节。应由 `lib/shell.js` 根据 profile 产出 `overlayCommand(prefixDir)`（幂等版本统一一份），`shadow.js` 只负责调用（`lib/shadow.js:98-99`）。归入 task-1。

### 3.3 persistent-shell 提示：`103d846` → `8e6832d`（+133 行）

**症状**：minimal 的 bash 只声明 `command`，`workdir`/`timeoutMs` 被静默丢弃；模型以为目录没切过去（`103d846` 提交信息；`HANDOFF.md:296-299`）。

**根因**：awareness 只有**一段全局文本**（`lib/activate.js:224-233` 的全局 section），“command-only”的注意事项被追加到这段全局文本里（`103d846` 对 `lib/awareness.js:8` 的改动），结果标准会话也读到“没有 workdir”的错误说明。

**补丁**：

1. `103d846`：把句子加进全局 `awarenessText`（当时是 `awareness.js` 单文件尾部）——修了 minimal，但污染了标准会话。
2. `8e6832d`：拆出 `shellOnlyNote` 与 `awarenessTextWithShell`（`lib/awareness.js:19,22`），用**同名 scoped section 遮蔽全局段**，只对 command-only 的 agent 生效（`isCommandOnly:119-124`、`showShellNote:239-256`），并跟随影子生命周期移除（`dropShellNote:258-267`，挂点 `:343,364,405,443`）。

**合并设计**：提示文本属于 shell profile 的 `note` 字段（base 文本 + command-only 附加句），由 `shell.js` 组合；`awareness.js` 退回纯文本数据；`activate.js` 只管 section 注册/释放。归入 task-1。

### 3.4 安装器链：`a052c06` → `f28e436` → `4474db5` → `40e582b` → `7e987a8`（+2617 行；另有 `aef731e` 与文档 `5536a75`）

**结构（按时间）**

1. `a052c06`（refactor）：先把 `rewrite.js` 中的版本逻辑抽到 `lib/version.js`，让“rewrite 路径”与“安装器”对最低版本有同一判断；同时给 `probeRtk` 加 `signal`（`lib/rewrite.js:29-33`），并把 `RewriteAbortedError` 从 `rewrite.js` 删掉。
2. `f28e436`：`lib/tar.js`（`:93 extractFromTarGz`）。
3. `4474db5`：`lib/release.js`（`:189 fetchLatestTag`、`:235 downloadRelease`，以及本地 `request/readBuffer/readText` `:131-178`）。
4. `40e582b`：`lib/sidecar.js` 744 行一次性落地——`createRtkManager`（`:239`）内部 15 个嵌套函数（`:288-724`），文件/状态/GC 辅助放在模块级（`:75-216`）。
5. `7e987a8`：把 manager 接入 `activate.js`，并加安装/更新配置与重写冒烟。
6. `aef731e`（PATH 覆盖层，见 3.2）与 `5536a75`（文档）依赖这条链。

**症状与根因**

- 症状不是运行时错误，而是**可维护性劣化**：`732e840`（rewrite）、`4474db5`（release）、`40e582b`（sidecar）、`ee4fba8`（status）各自复制了同一批原语——子进程执行、abort 判定、错误转文本、超时/缓冲。证据：`2bf5660` 一次性删除 `rewrite.js` 的 `run/isAbort/RewriteAbortedError`、`release.js` 的 `isAbortError/describe`、`sidecar.js` 的 `abortedError`、`status.js` 的内联 `execFile` promise，净变化 `+110/-111`。原子 JSON 写入/临时文件名则是安装器内部（`sidecar.js` 的 `tempPath/writeJson`）的重复点，留给 task-2 拆 `fsx.js`。
- 更深一层：安装器主体是一个 737 行的模块（`40e582b` 创建时 744 行），其中 `createRtkManager`（`lib/sidecar.js:239-737`，约 500 行）是一个巨型闭包，把**缓存布局、state schema、版本列举、GC、锁、latest 缓存、安装、更新调度**全部塞进一个作用域；`installTag`（`:576`）依赖 `acquireLock`（`:427`）、`installRelease`（`:493`）依赖 `probe`（`:309`）与 `writeState`（`:152`），抽任何一块都要先搬整块上下文。
- 原子写/临时路径重复：`tempPath`（`:95-98`）被 `writeJson`（`:108-113`）用于 state 与 latest（`:152,489`）；而 release 侧有独立的 `readBuffer/readText`（`lib/release.js:157-178`）做大小限制。`sidecar.js:115-121` 还留着一个 `describe` 包装（先特判 `ReleaseError/TarError`，再委托 `describeError`），说明“错误格式化”尚未完全归一。
- `a052c06` 还留下一次“抽了又被收”的反复：它删掉的 abort 类，最终由 `2bf5660` 以 `proc.abortError`（`lib/proc.js:28`）统一回来。

**补丁（已落地的一半）**：`2bf5660` 建立 `lib/proc.js`，四个模块改 import（`lib/release.js:12`、`lib/rewrite.js:18`、`lib/sidecar.js:18`、`lib/status.js:16`），是分支的基础提交，也是整次重构的范式样板。

**合并设计**：按“状态/IO/调度”三件事拆开——`lib/fsx.js`（`tempPath`、原子 `readJson/writeJson`、目录创建）、`lib/store.js`（`layoutFor`、`readState/writeState`、`listVersions`、`collectGarbage`、`acquireLock`）、`lib/sidecar.js` 只留 `createRtkManager` 的编排（解析来源、probe、安装/更新调度）。归入 task-2。

### 3.5 Settings 面板：`ee4fba8` → `3239aea`（+1401 行）

**症状**：“节省比例”指标语义含糊（分母是原始输出还是调用量？），4 列 KPI 在窄面板里拥挤（`3239aea` 提交信息与 diff）。

**根因**：面板是一次性大提交（12 文件；`lib/client.js` 625 行、`lib/status.js` 285 行、`activate.js:194-222` 路由、`package.json:27-33` client 注入），**视图、文案、指标定义、数据折叠混在一起**：文案在中英字典各写一遍（`lib/client.js:29-32,70-73`），布局在 CSS 内联字符串里硬编码 4 列（`:117,158`，`3239aea` 改为 2 列），payload 构造留在路由 handler 内联（`lib/status.js:269-282`），因此只能靠“再补一个小 UI 提交”修正语义。

**补丁**：`3239aea` 只改 6 行——文案澄清 + `repeat(4,…)`→`repeat(2,…)`（含 skeleton 同步，`:158`）。

**合并设计**：把 `status.js` 的“读 + 折叠 + 组装”拆成纯 `buildStatusPayload`（可单测），路由只做方法/鉴权/序列化；`client.js` 只做机械去重、保持 `window.__ModuleLoader__.load({id, factory})` 契约与 DOM 输出不变（task-3 的 1、2、3 项）。指标口径（`calls/savedTokens/savingsPct/avgSavedPerCall`，`lib/status.js:133-142`）应成为 payload 契约的一部分，而不是 UI 文案的隐含假设。

### 3.6 不构成补丁链的提交

`732e840`（基线）、`af367a8` / `5536a75` / `a87a960`（纯文档）、`2bf5660`（共享基座，横跨多条链）单独成立，不进入上面的成对分析。

---

## 4. Feature vs fix 普查

### 4.1 按提交标题

| 类型 | 数量 | 提交 |
|---|---|---|
| 初始化 | 1 | `732e840` |
| feat | 7 | `f28e436`、`4474db5`、`40e582b`、`aef731e`、`7e987a8`、`ee4fba8`、`8e6832d` |
| fix | 4 | `3226c23`、`0c4d48b`、`4de2b78`、`3239aea` |
| docs | 4 | `af367a8`、`5536a75`、`a87a960`、`103d846` |
| refactor | 2 | `a052c06`、`2bf5660` |
| **合计** | **18** | |

### 4.2 按实际效果（评审采用的分类）

| 效果 | 数量 | 提交 | 一句话理由 |
|---|---|---|---|
| 新增能力 | 6 | `f28e436`、`4474db5`、`40e582b`、`aef731e`、`7e987a8`、`ee4fba8` | 每项都引入此前不存在的能力 |
| 修复前作 | 5 | `3226c23`、`0c4d48b`、`4de2b78`、`3239aea`、`8e6832d` | 改的是更早提交引入的 schema/覆盖层/提示/指标；`8e6832d` 标题为 feat，实质是修 `103d846` |
| 文档 | 3 | `af367a8`、`5536a75`、`a87a960` | 只改 `.md` |
| 文档但改运行时 | 1 | `103d846` | 标题 docs，实际改 `lib/awareness.js` 的提示文本 |
| 结构重构 | 2 | `a052c06`、`2bf5660` | 不改变对外行为 |
| 初始化 | 1 | `732e840` | 基线 |

**观察**

- 修复:能力 = 5:6；纯“补丁的补丁”有 3 处（`0c4d48b`→`3226c23`、`8e6832d`→`103d846`、`4de2b78`→`aef731e`）。这说明缺陷集中在**对外契约**（schema、PATH、提示、指标语义），而不是实现细节。
- 修复提交行数占比很低：5 个修复提交合计 +547 行（8%），却改变了 4 类对外行为；能力提交合计 +3946 行（57%）。评审时应按“契约改动”而非“行数”排优先级。
- 标题与效果有 3 处偏差：`8e6832d`（feat→fix）、`103d846`（docs→运行时）、`2bf5660`（refactor，但实际修掉 4 处重复实现）。

---

## 5. 合并映射：补丁链 → 当前落点 → 目标模块 → 任务

| 补丁链 / 重复点 | 当前落点（`2bf5660` 工作树） | 合并到 | 对应任务 |
|---|---|---|---|
| 预设 bash 形状 | `lib/activate.js:72-74`（`EXPECTED_SHELL`）、`:85-98`（`presetOf`）、`:108-116`（`shapeAccepts`）、`:119-124`（`isCommandOnly`）、`:317-326`（守卫）、`:338-342`（capture）、`:380-397`（reconcile）、`:410-416`（preset 切换） | `lib/shell.js`：`deriveProfile` + 单一 policy 表 + 接受性判定 | task-1 第 1、3 项 |
| PATH 覆盖层 | `lib/shadow.js:19-21`（`shellQuote`）、`:32-38`（`withRtkPath`）、`:98-99`（调用点） | `lib/shell.js` 的幂等 overlay；`shadow.js` 改为消费 | task-1 第 1、4 项 |
| persistent-shell 提示 | `lib/awareness.js:19,22`；`lib/activate.js:239-267`（`showShellNote`/`dropShellNote`） | `lib/shell.js` 组合文本；`awareness.js` 仅保留文本数据 | task-1 第 1 项 |
| 配置默认值三处 | `lib/activate.js:17-53`（`DEFAULTS`+normalize）、`index.js:31-49`（Config 字面量）、`lib/sidecar.js:258-273`（再 clamp） | `lib/config.js` 单一描述符；`index.js` 由描述符生成 Config | task-1 第 2 项 |
| abort 错误工厂 | `index.js:57-62`（`toolAborted`）、`lib/shadow.js:54-58`（`defaultToolAborted`）；规范版已在 `lib/proc.js:28` | `lib/proc.js`，删除两处工厂 | task-1 第 4、5 项 |
| 安装器单体 | `lib/sidecar.js:95-216`（fs/state/GC）、`:239-737`（manager 闭包）、`:427`（锁）、`:493`（安装）、`:596`（更新） | `lib/fsx.js` + `lib/store.js`；`sidecar.js` 退化为编排 | task-2 第 1-3 项 |
| release/tar/version 重复 | `lib/release.js:118-178`（request 系列）、`lib/tar.js:93`、`lib/version.js:17-97` | 复用 `lib/proc.js`；保留网络/归档专用逻辑 | task-2 第 4 项 |
| rewrite 协议 | `lib/rewrite.js:64-112`（`rewriteCommand` 内联 0/1/2/3、killed、ENOENT 分支；`probeRtk:29`） | 纯解释器 + `runProcess` 组合 | task-3 第 1 项 |
| status payload | `lib/status.js:148-171`（`runGain`）、`:184-192`（`sendJson`）、`:211-285`（路由内联 payload） | 纯 `buildStatusPayload` + 薄路由 | task-3 第 2 项 |
| client bundle | `lib/client.js:1`（loader 契约）、`:29-32/70-73`（字典）、`:117/158`（KPI 网格）、`:305/387`（图表/状态页） | 仅机械去重，保持契约与渲染不变 | task-3 第 3 项 |
| 子进程/中止基座 | `lib/proc.js:14-73` | **已落地**（`2bf5660`） | 分支基础 |

---

## 6. 推荐的目标架构（end-state）

```text
index.js                 只做 name/inject/Config(来自 lib/config.js)/apply 装配
  ├─ lib/config.js       选项默认值 + 归一化 + schemastery 描述符（唯一来源）
  └─ lib/activate.js     生命周期编排：manager、影子注册/重放、status 路由、prompt 时机
       ├─ lib/shell.js   shell profile：形状策略表、接受性、幂等 PATH overlay、提示组合
       │    └─ lib/awareness.js  纯文本数据（base / command-only）
       ├─ lib/shadow.js  镜像 + 委托；消费 shell.js 的 overlay 与 proc.js 的 abort
       ├─ lib/status.js  纯 payload 构造 + 薄 HTTP 路由
       └─ lib/sidecar.js 二进制来源解析、probe、安装/更新调度（组合）
            ├─ lib/fsx.js     原子 JSON/临时路径/目录
            ├─ lib/store.js   布局、state 校验、版本列举、GC、锁
            ├─ lib/release.js 网络/校验（fetch、checksums、latest）
            ├─ lib/tar.js     归档解析
            └─ lib/version.js semver/门禁
lib/rewrite.js            纯协议解释器 + proc.runProcess
lib/proc.js               子进程/中止/错误文本（已落地，所有模块的唯一来源）
lib/client.js             浏览器 bundle（保持 __ModuleLoader__ 契约）
```

**应固化的不变量**

1. 依赖单向：叶子模块 `proc.js`、`version.js`、`awareness.js` 不 import 其他 `lib/` 模块；`activate.js` 不直接做进程/文件 IO。
2. 默认值只出现在 `config.js`；`sidecar.js` 保留对 raw config 的防御性 clamp 时必须引用同一常量，而不是重写数字（现状 `lib/sidecar.js:258-273` 与 `lib/activate.js:17-29` 各写一份）。
3. 所有子进程走 `runProcess`，所有中止错误走 `abortError`，所有错误文本走 `describeError`（`sidecar.js:115` 的 `ReleaseError/TarError` 特判保留在安装器侧）。
4. 对外契约（bash schema 镜像、PATH 覆盖层、prompt 文本、status JSON 字段）在 `shell.js`/`status.js` 中各只有一处定义。
5. 纯函数边界（rewrite 解释器、status payload）必须能脱离 HTTP/子进程单测。

---

## 7. 三个并行任务未覆盖的残余工作

1. **文档同步没有归属任务**：`HANDOFF.md:272-303`（§7 第 14-16 条）逐字描述了即将被合并进 `shell.js` 的实现细节；`HANDOFF.md:139-171`（§5 配置表）与 `README.md`/`README_zh.md` 中由 `3226c23`、`0c4d48b`、`4de2b78` 追加的“preset 守卫 / 幂等覆盖层”段落也需随模块迁移改写。建议评审合并后补一个纯文档提交。
2. **测试总数漂移**：`HANDOFF.md:23` 写 97/97，而 `2bf5660` 提交信息写 108/108。合并三任务后应统一为一次实测值并回写 HANDOFF。
3. **`sidecar.js:115-121` 的 `describe` 包装**：`2bf5660` 只把它内部改成 `describeError`，函数本身仍是 `ReleaseError/TarError` 特判 + abort 判定的组合。拆 `fsx.js` 时不能把它简化成通用 `describeError`，否则安装失败日志会丢 code 前缀。
4. **abort 错误 `code` 的收敛决策**：`index.js:61` 现在用 `code = 'ABORTED'`，而 `proc.abortError`（`lib/proc.js:28`）默认 `'ABORT_ERR'`。现有测试只断言 `name === 'AbortError'`（`test/rewrite.test.mjs:95-105`、`test/shadow.test.mjs:131-135`），合并时需明确选哪个 code，并在 HANDOFF 记录，避免 Host 侧渲染差异。
5. **`activate.js:189-222` 的运行时健康投影**：`runtimeStatus` 目前既是 manager 适配又是 HTTP payload 字段来源。task-3 做纯 payload 构造时，应把“健康投影”与“stats 聚合”的单一职责写清；否则状态页的 `state/version/source` 仍会跨层泄漏。
6. **`docs/COMMIT_REVIEW.md` 自身的提交与引用**：由 lead 提交；如需长期保留，建议在 HANDOFF §10 参考里加一行链接，否则下次审查会重复考古。
7. **HANDOFF §9 的既有 backlog**：CI/remote、`tools/change` 时刷新捕获定义、Windows/pwsh、`$DSH_RTK_BIN`（`HANDOFF.md:339-348`）不在三任务范围内，本次重构不应顺手改动，以免扩大回归面。
8. **性能/安全回归门槛**：安装器拆分与 rewrite 解释器抽取后，建议保留 `test/sidecar.test.mjs`、`test/release.test.mjs`、`test/tar.test.mjs`、`test/rewrite.test.mjs` 的全部断言（三任务均要求“不删除断言”），并在合并后用真实 `$DSH_HOME` 跑一次安装冒烟（HANDOFF §6 的方法）。

---

## 8. 附录：复现命令

```bash
# 提交清单与规模
git log main --reverse --format="%h %ad %s" --date=short --stat
git log --all --format="=== %h %ad %s" --date=short --stat

# 单提交 diff（例如预设 shell 链）
git show 3226c23 -- lib/activate.js
git show 0c4d48b -- lib/activate.js
git show 4de2b78 -- lib/shadow.js
git show 103d846 -- lib/awareness.js
git show 8e6832d -- lib/activate.js lib/awareness.js

# 安装器链
git show a052c06 --stat; git show f28e436 -- lib/tar.js
git show 4474db5 -- lib/release.js; git show 40e582b --stat
git show 7e987a8 -- lib/activate.js; git show 2bf5660 -U0 -- lib/

# 面板链
git show ee4fba8 --name-status; git show 3239aea

# 当前落点
grep -n "EXPECTED_SHELL\|presetOf\|shapeAccepts" lib/activate.js
grep -n "withRtkPath\|shellQuote" lib/shadow.js
grep -n "createRtkManager\|function " lib/sidecar.js
```
