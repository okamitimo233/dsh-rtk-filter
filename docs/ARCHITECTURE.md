# Architecture

This plugin changes no tool and no schema. Per agent, it shadows the `bash`
tool, asks the upstream `rtk` binary whether a command has a rewrite, and then
delegates the rewritten command to the real `bash`. Sandboxing, approvals,
background jobs, timeouts, output spill, and rendering stay the built-in
implementation's job.

The commit history behind this design is in [COMMIT_REVIEW.md](COMMIT_REVIEW.md).
This file describes the current module boundaries and the rules that keep them
that way.

## Why a shadow tool

The other extension points cannot rewrite a command without changing its
semantics:

- `tools/pre-execute` can only return allow/deny/ask/cancel; it cannot change
  the arguments the model supplied.
- Re-dispatching through `tools/execute` would run pre-execute and approval a
  second time and bypass `bodyInvoked` and signal fusion.
- An agent-scoped registration with the same name shadows the inherited tool,
  and its `execute` can delegate to the captured implementation, so the shell,
  sandbox, approvals, jobs, timeouts, rendering, and exit markers remain the
  built-in ones.

## Module map

| Layer | Module | Responsibility |
|---|---|---|
| Entry | `index.js` | `name`/`inject`/`Config`/`apply`; wires the runtime dependencies. |
| Entry | `lib/config.js` | Option defaults, normalization, and the schemastery descriptor. The only place a default literal lives. |
| Orchestration | `lib/activate.js` | Activation lifecycle: manager creation, lazy shadow registration and re-capture, prompt timing, status route, cleanup. |
| Shell model | `lib/shell.js` | Derives a shell profile from the captured bash definition; preset policy; idempotent PATH overlay; awareness text composition. |
| Shell model | `lib/awareness.js` | Prompt text as plain data. |
| Filter | `lib/shadow.js` | The same-named `bash` definition: getter mirroring and delegation. |
| Filter | `lib/rewrite.js` | `probeRtk`, the pure `interpretRewrite` exit-code protocol, and `rewriteCommand`. |
| Filter | `lib/proc.js` | Child-process execution, the abort-error contract, error text. The only place they are defined. |
| Installer | `lib/sidecar.js` | Composition layer: source resolution (explicit > managed > PATH), installer, update scheduling. |
| Installer | `lib/store.js` | Cache layout, state schema, version listing, GC, latest-tag cache, cross-process lock. Network-free. |
| Installer | `lib/fsx.js` | Atomic JSON write, temp paths, quiet removal, root containment, executable checks. |
| Installer | `lib/release.js` | Platform target, asset/URL naming, checksums, latest tag, archive download. |
| Installer | `lib/tar.js` | Defensive tar.gz parsing (only the wanted files). |
| Installer | `lib/version.js` | Version parse/compare, minimum gate, tag normalization. |
| Settings | `lib/status.js` | `rtk gain` folding, pure payload builder, thin same-origin JSON route. |
| Settings | `lib/client.js` | Hand-written browser bundle: registers the settings section and zh/en dictionaries. |

## Dependency rules

1. **Leaves import nothing from `lib/`.** `proc.js`, `version.js`, and
   `awareness.js` are leaves. `fsx.js` depends only on Node built-ins;
   `tar.js` depends only on Node built-ins plus `proc.js` for error text.
2. **`activate.js` does no process or file IO.** It composes `sidecar.js`,
   `shell.js`, `shadow.js`, and `status.js`; the manager owns everything that
   touches the network or the cache.
3. **No static `@deepseek-ai/*` import.** A bundle linked from a checkout cannot
   resolve shipped packages, so `index.js` imports schemastery dynamically and
   degrades to raw-config normalization when that fails.
4. **`client.js` keeps its loader contract.** It is evaluated as
   `window.__ModuleLoader__.load({ id, factory })` and cannot use ES imports;
   its dictionary keys, wording, CSS, and DOM/SVG output are user-visible API.
5. **`store.js` never talks to the network.** Only `sidecar.js`/   `release.js` download.

## Data flow

### One bash call

```
model calls bash(command)
  -> agent-scoped shadow (lib/shadow.js)
  -> rewriteCommand(command)          lib/rewrite.js -> rtk rewrite
       exit 0/3  rewritten command
       exit 1    original command
       exit 2    deny (never executes)
       else      fail open: original command
  -> PATH overlay (lib/shell.js) when a managed binary is in use
  -> inherited bash executes the command
```

### Activation

```
apply
  -> normalizeConfig                       lib/config.js
  -> createRtkManager                      lib/sidecar.js
       resolve source: explicit > managed > PATH, else auto-install
  -> register a lazy shadow per agent      lib/activate.js + lib/shadow.js
       capture the agent's own bash, derive its shell profile
       skip registration when the profile contradicts the preset policy
  -> add the awareness section once filtering is actually ready
  -> add the command-only caveat per agent whose shell is the persistent one
```

### Installer

```
resolve latest tag (redirect first, API fallback)   lib/release.js
  -> download checksums + archive, verify SHA-256   lib/release.js
  -> extract the wanted files                       lib/tar.js
  -> stage under tmp/, probe --version + rewrite    lib/sidecar.js
  -> atomic rename into versions/<edition>/<target>/<version>/
  -> write state, collect garbage                   lib/store.js
  -> update the PATH prefix used by the overlay     lib/shell.js
```

## Sources of truth

Keep exactly one definition of each of these; duplicating one is how the patch
chains reviewed in [COMMIT_REVIEW.md](COMMIT_REVIEW.md) started.

| Concept | Owner |
|---|---|
| Option defaults and clamps | `lib/config.js` (`OPTIONS`) |
| Preset shell shape policy | `lib/shell.js` (`PRESET_SHELLS`) |
| PATH overlay command | `lib/shell.js` (`withRtkPath`) |
| Prompt text | `lib/awareness.js`; composition in `lib/shell.js` |
| Abort error contract | `lib/proc.js` (`abortError`/`isAbortError`) |
| Error-to-text rule | `lib/proc.js` (`describeError`) |
| Rewrite exit-code protocol | `lib/rewrite.js` (`interpretRewrite`) |
| Status wire shape | `lib/status.js` (`buildStatusPayload`) |
| Cache layout and state schema | `lib/store.js` |

## Constraints and pitfalls

These rules are not visible in the module boundaries alone; each one comes from
a concrete failure.

- **A linked checkout cannot resolve DSH packages.** Every runtime module uses
  Node built-ins only. `index.js` loads schemastery through an optional dynamic
  import and degrades to raw-config normalization. Do not add a static
  `@deepseek-ai/*` import to "restore" the Config form.
- **Capture the agent's bash before registering the shadow.** In the Web
  surface the built-in tool lives in the agent-preset realm, so unscoped
  `ctx.tools.get('bash')` returns `undefined`; after registration the same
  scoped lookup returns the shadow itself. `lib/activate.js` captures through
  `ctx.tools.get('bash', agent)` first.
- **The live preset is not the creation header.** The Web surface creates a
  session under the registry default and selects the user's preset afterwards,
  so `session.header.agentPreset` records only what the session was born with.
  Use `agentPresets.presetForSession()` and keep the header as a fallback. On
  `agent-preset/selected`, the selection has already recomposed the agent, so
  drop the shadow to let the new bash become visible, then capture it again.
- **Keep the captured definition reconciled.** On `tools/change`, if the
  visible bash is neither the shadow nor the captured base, drop the
  registration and re-capture. This covers a preset that mounts its bash after
  activation and another plugin that replaces it. Once the shadow owns the
  name, no lookup can reveal an upstream replacement; only a preset switch is
  still observable, and it is handled by dropping the capture.
- **Never mirror a bash shape from another plane.** `PRESET_SHELLS` in
  `lib/shell.js` records each stock preset's shape. A captured definition that
  declares fields outside the policy belongs to another composition; skip
  registration instead of changing the model-facing schema and execution
  semantics. The `minimal` preset composes a command-only persistent shell;
  unlisted presets are accepted as-is.
- **The command-only caveat is scoped per agent.** A global prompt section
  cannot mention a parameter only some presets lack. For a command-only mirror,
  `lib/activate.js` registers the composed text under the same section name on
  the agent's own prompt, shadowing the global text.
- **The PATH overlay must stay idempotent.** The persistent shell keeps its
  environment across calls, so prepending the managed directory unconditionally
  grows `PATH` once per call. `withRtkPath` keeps the directory in
  `__rtk_prefix` and adds it only when absent.
- **The managed binary is not on the user's PATH.** It is visible only inside
  delegated bash calls through the overlay; a system `rtk` is never updated.
- **Rewrite with the session working directory and no shell.** `rewriteCommand`
  uses `execFile(binary, ['rewrite', command])`; `cwd` comes from the agent
  session so project-local permission rules resolve normally. Do not set
  `RTK_REWRITE_HOST`; exit 3 is safe because DSH already gated the bash call.
- **Two abort codes, one contract.** Process/install cancellation uses
  `abortError()` (`ABORT_ERR`) from `lib/proc.js`; a cancelled tool call uses
  `abortError('tool call aborted', 'ABORTED')` in `index.js`. Both carry
  `name = 'AbortError'` for Host rendering.
- **Use the global `fetch`, never a custom dispatcher.** The DSH launcher
  installs a proxy dispatcher on the global `fetch`; constructing an
  `undici.Agent` would bypass the user's `HTTPS_PROXY` settings.
- **The session log keeps the model's command.** `tool/call` records the
  original text; only `logRewrites: true` logs the rewritten pair.
- **Scoped registration can remain visible under `tools.restrict`.** A preset
  that denies the global `bash` does not necessarily hide this shadow. The
  stock profile and plan mode do not deny `bash`.
- **Toggling the plugin mid-step can break that step.** The step's already
  resolved tool set may hold the old registration, so `bash` can briefly fail
  as unknown until the next step re-resolves.

## Testing

```bash
node --test test/*.test.mjs
```

Tests use only Node built-ins and fixtures: fake `rtk` shell scripts, generated
tar archives, a fake `fetch`, a fake browser/module-loader sandbox, and a fake
Cordis context. No network or real `rtk` is required.

## Extending

- **New stock preset with a different bash shape**: add an entry to
  `PRESET_SHELLS` in `lib/shell.js` and a case in `test/shell.test.mjs`.
- **New plugin option**: add one row to `OPTIONS` in `lib/config.js`; the
  schema, normalization, and tests follow.
- **New rewrite exit code**: extend `interpretRewrite` and
  `test/rewrite.test.mjs`; `rewriteCommand` stays a thin wrapper.
- **New status field**: add it to `buildStatusPayload` and the client's
  rendering; the route handler stays a sequence.
