# Architecture

This plugin changes no tool and no schema. Per agent, it shadows the `bash`
tool, asks the upstream `rtk` binary whether a command has a rewrite, and then
delegates the rewritten command to the real `bash`. Sandboxing, approvals,
background jobs, timeouts, output spill, and rendering stay the built-in
implementation's job.

Design motivation and the commit history it came from are in
[COMMIT_REVIEW.md](COMMIT_REVIEW.md). This file describes the current module
boundaries and the rules that keep them that way.

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
   `awareness.js` are leaves. `fsx.js` and `tar.js` depend only on Node
   built-ins (plus `proc.js` for error text).
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
