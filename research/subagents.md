# Subagent tool-surface failure — incident & architecture report

## 1. Incident summary

Spawned subagents (workers, researchers, scouts) in this harness received only the
`write`, `ask_question`, `subagent`, `subagent_message`, and `subagents_list` tools —
none of the native tools (`piread`, `piedit`, `pibash`, `pidx`) that their agent
definitions actually grant. Agent definitions such as `agents/worker.md` list
`tools: write, piread, piedit, pibash` in frontmatter, so children were expected to
receive the native tools but did not. Four worker stand-downs are on record
(readme-implement, daemon-implement, pibash-fix, probe-worker/probe2).

The failures are load-order dependent and silent: the subagents extension
(`extensions/subagents/index.ts`) registers the tool-extension path registry at
module load, but every native extension loads before subagents and its registration
call was a no-op when the registry did not yet exist. Fix applied here hardcodes the
first-party native paths into the resolution map, making it load-order independent.

## 2. Timeline of evidence

Evidence across the session:

- Four worker stand-downs recorded: `readme-implement`, `daemon-implement`,
  `pibash-fix`, and `probe-worker`/`probe2`.
- Session JSONL tool-name histograms for children show only `write`, `ask_question`,
  `ls`, and `subagent*` calls — no native tool invocations. `ls` differs from
  `pibash`; the shell-based `ls` is a permitted capability that does not correspond
  to any native `-e`-backed extension path.
- `probe2` post-fix, run from this still-running orchestrator session, reported
  still TOOLLESS — expected, because the running session holds the pre-fix extension
  in memory and the fix only activates on restart.

## 3. Root-cause chain

The subagents extension spawns children default-deny:

1. `extensions/subagents/index.ts:844-900` — `applySandboxToParts` builds the child's
   launch with `--no-extensions` plus a `--tools <allowlist>` and one `-e <path>` per
   tool-backing extension.
2. `extensions/subagents/index.ts:886` — `getToolExtensionPath(tool)` resolves the
   `-e` path for a given allowlisted tool.
3. For native tools, `-e` paths resolve ONLY via the `EXTRA_TOOL_EXTENSIONS` runtime
   registry, populated by `registerToolExtension()`
   (`extensions/subagents/index.ts:192-213`).
4. Native extensions call it as `registry?.registerToolExtension?.(name, path)` with
   optional chaining — `extensions/piread/index.ts:98` and
   `extensions/piedit/index.ts:73`.
5. That registry global is `__pi_interactive_subagents`, set at subagents
   module load (`extensions/subagents/index.ts:212`). Because it does not exist yet
   when native extensions load, the optional-chaining call silently no-ops.
6. Extensions load alphabetically: `compact-editor`, `handoff`, `permission-gate`,
   `piedit`, `pibash`, `pidx`, `piread`, `self-heal`, `subagents`, … — so every
   native extension loads BEFORE `subagents`, and every registration is silently
   dropped.

Result: children get zero native `-e` flags.

Additional gap: `pibash` and `pidx` never call `registerToolExtension` at all.
`rg` over `extensions/{pibash,pidx}/index.ts` finds no hits; only `piread:98` and
`piedit:73` do.

## 4. Why it was silent, and why tests missed it

- **Silent**: optional chaining (`?.`) on `registerToolExtension` means "if the
  registry isn't there, do nothing." When the registry global is unset, the call is
  a legal no-op — no error, no warning.
- **Load order**: the registry is only created at subagents module load, which
  happens after every native extension has already attempted registration. The
  chronological order guarantees the no-op path.
- **Tests missed it**: unit/regression tests exercised `getToolExtensionPath`
  directly, and possibly after `registerToolExtension` had been called (or with the
  registry pre-populated), so path resolution passed even though at a real spawn the
  registry was empty. There was no integration test that spawned a real child and
  asserted its resolved `-e` tool set.

## 5. Fix and test

- **Fix** (`extensions/subagents/index.ts:232-240`): hardcoded the four first-party
  paths into `getToolExtensionPath`'s built-in map, alongside the existing
  `web_search` / `web_fetch` / `video_extract` / `youtube_search` /
  `google_image_search` / `safe_bash` precedent. This is load-order independent:
  resolution no longer depends on the runtime registry for these tools.
- **Regression test** (`tests/subagents/test.ts`): `"resolves tool-extension paths
  for the four native tools (load-order safe)"` via `__test__.getToolExtensionPath`.
  Suite result: 156/156 pass.
- **Activation requirement**: the running orchestrator session still holds the
  pre-fix extension in memory; the fix activates only on session restart. `probe2`
  post-fix from this session confirmed this (still TOOLLESS, expected).

## 6. Residual risks

- **`pibash` / `pidx` still never call `registerToolExtension`.** Now harmless for
  the four first-party tools because the paths are in the built-in map, but the
  asymmetry remains: any extension relying on the registry must remember to
  register, or rely on the hardcoded map. Documented here as a maintainability
  footgun.
- **Resume path replays a loadout snapshot**, so old saved sessions that captured a
  toolless loadout will remain toolless on resume even after the fix.
- **`EXTRA_TOOL_EXTENSIONS` overwrite-refusal semantics**: the registry refuses to
  overwrite an already-registered entry. This protects built-in/hardcoded entries
  from accidental clobbering but could also mask a legitimate path change if a stale
  registry entry persists.

## 7. Recommendations

- Register tool extensions on a `session_start` hook (belt-and-suspenders) rather
  than only at module load, so registration order cannot produce a silent no-op.
- Emit a spawn-time warning when an allowlisted tool resolves to no extension path
  (and is not a built-in), instead of silently omitting the `-e`.
- Consider asserting at spawn that every non-builtin allowlisted tool actually got a
  `-e` flag, failing loudly rather than spawning a toolless child.

## Sources

1. `extensions/subagents/index.ts:844-900` — `applySandboxToParts` default-deny spawn
   (`--no-extensions`, `--tools`, `-e` flags).
2. `extensions/subagents/index.ts:886` — `getToolExtensionPath(tool)`.
3. `extensions/subagents/index.ts:192-213` — `EXTRA_TOOL_EXTENSIONS` registry and
   `registerToolExtension()`.
4. `extensions/subagents/index.ts:212` — `__pi_interactive_subagents` global set at
   module load.
5. `extensions/subagents/index.ts:232-240` — hardcoded first-party native path map
   (the fix).
6. `extensions/subagents/index.ts:1208` — `effectiveModel = params.model ??
   agentDefs?.model` (= null), explaining children inheriting the then-default.
7. `extensions/piread/index.ts:98`, `extensions/piedit/index.ts:73` —
   `registry?.registerToolExtension?.(name, path)` optional-chaining calls.
8. `extensions/{pibash,pidx}/index.ts` — no `registerToolExtension` calls (rg empty).
9. `tests/subagents/test.ts` — regression test `"resolves tool-extension paths for
   the four native tools (load-order safe)"`, via `__test__.getToolExtensionPath`.
10. `agents/worker.md` frontmatter — `tools: write, piread, piedit, pibash`.
11. `settings.json` — `defaultProvider=z.ai`, `defaultModel=glm-5.3`,
    `defaultThinkingLevel=max`, deepseek models "off".
12. Session JSONL tool-name histograms (children: `write` / `ask_question` / `ls` /
    `subagent*` only) and the four stand-down records.
