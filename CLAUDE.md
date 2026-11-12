# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

DSH（DeepSeek Harness）插件：把模型调用的 `bash` 命令透明地改写成 `rtk ...`，让 RTK 压缩后的输出回到模型。插件**不新增工具、不改 schema**，而是为每个 agent 注册一个同名 `bash` 影子工具，捕获并委托给该 agent 原本继承的 `bash`，因此沙箱、审批、后台 job、超时、输出渲染和退出码全部复用 DSH 原实现。

插件还自行下载、校验、更新托管 RTK 二进制到 `$DSH_HOME/cache/rtk-filter`，不要求全局安装，也不写用户 `PATH`。Web 设置页提供状态仪表盘。

## 常用命令

仓库零依赖、无构建步骤、无 lint 配置；除 `index.js` 对 schemastery 的一次可选动态导入外，只使用 Node 内置模块。

```bash
# 全部单元测试（297 个，使用 fake rtk / 生成的 tar / fake fetch / fake Context）
node --test test/*.test.mjs

# 覆盖率（行/分支/函数均为 100%；lib/client.js 由 VM 沙箱评估，不在插桩集合内）
node --test --experimental-test-coverage test/*.test.mjs

# 单个测试文件
node --test test/shadow.test.mjs

# 按用例名过滤
node --test --test-name-pattern="PATH overlay" test/shadow.test.mjs
```

真实的安装链路冒烟（会联网，使用临时 `$DSH_HOME`，见 README「Development」节）：

```bash
DSH_HOME=$(mktemp -d) node --input-type=module -e "
import { createRtkManager } from './lib/sidecar.js'
import { probeRtk, rewriteCommand } from './lib/rewrite.js'
const manager = await createRtkManager({
  ctx: { get: () => ({ home: process.env.DSH_HOME }) },
  settings: { autoUpdate: false },
  deps: {
    probeRtk,
    smokeRewrite: async ({ binary, signal }) =>
      (await rewriteCommand({ binary, command: 'git status', signal })).kind === 'rewrite'
        ? { ok: true } : { ok: false, reason: 'no rewrite' },
    logger: console,
  },
})
console.log(await manager.start().ready, manager.current())
manager.dispose()
"
```

安装/卸载到 DSH 使用 Host 的 `plugin_manager` 工具（`install_bundle` / `remove_bundle`，target 为本仓库绝对路径）；链接安装的代码变更需要 Host 重新加载后才在 live 会话生效。

## 架构

### 一次 bash 调用的数据流

```
model calls bash(command)
  -> agent 作用域同名影子            lib/shadow.js
  -> rewriteCommand(command)         lib/rewrite.js -> `rtk rewrite`
       exit 0/3 + stdout  -> 执行改写后的命令
       exit 1             -> 执行原命令
       exit 2             -> 拒绝执行，返回 "rtk denied this command: ..."
       超时/ENOENT/未知   -> fail-open，执行原命令
  -> PATH 覆盖层（仅托管/绝对路径二进制）  lib/shell.js
  -> 继承的 bash 执行，过滤后输出走原结果路径
```

`rtk rewrite` 用 `execFile(binary, ['rewrite', command])`、不经 shell，退出码协议集中在纯函数 `interpretRewrite`。改写规则全部来自上游 RTK 二进制，插件不实现过滤规则。

### 模块分层

| 层 | 模块 | 职责 |
|---|---|---|
| 入口 | `index.js` | `name`/`inject`/可选 `Config`/`apply`，注入所有运行时依赖 |
| 配置 | `lib/config.js` | 选项默认值、归一化、schemastery 描述符（默认值唯一来源） |
| 编排 | `lib/activate.js` | 激活生命周期、惰性影子注册/重捕获、prompt 时机、状态路由、清理 |
| Shell 模型 | `lib/shell.js` + `lib/awareness.js` | preset 形状策略、幂等 PATH 覆盖层、提示文本组合与纯文本 |
| 过滤 | `lib/shadow.js` | 同名 bash 定义、getter 镜像、执行委托 |
| 过滤 | `lib/rewrite.js` + `lib/proc.js` | 退出码协议；子进程/abort/错误文本基座 |
| 安装器 | `lib/sidecar.js` | 组装层：来源解析（显式 > 托管 > PATH）、安装、更新调度 |
| 安装器 | `lib/store.js` / `lib/fsx.js` / `lib/release.js` / `lib/tar.js` / `lib/version.js` | 缓存布局与锁（无网络）、原子文件操作、下载与校验、防御性 tar、版本比较 |
| 设置页 | `lib/status.js` / `lib/client.js` | `rtk gain` 聚合与同源 JSON 路由；手写浏览器 bundle |

依赖规则：

1. **只依赖 Node 内置模块。** 从 checkout 链接安装的 bundle 无法解析 DSH 自带的 `@deepseek-ai/*` 包；`index.js` 仅在顶层用 `await import('@deepseek-ai/schemastery')` 机会性加载 `Config`，失败时退化为原始 config 归一化。不要为“补回 schema”加静态 import。
2. **`lib/` 内保持分层。** `proc.js`、`version.js`、`awareness.js` 是叶子；`activate.js` 不做进程/文件 IO，网络与缓存都归 `sidecar.js`；`store.js` 绝不联网，只有 `sidecar.js`/`release.js` 下载。
3. **`lib/client.js` 不是 ESM。** 它以 `window.__ModuleLoader__.load({ id, factory })` 形式被求值，不能使用 import；其中的字典 key、文案、CSS、DOM/SVG 都是用户可见 API。

### 激活与生命周期

- 激活时遍历 `ctx.agents.list()`，并在 `agent/created`、`agent/disposed`、`tools/change`、`agent-preset/selected` 上维护影子。
- 必须**在注册影子之前**用 `ctx.tools.get('bash', agent)` 捕获该 agent 的 bash：Web surface 的 bash 由 agent preset realm 组合，无 scope 的 `get('bash')` 返回 `undefined`；注册后同名查询只会返回影子自身。
- 影子的 `description`/`parameters`/`output`/`timeoutMs`/`present*` 等字段是对捕获定义的 getter，保证 schema 逐字一致。
- **preset 形状守卫**：`lib/shell.js` 的 `PRESET_SHELLS` 登记各 stock preset 的 bash 形状（`minimal` 只接受 `command`）。捕获到的定义若声明了策略外字段，说明来自别的平面——此时宁可不注册、不过滤，也不改变 schema 与执行语义。当前 preset 以 `agentPresets.presetForSession()` 为准，`session.header.agentPreset` 只作兜底（Web 端 header 停留在创建时的 preset）。
- 提示词受 `awareness` 控制，且只在二进制真正可用后添加；command-only shell 的 `workdir` 说明以同名 section 注册在 agent scope 上，不影响标准 preset 会话。

### 托管二进制

来源优先级：`RTK_BIN` / 非默认 `binary`（不下载）> 托管副本 > Host `PATH` 上的 `rtk`（下载期间的临时回退）> 后台安装 > 保持惰性并告警。

安装流程：解析 latest tag（redirect 优先、GitHub API 回退）→ 下载 `checksums.txt` 与 `rtk-<target>.tar.gz` → SHA-256 校验 → 防御性 tar 解压 → 暂存运行 `--version` 与 `rtk rewrite` 冒烟 → 原子 rename 到 `versions/<edition>/<target>/<version>/` → 原子写 state → GC（保留当前 + 上一版本）。每个 edition/target 有跨进程锁。

托管目录不在全局 `PATH` 上，因此影子在每条委托命令前加幂等覆盖层（目录存 `__rtk_prefix`，用 `case ":$PATH:"` 判重）：`lib/shell.js` 的 `withRtkPath` 是唯一实现。

### 设置页

浏览器从同源 `GET /rtk-filter/status?days=7` 读取聚合数据；数据来自 `rtk gain --daily --format json`，是机器级的 RTK 历史，不是插件自己计数。路由不返回命令文本或二进制路径，启用 Connection 信任校验时受其保护。

## 不变量与易错点

- **单一事实来源**：默认值 → `lib/config.js` 的 `OPTIONS`；preset 策略 → `lib/shell.js` 的 `PRESET_SHELLS`；PATH 覆盖层 → `withRtkPath`；提示文本 → `lib/awareness.js`；abort 契约/错误文本 → `lib/proc.js`；退出码协议 → `interpretRewrite`；状态 wire shape → `buildStatusPayload`；缓存布局/schema → `lib/store.js`。不要在调用方复制这些字面量或逻辑。
- **abort 有两个 code**：进程/安装取消用 `proc.js` 的 `abortError()`（`ABORT_ERR`）；工具调用取消用 `index.js` 的 `abortError('tool call aborted', 'ABORTED')`。两者 `name` 都是 `AbortError`。
- **已以 `rtk` 开头的命令不再改写**（避免递归），但托管二进制的 PATH 覆盖层仍会应用。
- **`RTK_DISABLED=1`** 在 Host 环境时跳过整个插件激活；逐命令前缀由 `rtk rewrite` 自身跳过。
- **改写结果不会出现在 session log 里**：`tool/call` 记录模型写的原始命令；只有 `logRewrites: true` 才在 Host log 留下改写对。
- **PATH 覆盖层必须幂等**：minimal preset 的 shell 跨调用保留环境，无条件 prepend 会让 `PATH` 每次多一份目录。
- **测试不得依赖网络或真实 `rtk`**；用 `test/helpers.mjs` 的 fake rtk 脚本、生成的 tar、fake fetch、fake browser/module-loader sandbox 和 fake Cordis Context。

## 扩展指引

- 新 stock preset 的 bash 形状：在 `PRESET_SHELLS`（`lib/shell.js`）登记，并在 `test/shell.test.mjs` 加用例；未登记 preset 保持现有行为。
- 新插件选项：只在 `OPTIONS`（`lib/config.js`）加一行，schema、归一化和测试随之而来。
- 新 rewrite 退出码：扩展 `interpretRewrite` 与 `test/rewrite.test.mjs`，`rewriteCommand` 保持薄包装。
- 新状态字段：加到 `buildStatusPayload`（`lib/status.js`）和 `lib/client.js` 的渲染中。

## 参考文档

- `docs/ARCHITECTURE.md` — 当前模块地图、依赖规则、数据流，是架构的权威说明。
- `docs/COMMIT_REVIEW.md` — 18 个提交的补丁链考古与收敛动机，解释“为什么模块这样切”。
- `HANDOFF.md` — 当前交接状态、运维速查与下一步（中文）。
- `README.md` / `README_zh.md` — 用户文档：配置项、二进制生命周期、行为与限制。
