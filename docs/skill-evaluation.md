# Skill evaluation

How skills in `~/.pi/agent/skills/` are evaluated with SkillEvaluator, and what
is installed for it. Skill usage lives in the `skillevaluator` skill body
(`skills/skillevaluator/SKILL.md`); this doc records the local setup only.

## Installed

- CLI: `uv tool install --python 3.13 "skillevaluator[all]"` → `~/.local/bin/skillevaluator`
- SkillSpector: the evaluator's pinned wheel, installed as its own uv tool → `~/.local/bin/skillspector`. Export `SKILLEVALUATOR_SKILLSPECTOR_PATH` pointing at it; running the wheel through homebrew `uv tool run --from <wheel>` fails ("Distribution not found") even when the checksum matches.
- Gitleaks: already present from the system package manager. Semgrep: installed via Homebrew (optional leg of `security`).

## Testing upstream SkillSpector

Keep the evaluator's pinned scanner separate from upstream development tests.
With install approval, run this from the upstream checkout:

```bash
export UV_PROJECT_ENVIRONMENT="$(mktemp -d "${TMPDIR:-/tmp}/skillspector-test.XXXXXX")"
uv sync --locked --extra dev --python 3.13 --no-python-downloads
```

On macOS arm64, the SkillSpector 2.13.7 lock installed with Python 3.13;
Python 3.14 tried to build `yara-python` 4.5.4 from source and failed.

## Keyless commands (no provider, no spend)

`quality-check`, `tier1 <dir> --no-llm`, `security-scan`, `pii-scan`,
`lint-scripts`, `validate <dir> --tiers 1`.

## LLM tiers (provider)

Provider credentials live in `~/.pi/agent/.secrets/skillevaluator.env`
(agent home, gitignored, 0600 — the sentry `.secrets` pattern) and are loaded per
command; the file's values are never printed. It pins provider
`openai-compatible`, the coding-gateway base URL (`models-store.json` for
zai/glm-5.3), `glm-5.3` for evaluator, judge, and SkillSpector
(`glm-5.3-flash` does not work on this gateway — user confirmed 2025-11-22),
and both keys (`SKILL_EVAL_LLM_API_KEY`, plus the `OPENAI_API_KEY`
SkillSpector bridge; concurrency is re-injected by the `~/.local/bin/skillspector`
shim). Changing model or gateway means editing that file, which needs user
permission. File or key missing → stop and tell the user what to write.

```bash
set -a; . ~/.pi/agent/.secrets/skillevaluator.env; set +a
```

Scope: Tier 1 rubric and LLM security review work. Tier 2 needs an embeddings
endpoint, which the zai coding gateway does not expose. Tier 3 additionally
needs a Docker daemon, an agent CLI, and user-supplied `evals/evals.json` cases.

## Speed (measured 2026-11-22, glm-5.3 on the zai coding gateway)

- Default: full `tier1` with LLM (~4 min) — the preferred gate; findings are a
  strict superset of keyless (semantic analyzers + rubric + verification).
- Keyless `tier1 --no-llm` (~10 s) + `rubric-eval` (~30 s): inner-loop
  iteration only, never the final gate.
- The 4 min is SkillSpector's semantic analyzers (~200 s; per-request latency
  on the coding gateway is the floor — flash vs full model makes no difference).
- The gateway 429s parallel analyzer calls: the `~/.local/bin/skillspector`
  shim re-injects `SKILLSPECTOR_MAX_LLM_CONCURRENCY` (skillevaluator's env
  whitelist strips it); without the throttle the scan exits 2 after retry
  exhaustion.
- Any task estimated over 15 minutes (Tier 3, whole-folder validate): ask the
  user first with the estimate.

## False-positive baseline

Skills whose purpose is editing skill files trip SkillSpector's RA1
"Self-Modification" on their own description. Suppress rule-based (never
fingerprint — any edit re-arms it) via
`--skillspector-baseline ~/.pi/agent/reports/skillevaluator/<skill>/skillspector-baseline.yaml`.

## Scanner quirks (measured 2025-11-22)

- Bounded static parser cannot resolve `${...}` template literals in code
  samples → `static_parse_limit` → HIGH AE1 "analysis-evasion" on the SKILL.md
  line that links the file. Write string concatenation (`'...' + var`) in
  TypeScript samples instead; verified: all-`${}` file fails, all-concat file
  scans 100%.
- On the zai gateway the LLM security leg can end `incomplete`
(`skillspector-llm` in `incomplete_scans`) when analyzers exhaust 429 retries
even with the concurrency shim — rerun, or accept and rely on the keyless
  static findings; exit 1 with `overall_status: incomplete` is that case, not
  a content finding.

## Reports

Write all SkillEvaluator reports to `~/.pi/agent/reports/skillevaluator/<skill>/`.
Pass `-o` with a fresh run subdirectory for each evaluation so prior reports
remain available for comparison. Do not write reports beside the skill itself.
Keep raw reports local; the `reports/` directory is gitignored.

## Uninstall

`uv tool uninstall skillevaluator skillspector`; remove
`~/.local/share/skillevaluator` for the evaluator's runtime cache.
