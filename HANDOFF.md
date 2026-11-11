# Handoff：DSH RTK 过滤插件

> 交接时间：2026-11-09
> 仓库：`/home/plana/Repos/dsh-rtk-filter`（本仓库）
> 目标宿主：DeepSeek Harness（DSH）`web` profile

## 1. 当前状态

- 插件已实现、已安装（链接到本仓库），并已在真实会话中验证过滤行为。
- 安装方式：DSH Plugin Manager 的 `install_bundle`，指向本仓库目录：
  `/home/plana/Repos/dsh-rtk-filter`
- profile：`/home/plana/.dsh/profiles/web`
  - 依赖：`"@rtk-ai/dsh-rtk-filter": "link:/home/plana/Repos/dsh-rtk-filter"`
  - bundle 列表包含 `@rtk-ai/dsh-rtk-filter`
  - 插件 entry id：`include:rtk-filter`，patch id：`rtk-filter`
- 从本版本（0.50.0）起，`rtk` **不再需要用户全局安装**：插件把上游 release 下载到
  `$DSH_HOME/cache/rtk-filter`，校验后使用，并按日检查更新。
- 本机此前手动安装的 `/home/plana/.local/bin/rtk`（0.49.0）保持不动；首次加载新代码后，
  插件会在后台安装上游最新稳定版（当前 `v1.2.0`）并优先使用托管副本。`PATH` 副本在
  下载期间作为临时回退。
- 原始 RTK 仓库 `/home/plana/Repos/rtk` 保持上游状态（HEAD `08a261a0`），
  **后续不要再改动该仓库**；本仓库只读取它的发布信息，不写入。
- 单元测试：`node --test test/*.test.mjs` → 97/97 通过（含 version、tar、release、
  sidecar、status 与 client bundle 注册测试）。
- Web 设置页已增加 **设置 → RTK 命令过滤**：顶部切换栏分「状态」与「设置」；状态读取
  `rtk gain --daily --format json` 展示近 7/30 天调用、节省 Token、节省比例、平均每次
  节省和每日柱状图；设置页当前为占位。Host 端点为 `GET /rtk-filter/status`。

## 2. 需求与设计决定

用户确认的需求：

1. **不新增工具**：模型看到的工具集和 schema 不变。
2. 自动拦截可重写的 `bash` 命令，实际执行 `rtk ...`，返回 RTK 优化后的结果。
3. 对 agent 侧无感；只额外加了一小段系统提示词，告知 bash 输出可能被 RTK 压缩。
4. **不要求用户手动安装 RTK**；插件自行安装与更新，且不做全局安装。

实现选择：

- 没有走 `tools/pre-execute`：该事件只能返回 allow/deny/ask/cancel，**不能修改参数**。
- 没有走 `tools/execute` 重新派发：会二次触发 pre-execute/审批，并绕开 `bodyInvoked`
  与 signal fusion。
- 采用 **agent 作用域同名 `bash` 影子工具**：注册到 `agent.ctx.tools.register`，
  遮蔽该 agent 继承的 `bash`；影子内部改写后委托回原 `bash` 的 `execute`，因此沙箱、
  审批、后台 job、超时、渲染、退出码全部复用原实现。
- 托管二进制放在 `$DSH_HOME/cache/rtk-filter`（DSH 的 cache 惯例），不写 profile、
  不写包目录、不写 `PATH` 目录。
- 因为改写结果由内置 bash 在自己的 `PATH` 中执行，托管二进制生效时影子给每条委托命令
  加一层 `export PATH='<version-dir>':"$PATH";` 覆盖层。这同时让 `rtk bypass ...`、
  复合命令和模型脚本中的 `rtk` 可用。
- 下载使用 Node 全局 `fetch`；DSH launcher 已为全局 fetch 安装代理 dispatcher，
  因此自动遵循用户的 `HTTPS_PROXY` 等设置。不要自建 `undici.Agent`。

## 3. 架构

```
model calls bash("git status")
  -> agent-scoped bash shadow (this repo)
  -> manager.current() 提供托管/显式/PATH 二进制
  -> rtk rewrite "git status"          (0/3=rewrite, 1=pass, 2=deny)
  -> 有托管/显式二进制时：export PATH='<dir>':"$PATH"; rtk git status
  -> 继承的 bash 执行，RTK 过滤后的输出按正常结果路径返回
```

激活期：

```
apply
  -> normalizeConfig
  -> createRtkManager
       -> 显式 binary / RTK_BIN ？probe 后使用，不下载
       -> 托管 state 有效？使用并安排更新检查
       -> BACK: probe PATH rtk 作为临时回退
       -> 没有可用二进制且 autoInstall ？canWrap=true，后台安装
  -> canWrap 时立即注册惰性影子（rewrite 在读不到二进制时 pass）
  -> manager.start() 后台安装/更新
  -> 有 initial 时立即加 prompt；否则 ready 后加 prompt
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
  受 `awareness` 配置控制；只有真正有二进制可用（initial 或安装 ready）时才添加，
  因此安装失败时不会误导模型。工具列表始终不变。
- **托管来源优先级**：显式 `RTK_BIN`/非默认 `binary` > 托管副本 > `PATH` 回退。
  托管副本一旦就绪优先于 `PATH`，所以不会修改全局安装，更新由插件控制。
- **安装**：latest tag 通过 `/releases/latest` 重定向解析（API 仅回退）→ 下载
  `checksums.txt` + `rtk-<target>.tar.gz` → SHA-256 校验 → 内置 zlib/tar 解析
  （拒绝路径穿越、链接、重复、截断、超大）→ 暂存执行 `--version` 与
  `rtk rewrite` 冒烟（`git status` / `ls`）→ 原子改名到 `versions/<edition>/<target>/<version>/rtk`
  → 原子写 state → GC（保留当前 + 上一版本）。
- **更新**：`autoUpdate` 默认开，`latest.json` 缓存 24 小时；只向更新的稳定版升级，
  固定 `version` 时不查 latest；失败保留当前版本并 1 小时后重试。
- **并发**：每个 `edition/target` 一把 `open(..., 'wx')` 锁，10 分钟视为过期；
  state/latest 用同目录临时文件 + rename 原子写入。
- **执行协议**：`execFile(binary, ['rewrite', command], { cwd, timeout, signal })`，无 shell，
  避免注入。
  - exit 0/3 + stdout → 用 stdout 执行；
  - exit 1、超时、ENOENT、未知退出 → fail-open，执行原命令；
  - exit 2 → 不执行，抛 `Error("rtk denied this command: ...")`；
  - 中止 → 抛 `AbortError`；
  - 已以 `rtk` 开头的命令直接委托（但仍加 PATH 覆盖层）；
  - `RTK_DISABLED=1`（Host 环境）跳过插件激活；逐命令 `RTK_DISABLED=1 <cmd>`
    由 `rtk rewrite` 自身跳过；
  - `cwd` 取 session 工作目录，使 `.claude` 权限规则按项目解析。
- **托管根目录**：`ctx.get('profileContext')?.home` → `$DSH_HOME` → `~/.dsh`，再拼
  `cache/rtk-filter`。非 profile 启动时前两者可能缺失，后者兜底。
- 不设置 `RTK_REWRITE_HOST`（与 Pi/OMP、Hermes delegate 一致），因此不需要修改 RTK 的 Rust 代码。

## 4. 文件地图

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：`name`/`inject`/可选 `Config`/`apply`；只在动态 import 成功时提供 schemastery Config；提供 rewrite 冒烟函数 |
| `lib/activate.js` | 激活逻辑：配置归一化、manager 创建、惰性影子注册、prompt 时机、生命周期清理 |
| `lib/shadow.js` | 同名 bash 定义、getter 镜像、PATH 覆盖层、执行委托 |
| `lib/rewrite.js` | `probeRtk` / `rewriteCommand`，解释 `rtk rewrite` 退出码；支持 abort signal |
| `lib/version.js` | 版本解析/比较/最低版本门禁/tag 归一化 |
| `lib/release.js` | 平台 target、资产名、URL、checksums、latest tag、归档下载 |
| `lib/tar.js` | 防御性 tar.gz 解析（只取所需文件） |
| `lib/sidecar.js` | 缓存根/state/锁/安装/更新/GC 与 `createRtkManager` |
| `lib/awareness.js` | 系统提示词文本 |
| `lib/status.js` | Settings 状态端点：把 `rtk gain --daily --format json` 折叠为 7/30 天窗口、运行时健康信息与同源 JSON 响应 |
| `lib/client.js` | 手写浏览器 bundle：注册 `settings.section` 与中英文字典，渲染状态图表和设置占位页 |
| `cordis.patch.yml` | bundle patch：insert `rtk-filter` 行 |
| `package.json` | bundle 清单；`dsh.bundle.patch`、exports、files |
| `locale/{en,zh}.json` | Plugin Manager 标题/描述 |
| `icon.svg` | 原创图标 |
| `test/*.test.mjs` | 纯 Node 单元测试（fake rtk / tar fixture / fake fetch / fake Context） |
| `README.md` / `README_zh.md` | 使用说明、二进制生命周期、行为、限制（英文 / 中文） |

## 5. 配置

行配置（可写在 profile 的 `cordis.patch.yml` 或 bundle 行）：

```yaml
- id: rtk-filter
  name: '@rtk-ai/dsh-rtk-filter'
  config:
    enabled: true
    awareness: true
    binary: rtk
    autoInstall: true
    autoUpdate: true
    version: latest
    edition: rtk
    updateIntervalMs: 86400000
    downloadTimeoutMs: 120000
    rewriteTimeoutMs: 2000
    logRewrites: false
```

- `binary`：默认 `rtk`。设为非默认值（或设置 Host 环境 `RTK_BIN`）会禁用托管安装/更新；
  应为绝对路径或名为 `rtk` 的裸命令。
- `autoInstall`：没有托管副本时是否下载。
- `autoUpdate`：是否更新托管副本；`PATH`/显式二进制永不更新。
- `version`：`latest` 或固定 tag（`1.2.0`/`v1.2.0`）。
- `edition`：`rtk`（默认）或仅 Apache-2.0 的 `rtk-oss`。
- `updateIntervalMs`：latest tag 检查间隔，最小 60000。
- `downloadTimeoutMs`：单次网络请求超时。
- `rewriteTimeoutMs`：单次 `rtk rewrite` 超时，超时 fail-open。
- `logRewrites`：通过 `ctx.logger.info` 记录 `[rtk] <original> -> <rewritten>`。
- 从 checkout 链接安装时**没有 Config JSON schema**（见第 7 节），但 row 的原始 `config`
  仍会传入，`lib/activate.js` 应用同样的默认值。

## 6. 验证记录

已实际执行并通过：

- `node --test test/*.test.mjs` → 87/87 通过。
  - rewrite 退出码/超时/ENOENT/abort；
  - shadow 镜像、委托、PATH 覆盖层、引号转义；
  - activate 的 prompt 时机、后台 ready、失败惰性、生命周期；
  - version 解析/比较/门禁；
  - tar 的安全拒绝与 PAX 跳过；
  - release 的 target/资产/checksum/latest 回退；
  - sidecar 的安装、PATH 回退、托管优先、更新/GC、pin、显式二进制、autoInstall、
    checksum/归档/版本不匹配、锁竞争、abort、平台不支持。
- 在临时 `$DSH_HOME` 中用真实网络跑通完整安装：
  - latest tag 解析为 `v1.2.0`；
  - 下载、checksum、tar 解压、`--version`、rewrite 冒烟均通过；
  - `current().binary` 为
    `<tmp>/cache/rtk-filter/versions/rtk/x86_64-unknown-linux-musl/1.2.0/rtk`；
  - 该二进制 `--version` 输出 `rtk 1.2.0`，`rtk rewrite` 冒烟（`git status` / `ls`）返回改写；
  - 版本目录含 `LICENSE`、`LICENSE-ENGINE`，state/latest 正常写入；
  - 用 `export PATH='<version-dir>':"$PATH"; rtk --version` 验证覆盖层可执行托管二进制。
- 未做/无法做：
  - 由于当前会话审批策略禁用审批，未调用 `plugin_manager` 重新安装/切换插件；
    链接目录中的代码变更需要 Host 重新加载后才在 live 会话生效。
  - 浏览器页面级视觉验证（无浏览器控制通道）；已用 VM 加载 bundle 验证 slot/字典注册，
    并用真实 RTK 1.2.0 验证 `rtk gain --daily --format json` 聚合。
  - live deny（exit 2）仍未构造真实 Claude deny 规则，仅单测覆盖。

## 7. 关键坑与注意事项

1. **链接安装的 bundle 不能静态 import `@deepseek-ai/*`**
   - 原因：bundle 的代码路径在 `/home/plana/Repos/...`，Node 从该路径向上找不到 DSH 安装的
     `node_modules`；DSH 的 runtime resolver 覆盖不到这种外部链接。
   - 处理：所有运行时文件只用 Node built-ins；`Config` 的 schemastery 通过顶层 `await import()`
     可选加载，失败时 `Config = undefined`。新增模块同样只使用 Node 内置模块。
   - 不要为了“补回 schema”而加回静态 `@deepseek-ai/schemastery` import。

2. **Web surface 的 bash 在 agent preset realm**
   - `dsh-web-app` 禁用了 host 平面的 `tool-bash`，改由每个 session 的 preset 组合。
   - 所以必须通过 `ctx.tools.get('bash', agent)` 捕获，不能用 unscoped `get`。

3. **托管二进制不在全局 PATH 上**
   - 内置 bash 用 shell 的 `PATH` 执行改写后的 `rtk ...`，因此影子为每条委托命令前置
     `export PATH='<version-dir>':"$PATH";`。
   - 该覆盖层只存在于插件委托的 bash 调用中；用户终端、其他进程和脚本之外的场景看不到
     托管 `rtk`。这是“不做全局安装”的必然结果。
   - 显式 `binary` 必须是绝对路径或名为 `rtk`；其他名字会导致改写命令中的 `rtk` 解析不到。

4. **首次激活会下载**
   - 即使 `PATH` 上已有旧版 `rtk`，默认 `autoInstall: true` 仍会安装托管副本并优先使用；
     `PATH` 版本只作为下载期间的临时回退。
   - 网络被阻断时：有 `PATH` 就用 `PATH`；没有就保持惰性并告警。下次激活会重试安装。
   - `RTK_DISABLED=1` 时直接跳过激活，不下载。

5. **更新是版本化原子替换**
   - 运行中的命令使用旧的版本目录；新命令使用 state 指向的新目录。
   - GC 只保留当前 + 上一版本；长时间后台命令跨两次更新时理论上可能失去旧目录，
     但 POSIX 下正在执行的 inode 仍然有效。

6. **下载/校验/冒烟失败不会破坏现有安装**
   - checksum 不匹配、归档缺 `rtk`、版本不匹配、rewrite 冒烟失败都会删除暂存并保留
     state；日志以 `[rtk] ...` 开头。
   - 锁文件过期时间 10 分钟；另一个进程安装中时最多等 30 秒，然后重新读 state。

7. **全局 fetch 已经代理**
   - DSH launcher 根据 `HTTP_PROXY`/`HTTPS_PROXY` 等为全局 fetch 安装 dispatcher；
     插件直接使用 `fetch`，不要自建 `undici.Agent`，否则会绕过代理。

8. **中途安装/卸载会短暂打断当前 step 的 bash**
   - 插件在某个 step 进行中被启用/禁用时，该 step 已解析的 tool set 里可能仍记录着旧注册；
     此 step 内调用 `bash` 可能得到 `unknown tool "bash"`。下一个 step 会重新解析并恢复。
   - 自动化操作时避免在 step 中途切换插件。
   - 后台安装完成不会重新注册影子（影子在激活时已注册），所以不会在 step 中途引发这个问题；
     只是 prompt 在 ready 后添加，下一次 prompt 组装生效。

9. **scope-local 注册不受 `tools.restrict` 约束**
   - 如果某个 preset/subagent 用 `deny: ['bash']` 隐藏全局 bash，影子仍可能可见。
   - 当前 stock profile 和 plan mode 都不 deny bash；已写入 README 限制。

10. **捕获的继承定义会在 tools/change 时重新核对**
    - `installed` 存 `{ definition, base, dispose }`；`tools/change` 时若可见 bash 既不是
      影子、也不是已捕获的 base，就释放旧注册并按新 base 重装（覆盖 preset 晚挂载与上游换定义）。
    - 影子一旦占住 `bash` 名字，`ctx.tools.get` 只会返回影子自己，所以“上游换了定义”在
      `tools/change` 里看不出来。能看见的只有“影子捕获时所属的 preset 与当前 preset 不一致”，
      这条线索由 preset 切换事件负责（见第 14 条）。

11. **session log 记录的是模型原始命令**
    - 实际执行的是改写后的 `rtk ...`（以及 PATH 覆盖层）；只有 `logRewrites: true` 时才在
      Host log 留下改写对。这是透明改写的固有取舍，已写入 README。

12. **`ctx.logger.info` 在当前 Host 的 `dsh-web.log` 中不一定可见**
    - 若需要排查“安装是否发生/影子是否安装/改写是否发生”，可临时加文件日志，但记得删除。
    - 安装相关日志：`[rtk] installing RTK ...`、`[rtk] RTK ... installed at ...`、
      `[rtk] RTK updated to ...`，失败为 `warn`。

13. **`RTK_BIN` 是 Host 进程环境变量**
    - 修改它需要重启 DSH Host 才生效；普通 profile 配置中的 `binary` 不需要。
    - 设置 `RTK_BIN` 或非默认 `binary` 会禁用托管安装/更新。

14. **preset 形状守卫：宁可不过滤，也不换语义**
    - 极简模式（`minimal`）的 bash 由 `dsh-tool-bash-persistent` 提供，只有一个参数
      `command`；标准 bash 声明 `description`/`workdir`/`timeoutMs` 等。
    - `EXPECTED_SHELL` 表里登记了 `minimal: { required: ['command'], properties:
      ['command'] }`。捕获到的定义若带表外参数，说明它来自别的平面（host/其它 preset），
      插件不注册、只记一条 info，等下一次 `tools/change` 重新解析。
    - 症状背景：极简会话中出现 `invalid arguments: missing required property
      "description"`，是因为影子曾把标准 bash 的 schema 镜像进极简会话，模型按标准 schema
      被要求填 `description`，漏填即被被委托的 `dsh-tool-bash` 校验拒绝。
    - 新增 stock preset 时先确认其 bash 形状，再决定是否登记；未登记 preset 行为不变。
    - “当前 preset”以 `agentPresets.presetForSession(session)` 投影为准，header 只作兜底：
      Web 端先用 registry 默认 preset 建会话，随后才 `select()` 用户选的 preset，所以 header
      永远停在创建时的那个（实测：ops-ptc 建、2 秒后切 minimal 的会话，header 仍是 ops-ptc）。
    - `select()` 先 `recompose()` 再 append `agent-preset/selected`，插件收到事件时新 bash
      已经挂好。此时丢弃旧影子并重新捕获，就能从“钉住上一套 preset 的 schema”变成镜像
      新 preset 自己的 shell；若新可见的定义形状仍不符，就走守卫放行、不过滤。

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

清理托管二进制（下次激活重新下载）：

```bash
rm -rf "$HOME/.dsh/cache/rtk-filter"
```

## 9. 后续可做

- 配置 git remote（GitHub/GitLab）并推送提交；补 CI（`node --test`）。
- 若发布为 npm 包并复制进 profile，验证 Config schema 是否恢复可用。
- 在 `tools/change` 时刷新捕获的继承定义（需处理 unregister/re-register 与事件递归）。
- 支持 Windows 的 `pwsh` 工具（目前仅 POSIX `bash`，托管下载也仅 Linux/macOS）。
- 视需要增加安装重试/退避（当前首次安装失败后依赖下次激活重试）。
- 视需要把托管状态通过 `ctx.shellEnv` 暴露为 `$DSH_RTK_BIN` 等变量。
- 视需要把集成条目补进 RTK 上游文档；**当前要求是不再改动 `/home/plana/Repos/rtk`**，
  如要提交请另开独立流程。

## 10. 参考

- 上游 RTK：https://github.com/rtk-ai/rtk
- 上游安装脚本（本插件不调用，仅参考资产/校验逻辑）：
  https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh
- DSH 插件开发规范见宿主内的 `cordis-plugin-development` skill 及其 references。
- 插件行 id：`rtk-filter`；Loader entry：`include:rtk-filter`。
