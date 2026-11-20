# Handoff：DSH RTK 过滤插件

> 交接时间：2026-11-20
> 仓库：`/home/plana/Repos/dsh-rtk-filter`
> 目标宿主：DeepSeek Harness（DSH）`web` profile
> 当前分支：`feat/global-rtk-bin`

## 1. 当前状态

- 同名 `bash` 影子、`rtk rewrite` 协议、preset 形状守卫、Settings 状态页均已实现。
- RTK 获取顺序：
  1. Host `PATH` 上的裸 `rtk`；
  2. 官方安装位置 `${RTK_INSTALL_DIR:-$HOME/.local/bin}/rtk`；
  3. 两者都不可用时执行 RTK 官方安装脚本，安装后再 probe 绝对路径。
- 本机已用官方 quick install 把 RTK `1.2.1` 安装到 `~/.local/bin/rtk`。
  `~/.local/bin` 已在 `.bashrc` / `.bash_profile` / `.zshrc` 的 PATH 中。
- Web profile 不再覆盖 `rtk-filter` 的 config，使用插件的默认获取逻辑。
  该配置需要 Host 重新加载/重启后生效；当前正在运行的 Host 仍是改配置前启动的实例。
- 测试：`npm test` → **177/177** 通过；`npm run coverage` → 行/分支/函数 100%。
- 远程与历史：`origin` = https://github.com/okamitimo233/dsh-rtk-filter；
  `main` 与 `origin/main` 同步。当前功能分支已有提交，并已创建 PR #2；
  分支正在按 review 意见修订。

## 2. 已完成

- `lib/manager.js`：一次性按 PATH → 官方安装位置 → 官方安装脚本的顺序
  获取并 probe RTK。
- `lib/installer.js`：下载并执行 RTK 官方 `install.sh`；不实现私有下载、
  缓存、锁、GC 或后台更新。
- 删除旧托管生命周期模块：`lib/sidecar.js`、`store.js`、`fsx.js`、
  `release.js`、`tar.js` 及对应测试；保留精简后的真实安装 smoke。
- `lib/config.js` 只保留 `enabled`、`awareness`、`rewriteTimeoutMs`、
  `logRewrites`。
- 状态页不再有 `managed` / `installing` 状态；来源为 `path` 与 `installed`。
- 原有功能保留：preset shell 形状守卫、persistent-shell 提示、幂等 PATH
  覆盖层（仅官方安装绝对路径）、`rtk gain` 状态仪表盘。

## 3. 已知限制

- 仅支持 POSIX `bash`；Windows `pwsh` 不覆盖。
- 二进制在插件激活时 probe 一次；安装或替换 RTK 后需要重新加载/重启 Host。
- 官方安装位置和 PATH 都不可用时才执行官方安装脚本；下载与执行共用一个
  30 秒总 deadline，离线时最多阻塞激活约 30 秒。
- RTK >= 0.23.0（`rtk rewrite` 的最低版本）。
- 审批、session log、`tools.restrict` 等用户可见限制见 README「Limitations」。

## 4. 下一步

- 处理 PR #2 review：缩短安装总 deadline、统一 `RTK_INSTALL_DIR`、流式限制
  安装脚本大小、补充真实安装 smoke，并清理未使用的 manager 接口。
- 修订推送后检查 CI，并在 PR 中回复 review 取舍。
- 用新配置重启 Web Host，确认 Settings 页 hero 显示 `RTK 1.2.1 · PATH 版本`
  （当前 PATH 已有全局二进制）；并验证缺失 `rtk` 时官方安装器路径。
- 可选：Windows/pwsh 支持、通过 `ctx.shellEnv` 暴露 `$DSH_RTK_BIN` 或安装路径。

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
npm run smoke  # 真实网络安装冒烟，安装到临时目录

# 手动执行同一个官方安装方式（插件自动安装失败时可用）
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
~/.local/bin/rtk --version

# 查看 Web profile 合并后的插件配置
dsh --profile web --dump-config | rg -A5 "rtk-filter"
```

- 本仓库代码变更需要 Host 重新加载后才在 live 会话生效。
- 子进程不继承“当前 bash 修改过的环境变量”。插件只读取 Host 进程自己的
  PATH / RTK_INSTALL_DIR，修改后需重启 Host。
- 避免在某个 step 进行中启停插件：该 step 已解析的 tool set 可能短暂出现
  `unknown tool "bash"`，下一步会恢复。

## 6. 参考

- 上游 RTK：https://github.com/rtk-ai/rtk
- CI：`.github/workflows/ci.yml`；安装冒烟：`.github/workflows/install-smoke.yml`
- 本仓库架构：`docs/ARCHITECTURE.md`
- 提交审查与补丁链：`docs/COMMIT_REVIEW.md`
- 用户文档：`README.md` / `README_zh.md`
- 插件行 id：`rtk-filter`；Loader entry：`include:rtk-filter`
