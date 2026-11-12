# Handoff：DSH RTK 过滤插件

> 交接时间：2026-11-12
> 仓库：`/home/plana/Repos/dsh-rtk-filter`
> 目标宿主：DeepSeek Harness（DSH）`web` profile
> 当前分支：`refactor/consolidate-patches`

## 1. 当前状态

- 功能已完成并在真实会话中验证：同名 `bash` 影子、`rtk rewrite` 协议、
  托管二进制安装/更新、Settings 状态页均已上线。
- 安装方式：Plugin Manager 的 `install_bundle`，指向本仓库目录。profile
  `/home/plana/.dsh/profiles/web` 以 `link:/home/plana/Repos/dsh-rtk-filter`
  引用本仓库，bundle 列表包含 `@rtk-ai/dsh-rtk-filter`。
- RTK 二进制由插件托管在 `$DSH_HOME/cache/rtk-filter`；本机当前为 `v1.2.0`，
  不再需要全局安装。系统 `PATH` 上的 `rtk` 只作为下载期间的临时回退。
- 上游 RTK 仓库 `/home/plana/Repos/rtk` 保持冻结（HEAD `08a261a0`），
  **不要再改动**。
- 测试：`npm test` → **298/298** 通过；`npm run coverage` → 行/分支/函数 100%（`index.js` 与 `lib/`；`lib/client.js` 由 VM 沙箱评估，不在插桩集合内）（2026-11-12）。
- 远程与历史：`origin` = https://github.com/okamitimo233/dsh-rtk-filter；`main` 与
  `origin/main` 同步，重构经 PR #1 合并并保留分层提交，已公开历史不再 squash。
- CI：`.github/workflows/ci.yml` 在 push/PR 上跑单测与覆盖率阈值；
  `.github/workflows/install-smoke.yml` 手动触发真实安装冒烟。
- 从 checkout 链接安装时没有 Config schema，但 row 的原始 `config` 仍会传到
  `apply`；详见 README。

## 2. 已完成

- 同名 `bash` 影子与改写协议（`lib/shadow.js`、`lib/rewrite.js`）。
- 托管 RTK 生命周期：下载、SHA-256 校验、防御性 tar、冒烟、原子发布、
  更新与 GC（`lib/sidecar.js` 等）。
- preset shell 形状守卫、persistent-shell 提示、幂等 PATH 覆盖层
  （`lib/shell.js`）。
- Settings → RTK 命令过滤：状态仪表盘与占位设置页
  （`lib/status.js`、`lib/client.js`）。
- 模块化重构：默认值、shell 模型、缓存状态、纯协议函数各自收敛。模块边界见
  `docs/ARCHITECTURE.md`，补丁链分析见 `docs/COMMIT_REVIEW.md`。

## 3. 已知限制 / 未验证

已知限制：

- 仅支持 POSIX `bash`；Windows `pwsh` 不支持，托管下载仅覆盖
  Linux/macOS x64/arm64。
- 审批、session log、`tools.restrict`、首次下载等用户可见限制见
  README「Limitations」。

待完成的验证（2026-11-12 合并后尚未执行）：

- [x] 用临时 `$DSH_HOME` 跑完整安装冒烟（`npm run smoke`）：解析 latest tag、
      下载、SHA-256、tar 解压、`--version`、rewrite、`rtk gain`、state 写入
      ——2026-11-12 通过（RTK v1.2.0，sha256 `70fee7b4…`）。
- [ ] Host 重新加载链接目录后，在 live 会话确认：仍只有一个 `bash`、schema 未变、
      `git status` 输出被 RTK 压缩、后台 job 正常。
- [ ] live deny（exit 2）：构造真实 deny 规则，确认命令不执行且错误文本可见。
- [ ] Settings 状态页人工视觉验证：7/30 天柱状图、空态、错误态；此前仅在 VM
      中验证 slot/字典注册，并用真实 `rtk gain` 验证过数据聚合。
- [ ] 显式/PATH 来源的版本显示：用 `RTK_BIN` 或非默认 `binary` 指向系统 `rtk`，
      确认状态页显示版本号而不是「版本未知」。
- [ ] 生成的 Config schema：链接安装没有 schema；需发布 npm 包或复制进 profile 后，
      确认 `edition` 只接受 `rtk` / `rtk-oss`。

## 4. 下一步

- 若发布为 npm 包并复制进 profile，验证 Config schema 是否恢复可用。
- 可选：Windows/pwsh 支持、安装失败退避、通过 `ctx.shellEnv` 暴露 `$DSH_RTK_BIN`。

## 5. 运维速查

```
# 安装 / 重装
plugin_manager action=install_bundle target=/home/plana/Repos/dsh-rtk-filter

# 卸载
plugin_manager action=remove_bundle target=@rtk-ai/dsh-rtk-filter

# 启停（entry id：include:rtk-filter）
plugin_manager action=set_plugin target=include:rtk-filter enabled=false
plugin_manager action=set_plugin target=include:rtk-filter enabled=true

# 测试
node --test test/*.test.mjs

# 清理托管二进制（下次激活重新下载）
rm -rf "$HOME/.dsh/cache/rtk-filter"
```

- 本仓库的代码变更需要 Host 重新加载后才在 live 会话生效。
- `RTK_BIN` 是 Host 进程环境变量，修改后需重启 Host；profile 行里的 `binary` 不需要。
- 避免在某个 step 进行中启停插件：该 step 已解析的 tool set 可能短暂出现
  `unknown tool "bash"`，下一步会恢复。
- 安装/失败日志以 `[rtk]` 开头；若 `dsh-web.log` 看不到 `ctx.logger.info`，
  可临时加文件日志排查，提交前删除。

## 6. 参考

- 上游 RTK：https://github.com/rtk-ai/rtk
- CI 与安装冒烟：`.github/workflows/ci.yml`、`.github/workflows/install-smoke.yml`
- 本仓库架构：`docs/ARCHITECTURE.md`（模块边界、依赖规则、约束与坑）
- 提交审查与补丁链：`docs/COMMIT_REVIEW.md`
- 用户文档：`README.md` / `README_zh.md`
- 插件行 id：`rtk-filter`；Loader entry：`include:rtk-filter`
