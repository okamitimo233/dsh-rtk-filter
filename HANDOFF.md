# Handoff：DSH RTK 过滤插件

> 交接时间：2026-11-20
> 仓库：`/home/plana/Repos/dsh-rtk-filter`
> 目标宿主：DeepSeek Harness（DSH）`web` profile
> 当前分支：`feat/global-rtk-bin`

## 1. 当前状态

- 同名 `bash` 影子、`rtk rewrite` 协议、preset 形状守卫、Settings 状态页均已实现。
- RTK 解析顺序：
  1. Host 环境中的 `RTK_BIN`，或非默认的 `binary` 配置；
  2. Host `PATH` 上的裸 `rtk`；
  3. 两者都不可用且 `autoInstall` 开启时，执行 RTK 官方安装脚本，
     安装到 `${RTK_INSTALL_DIR:-$HOME/.local/bin}/rtk`。
  显式二进制 probe 失败时不会回退到 PATH 或安装器。
- 本机已用官方 quick install 把 RTK `1.2.1` 安装到 `~/.local/bin/rtk`。
  `~/.local/bin` 已在 `.bashrc` / `.bash_profile` / `.zshrc` 的 PATH 中。
- Web profile 的 `cordis.patch.yml` 已配置：
  ```yaml
  - id: rtk-filter
    name: "@rtk-ai/dsh-rtk-filter"
    config:
      autoInstall: true
  ```
  该配置需要 Host 重新加载/重启后生效；当前正在运行的 Host 仍是改配置前启动的实例。
- 测试：`npm test` → **179/179** 通过；`npm run coverage` → 行/分支/函数 100%。
- 远程与历史：`origin` = https://github.com/okamitimo233/dsh-rtk-filter；
  `main` 与 `origin/main` 同步。当前功能分支尚未提交。

## 2. 已完成

- `lib/manager.js`：一次性解析并 probe 外部 RTK；支持 `RTK_BIN`、
  非默认 `binary`、PATH，以及无可用二进制时委托官方安装。
- `lib/installer.js`：下载并执行 RTK 官方 `install.sh`；不实现私有下载、
  缓存、锁、GC 或后台更新。
- 删除旧托管生命周期模块：`lib/sidecar.js`、`store.js`、`fsx.js`、
  `release.js`、`tar.js` 及对应测试和安装冒烟流程。
- `lib/config.js` 保留 `enabled`、`awareness`、`binary`、`autoInstall`、
  `rewriteTimeoutMs`、`logRewrites`。
- 状态页不再有 `managed` / `installing` 状态；来源为 `explicit`、`path`、`installed`。
- 原有功能保留：preset shell 形状守卫、persistent-shell 提示、幂等 PATH
  覆盖层（仅绝对路径显式二进制）、`rtk gain` 状态仪表盘。

## 3. 已知限制

- 仅支持 POSIX `bash`；Windows `pwsh` 不覆盖。
- 二进制在插件激活时 probe 一次；安装或替换 RTK 后需要重新加载/重启 Host。
- 显式二进制不可用时插件保持惰性，不会自动选择 PATH 上的另一个 `rtk`，
  也不会触发官方安装器。
- 自动安装会执行上游 `install.sh`；不允许该行为的部署应设置 `autoInstall: false`。
- RTK >= 0.23.0（`rtk rewrite` 的最低版本）。
- 审批、session log、`tools.restrict` 等用户可见限制见 README「Limitations」。

## 4. 下一步

- 在分支上检查、提交并评审本次“移除托管二进制”重构。
- 用新配置重启 Web Host，确认 Settings 页 hero 显示 `RTK 1.2.1 · PATH 版本`
  （当前 PATH 已有全局二进制）；并验证缺失 `rtk` 时官方安装器路径。
- 可选：Windows/pwsh 支持、通过 `ctx.shellEnv` 暴露 `$DSH_RTK_BIN`。

## 5. 运维速查

```bash
# 安装 / 重装
plugin_manager action=install_bundle target=/home/plana/Repos/dsh-rtk-filter

# 卸载
plugin_manager action=remove_bundle target=@rtk-ai/dsh-rtk-filter

# 启停（entry id：include:rtk-filter）
plugin_manager action=set_plugin target=include:rtk-filter enabled=false
plugin_manager action=set_plugin target=include:rtk-filter enabled=true

# 测试
node --test test/*.test.mjs

# 手动执行同一个官方安装方式（插件 autoInstall 失败时可用）
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
~/.local/bin/rtk --version

# 查看 Web profile 合并后的插件配置
dsh --profile web --dump-config | rg -A5 "rtk-filter"
```

- 本仓库代码变更需要 Host 重新加载后才在 live 会话生效。
- 子进程不继承“当前 bash 修改过的环境变量”。若要让 Host 使用 `RTK_BIN`，
  必须在启动 Host 的父进程环境中设置，然后重启 Host。
- 避免在某个 step 进行中启停插件：该 step 已解析的 tool set 可能短暂出现
  `unknown tool "bash"`，下一步会恢复。

## 6. 参考

- 上游 RTK：https://github.com/rtk-ai/rtk
- CI：`.github/workflows/ci.yml`
- 本仓库架构：`docs/ARCHITECTURE.md`
- 提交审查与补丁链：`docs/COMMIT_REVIEW.md`
- 用户文档：`README.md` / `README_zh.md`
- 插件行 id：`rtk-filter`；Loader entry：`include:rtk-filter`
