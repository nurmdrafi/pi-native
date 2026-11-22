# Skill evaluation

How skills in `~/.pi/agent/skills/` are evaluated with SkillEvaluator, and what
is installed for it. Skill usage lives in the `skillevaluator` skill body
(`skills/skillevaluator/SKILL.md`); this doc records the local setup only.

## Installed

- CLI: `uv tool install --python 3.13 "skillevaluator[all]"` → `~/.local/bin/skillevaluator`
- SkillSpector: the evaluator's pinned wheel, installed as its own uv tool → `~/.local/bin/skillspector`. Export `SKILLEVALUATOR_SKILLSPECTOR_PATH` pointing at it; running the wheel through homebrew `uv tool run --from <wheel>` fails ("Distribution not found") even when the checksum matches.
- Gitleaks: already present from the system package manager. Semgrep: installed via Homebrew (optional leg of `security`).

## Keyless commands (no provider, no spend)

`quality-check`, `tier1 <dir> --no-llm`, `security-scan`, `pii-scan`,
`lint-scripts`, `validate <dir> --tiers 1`.

## LLM tiers (provider)

The GLM key is read from the `zai` entry in `~/.pi/agent/auth.json` and exported
per command into the environment only — it never enters a file, a report, or a
commit. Model and provider come from the live session (`PI_MODEL` /
`PI_PROVIDER` env) — the defining source; the base URL is looked up from the
catalog (`models-store.json`) for that provider+model. Switching model or
subscription needs no edit here:

```bash
export SKILL_EVAL_LLM_PROVIDER=openai-compatible
export SKILL_EVAL_LLM_MODEL="$PI_MODEL"   # e.g. glm-5.3; never a catalog default
export SKILL_EVAL_LLM_BASE_URL="$(jq -r --arg p "$PI_PROVIDER" --arg m "$SKILL_EVAL_LLM_MODEL" \
  '.[$p].models[] | select(.id==$m) | .baseUrl' ~/.pi/agent/models-store.json)"
export SKILL_EVAL_LLM_API_KEY="$(jq -r .zai.key ~/.pi/agent/auth.json)"
# SkillSpector semantic-security leg needs its own bridge (model may be the
# fast variant; concurrency is re-injected by the ~/.local/bin/skillspector shim):
export SKILLSPECTOR_PROVIDER=openai SKILLSPECTOR_MODEL="$SKILL_EVAL_LLM_MODEL"
export OPENAI_BASE_URL="$SKILL_EVAL_LLM_BASE_URL" OPENAI_API_KEY="$SKILL_EVAL_LLM_API_KEY"
```

Scope: Tier 1 rubric and LLM security review work. Tier 2 needs an embeddings
endpoint, which the zai coding gateway does not expose. Tier 3 additionally
needs a Docker daemon, an agent CLI, and user-supplied `evals/evals.json` cases.

## Speed (measured 2026-11-22, glm-5.3 on the zai coding gateway)

- Keyless `tier1 --no-llm`: ~15 s. `rubric-eval`: ~30 s. Fast path for iteration:
  run those two; skip the semantic-security leg.
- Full `tier1` (LLM): ~4 min, dominated by SkillSpector's semantic analyzers
  (~200 s; flash or full model makes no measurable difference — per-request
  latency on the coding gateway is the floor, not model speed).
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

## Reports

`~/.pi/agent/reports/skillevaluator/<skill>/` — json and markdown per tier.
Copy the current report to `baseline-*.json` before iterating on a skill so
before/after scores stay comparable.

## Uninstall

`uv tool uninstall skillevaluator skillspector`; remove
`~/.local/share/skillevaluator` for the evaluator's runtime cache.
