# Handoff：DSH RTK 过滤插件

> 交接时间：2026-11-09
> 仓库：`/home/plana/Repos/dsh-rtk-filter`（本仓库）
> 目标宿主：DeepSeek Harness（DSH）`web` profile

## 1. 当前状态

- 插件已实现、已安装、已在真实会话中验证通过。
- 安装方式：DSH Plugin Manager 的 `install_bundle`，指向本仓库目录：
  `/home/plana/Repos/dsh-rtk-filter`
- profile：`/home/plana/.dsh/profiles/web`
  - 依赖：`"@rtk-ai/dsh-rtk-filter": "link:/home/plana/Repos/dsh-rtk-filter"`
  - bundle 列表包含 `@rtk-ai/dsh-rtk-filter`
  - 插件 entry id：`include:rtk-filter`，patch id：`rtk-filter`
- 运行依赖：`rtk` >= 0.23.0，已安装到 `/home/plana/.local/bin/rtk`（0.49.0）。
- 原始 RTK 仓库 `/home/plana/Repos/rtk` 已回滚到上游状态
  （HEAD `08a261a0`），工作树无改动；**后续不要再改动该仓库**。
- 本仓库初始提交 `c2c6edd`；本 handoff 为后续提交。

## 2. 需求与设计决定

用户确认的需求：

1. **不新增工具**：模型看到的工具集和 schema 不变。
2. 自动拦截可重写的 `bash` 命令，实际执行 `rtk ...`，返回 RTK 优化后的结果。
3. 对 agent 侧无感；只额外加了一小段系统提示词，告知 bash 输出可能被 RTK 压缩。

实现选择：

- 没有走 `tools/pre-execute`：该事件只能返回 allow/deny/ask/cancel，**不能修改参数**。
- 没有走 `tools/execute` 重新派发：会二次触发 pre-execute/审批，并绕开 `bodyInvoked` 与 signal fusion。
- 采用 **agent 作用域同名 `bash` 影子工具**：注册到 `agent.ctx.tools.register`，遮蔽该 agent 继承的 `bash`；影子内部改写后委托回原 `bash` 的 `execute`，因此沙箱、审批、后台 job、超时、渲染、退出码全部复用原实现。

## 3. 架构

```
model calls bash("git status")
  -> agent-scoped bash shadow (this repo)
  -> rtk rewrite "git status"          (0/3=rewrite, 1=pass, 2=deny)
  -> inherited bash executes "rtk git status"
  -> RTK-filtered output returns via the normal bash result path
```

关键实现点：

- **继承定义的捕获**：Web surface 的 `bash` 由 agent preset realm 组合，而不是 host 全局平面，
  所以 `ctx.tools.get('bash')`（不传 scope）返回 `undefined`。必须在注册影子**之前**
  用 `ctx.tools.get('bash', agent)` 通过该 agent 的视图捕获，否则注册后同一查询会返回影子自身。
- **schema 镜像**：影子的 `description`/`parameters`/`output`/`timeoutMs`/`presentCall` 等
  用 getter 读取捕获的继承定义，保证与内置 bash 逐字一致。
- **生命周期**：激活时遍历 `ctx.agents.list()`，并监听 `agent/created`、`agent/disposed`、
  `tools/change`；`tools/change` 只用于重试“当时还没有 bash”的 agent，不会重复注册。
- **提示词**：`ctx.systemPrompt.section({ name: 'rtk:command-output', order: TOOL_BASH + 1 })`，
  受 `awareness` 配置控制；不改变工具列表。
- **改写协议**：`execFile(binary, ['rewrite', command], { cwd, timeout, signal })`，无 shell，避免注入。
  - exit 0/3 + stdout → 用 stdout 执行；
  - exit 1、超时、ENOENT、未知退出 → fail-open，执行原命令；
  - exit 2 → 不执行，抛 `Error("rtk denied this command: ...")`；
  - 中止 → 抛 `AbortError`；
  - 已以 `rtk` 开头的命令直接委托；
  - `RTK_DISABLED=1`（Host 环境）整体禁用；逐命令 `RTK_DISABLED=1 <cmd>` 由 `rtk rewrite` 自身跳过；
  - `cwd` 取 session 工作目录，使 `.claude` 权限规则按项目解析。
- 不设置 `RTK_REWRITE_HOST`（与 Pi/OMP、Hermes delegate 一致），因此不需要修改 RTK 的 Rust 代码。

## 4. 文件地图

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：`name`/`inject`/可选 `Config`/`apply`；只在动态 import 成功时提供 schemastery Config |
| `lib/activate.js` | 核心激活逻辑：探测、提示词、per-agent 安装、生命周期清理 |
| `lib/shadow.js` | 构造同名 bash 定义、getter 镜像、执行委托 |
| `lib/rewrite.js` | `probeRtk` / `rewriteCommand`，解释 `rtk rewrite` 退出码 |
| `lib/awareness.js` | 系统提示词文本 |
| `cordis.patch.yml` | bundle patch：insert `rtk-filter` 行 |
| `package.json` | bundle 清单；`dsh.bundle.patch`、exports、files |
| `locale/{en,zh}.json` | Plugin Manager 标题/描述 |
| `icon.svg` | 原创图标 |
| `test/*.test.mjs` | 纯 Node 单元测试（fake rtk / fake Context） |
| `README.md` / `README_zh.md` | 使用说明、行为、限制（英文 / 中文） |

## 5. 配置

行配置（可写在 profile 的 `cordis.patch.yml` 或 bundle 行）：

```yaml
- id: rtk-filter
  name: '@rtk-ai/dsh-rtk-filter'
  config:
    enabled: true
    awareness: true
    binary: rtk
    rewriteTimeoutMs: 2000
    logRewrites: false
```

- `binary`：默认 `rtk`；Host 进程环境里的 `RTK_BIN` 优先。
- `rewriteTimeoutMs`：单次 `rtk rewrite` 超时，超时 fail-open。
- `logRewrites`：通过 `ctx.logger.info` 记录 `[rtk] <original> -> <rewritten>`。
- 从 checkout 链接安装时**没有 Config JSON schema**（见第 7 节），但 row 的原始 `config` 仍会传入。

## 6. 验证记录

已实际执行并通过：

- `node --test test/*.test.mjs` → 28/28 通过（rewrite 退出码/超时/ENOENT/abort；shadow 镜像与委托；activate 的提示词与生命周期）。
- `plugin_manager install_bundle target=/home/plana/Repos/dsh-rtk-filter` → `application: applied`。
- 系统提示词中出现 RTK 说明。
- `git status` 返回 RTK 过滤后的短输出（`* develop...origin/develop …`），而非原始长输出。
- `echo hello`、`echo "$(date +%s)"` 原样通过；`RTK_DISABLED=1 git status` 返回原始输出。
- `run_in_background: true` 的命令正常返回 job id 并完成。
- `rtk gain --history` 出现 `rtk git status` 记录，证明改写后的命令真实执行。
- `Tool.listTools` 仍只有一个 `bash`，description/parameters 与安装前逐字一致。

未做/无法做：

- 浏览器页面级视觉验证（无浏览器控制通道）；locale/icon 已按文件检查。
- live deny（exit 2）未构造真实 Claude deny 规则，仅单测覆盖。

## 7. 关键坑与注意事项

1. **链接安装的 bundle 不能静态 import `@deepseek-ai/*`**
   - 原因：bundle 的代码路径在 `/home/plana/Repos/...`，Node 从该路径向上找不到 DSH 安装的 node_modules；
     DSH 的 runtime resolver 覆盖不到这种外部链接。
   - 处理：所有运行时文件只用 Node built-ins；`Config` 的 schemastery 通过顶层 `await import()`
     可选加载，失败时 `Config = undefined`。如果将来作为 npm 包复制进 profile 安装，它会自动可用。
   - 不要为了“补回 schema”而加回静态 `@deepseek-ai/schemastery` import，否则插件会在链接安装下直接加载失败。

2. **Web surface 的 bash 在 agent preset realm**
   - `dsh-web-app` 禁用了 host 平面的 `tool-bash`，改由每个 session 的 preset 组合。
   - 所以必须通过 `ctx.tools.get('bash', agent)` 捕获，不能用 unscoped `get`。

3. **中途安装/卸载会短暂打断当前 step 的 bash**
   - 插件在某个 step 进行中被启用/禁用时，该 step 已解析的 tool set 里可能仍记录着旧注册；
     此 step 内调用 `bash` 可能得到 `unknown tool "bash"`。下一个 step 会重新解析并恢复。
   - 自动化操作时避免在 step 中途切换插件。

4. **scope-local 注册不受 `tools.restrict` 约束**
   - 如果某个 preset/subagent 用 `deny: ['bash']` 隐藏全局 bash，影子仍可能可见。
   - 当前 stock profile 和 plan mode 都不 deny bash；已写入 README 限制。

5. **捕获的继承定义不会在 preset 重注册后自动刷新**
   - 安装时捕获一次；如果 preset 在会话中重新注册不同 schema 的 bash，需要重新加载插件。
   - stock Web preset 在 agent 启动前组合一次 bash，正常使用不会触发。

6. **session log 记录的是模型原始命令**
   - 实际执行的是改写后的 `rtk ...`；只有 `logRewrites: true` 时才在 Host log 留下改写对。
   - 这是透明改写的固有取舍，已写入 README。

7. **`ctx.logger.info` 在当前 Host 的 `dsh-web.log` 中不一定可见**
   - 本次调试曾临时用 `/tmp` 文件日志定位问题，调试代码已移除。
   - 若以后需要排查“影子是否安装/改写是否发生”，可临时加文件日志，但记得删除。

8. **`RTK_BIN` 是 Host 进程环境变量**
   - 修改它需要重启 DSH Host 才生效；普通 profile 配置中的 `binary` 不需要。
   - prompt 和 rtk 输出里的 `rtk ...` 恢复提示也要求 rtk 在模型的 PATH 上。

## 8. 运维操作

安装 / 重装：

```
plugin_manager action=install_bundle target=/home/plana/Repos/dsh-rtk-filter
```

卸载：

```
plugin_manager action=remove_bundle target=@rtk-ai/dsh-rtk-filter
```

启停（当前已装）：

```
plugin_manager action=set_plugin target=include:rtk-filter enabled=false
plugin_manager action=set_plugin target=include:rtk-filter enabled=true
```

测试：

```bash
cd /home/plana/Repos/dsh-rtk-filter
node --test test/*.test.mjs
```

## 9. 后续可做

- 配置 git remote（GitHub/GitLab）并推送初始提交；补 CI（`node --test`）。
- 若发布为 npm 包并复制进 profile，验证 Config schema 是否恢复可用。
- 在 `tools/change` 时刷新捕获的继承定义（需处理 unregister/re-register 与事件递归）。
- 支持 Windows 的 `pwsh` 工具（目前仅 POSIX `bash`）。
- 视需要把集成条目补进 RTK 上游文档；**当前要求是不再改动 `/home/plana/Repos/rtk`**，
  如要提交请另开独立流程。

## 10. 参考

- 上游 RTK：https://github.com/rtk-ai/rtk
- DSH 插件开发规范见宿主内的 `cordis-plugin-development` skill 及其 references。
- 插件行 id：`rtk-filter`；Loader entry：`include:rtk-filter`。
