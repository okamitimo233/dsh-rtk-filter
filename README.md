# RTK for DeepSeek Harness

English | [中文](README_zh.md)

Transparently runs the DeepSeek Harness `bash` tool through [RTK](https://github.com/rtk-ai/rtk)
so condensed command output reaches the model. The plugin adds **no tool** and
changes no tool schema: it registers an agent-scoped `bash` tool that shadows
the built-in one, rewrites each supported command to its `rtk` equivalent, and
then delegates to the original bash implementation.

Because execution delegates back to the built-in tool, sandboxing, approval,
background jobs, timeouts, output rendering, spill files, and `[exit code: N]`
markers behave exactly as before. Only the command that runs and the output the
model reads change.

## How it works

```
model calls bash("git status")
  -> agent-scoped bash shadow
  -> rtk rewrite "git status"        (0/3 = rewrite, 1 = pass, 2 = deny)
  -> built-in bash runs "rtk git status"
  -> RTK-filtered output returns through the normal bash result path
```

- The shadow's `description`, `parameters`, `output`, timeouts, and
  presentation callbacks are getters over the `bash` definition inherited by
  that agent, captured before the shadow is registered. In the Web surface the
  built-in tool is composed by the agent preset rather than the host global
  plane, so the plugin reads it through the agent's own tool view.
- A short system-prompt section explains that bash output may be condensed by
  RTK. Disable it with `awareness: false`; the tool set never changes.
- All rewrite logic lives in the `rtk` binary (`rtk rewrite`). When filters are
  added to RTK, this plugin picks them up with no change.

## Requirements

- `rtk` **>= 0.23.0** (when `rtk rewrite` was introduced) on the `PATH` of the
  DeepSeek Harness Host process, or an absolute path in `binary`.
- POSIX `bash` (the built-in `bash` tool). Windows `pwsh` is not covered.

If the binary is missing or too old, the plugin logs a warning and stays inert:
bash and the prompt are untouched.

## Install

Install this repository as a bundle with the DSH Plugin Manager — use the
`plugin_manager` tool with `action: install_bundle` and the absolute path to
this repository directory as `target`. The bundle patch inserts one row:

```yaml
- insert:
    - id: rtk-filter
      name: '@rtk-ai/dsh-rtk-filter'
```

Remove it with `plugin_manager` `action: remove_bundle`.

## Configuration

Edit the inserted row in the profile's `cordis.patch.yml` (or the bundle row)
and set `config`:

```yaml
- id: rtk-filter
  name: '@rtk-ai/dsh-rtk-filter'
  config:
    binary: /usr/local/bin/rtk   # default: rtk, or $RTK_BIN
    awareness: true              # default: true
    rewriteTimeoutMs: 2000       # default: 2000
    logRewrites: false           # default: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the plugin off without removing it. |
| `awareness` | `true` | Add the short system-prompt section about condensed output. |
| `binary` | `rtk` | rtk executable used for `rtk rewrite`; `RTK_BIN` in the Host environment takes priority. |
| `rewriteTimeoutMs` | `2000` | Timeout for one `rtk rewrite` call; on timeout the original command runs. |
| `logRewrites` | `false` | Log `[rtk] <original> -> <rewritten>` to the Host log. |

A bundle linked from a checkout cannot resolve DSH's shipped Node packages, so
the generated Config schema is absent there (the row status is `absent` in the
Config inspector). The fields above still work: the row's raw `config` reaches
the plugin and the same defaults apply.

## Behavior

`rtk rewrite` exits with a permission decision; the plugin interprets it the
same way the Pi/OMP and Hermes delegates do, without setting
`RTK_REWRITE_HOST`:

| Exit | Plugin action |
|---|---|
| `0` + stdout | Run the rewritten command. |
| `1` | Run the original command (no filter, or a construct RTK does not rewrite). |
| `2` | Do **not** run; the tool call fails with `rtk denied this command: <message>`. |
| `3` + stdout | Run the rewritten command. DSH owns approval for the bash call, so there is no second prompt. |
| timeout / spawn error / unknown | Fail open: run the original command. |

Additional rules:

- Commands that already start with `rtk` are not rewritten (no recursion).
- `RTK_DISABLED=1` in the Host environment disables rewriting entirely.
  A per-command `RTK_DISABLED=1 <cmd>` prefix is skipped by `rtk rewrite`
  itself and runs unchanged.
- `rtk rewrite` runs with the session's working directory, so project-local
  permission rules resolve the way they do for a normal command.

## What the agent sees

- The same one `bash` tool, with the same name, description, and parameters.
- RTK-filtered output for commands RTK supports; unchanged output otherwise.
- A short prompt note that bash output may be condensed and how to recover it
  (`rtk bypass <cmd>`), unless `awareness: false`.

## Limitations

- **Session log**: the durable `tool/call` records the command the model wrote,
  not the rewritten one. The rewrite is visible in the Host log only with
  `logRewrites: true`.
- **Approval**: DSH has no per-command prompt, so an `ask` rule in Claude Code
  settings (exit 3) does not prompt here; `deny` rules still block. The command
  runs under the approval the `bash` tool call already received.
- **Tool restrictions**: DSH lets scoped registrations remain visible under
  `tools.restrict`, so a preset that denies the global `bash` tool for an agent
  does not hide this shadow. The stock profile and plan mode do not deny
  `bash`.
- **Platform**: POSIX `bash` only; the Windows `pwsh` tool is not filtered.
- **Inherited definition**: the plugin captures the agent's `bash` definition
  when it installs for that agent. A preset that re-registers `bash` with a
  different schema during a live session is not re-mirrored until the plugin
  reloads (the stock Web preset composes `bash` once, before the agent starts).
- **Recovery hints**: the prompt and RTK output may reference `rtk ...`
  commands, which require `rtk` on the model's `PATH` to work.

## Development

Unit tests use only Node built-ins and a fake `rtk` script:

```bash
node --test test/*.test.mjs
```

## Handoff

See [HANDOFF.md](HANDOFF.md) for the implementation history, operational notes, verification record, and known pitfalls.
