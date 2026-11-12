# Handoff：DSH RTK 过滤插件

> 交接时间：2026-11-12
> 仓库：`/home/plana/Repos/dsh-rtk-filter`
> 目标宿主：DeepSeek Harness（DSH）`web` profile
> 当前分支：`refactor/consolidate-patches`（领先 `main` 7 个提交，尚未合并）

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
- 测试：`node --test test/*.test.mjs` → 175/175 通过（2026-11-12）。
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

- live deny（exit 2）只有单元测试覆盖，尚未用真实 deny 规则做端到端验证。
- 浏览器页面未做人工视觉验证；只验证了 bundle 在 VM 中注册 slot/字典，
  以及真实 `rtk gain` 数据聚合。
- 仅支持 POSIX `bash`；Windows `pwsh` 不支持，托管下载仅覆盖
  Linux/macOS x64/arm64。
- 审批、session log、`tools.restrict`、首次下载等用户可见限制见
  README「Limitations」。

## 4. 下一步

- 配置 remote 并推送；补 CI（`node --test`）。
- 将 `refactor/consolidate-patches` 合并到 `main`。
- 若发布为 npm 包并复制进 profile，验证 Config schema 是否恢复可用。
- 可选：Windows 支持、安装失败退避、通过 `ctx.shellEnv` 暴露 `$DSH_RTK_BIN`。

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
- 本仓库架构：`docs/ARCHITECTURE.md`（模块边界、依赖规则、约束与坑）
- 提交审查与补丁链：`docs/COMMIT_REVIEW.md`
- 用户文档：`README.md` / `README_zh.md`
- 插件行 id：`rtk-filter`；Loader entry：`include:rtk-filter`
