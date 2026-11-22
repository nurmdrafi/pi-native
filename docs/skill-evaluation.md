# Skill evaluation

How skills in `~/.pi/agent/skills/` are evaluated with SkillEvaluator, and what
is installed for it. Skill usage lives in the `skillevaluator` skill body
(`skills/skillevaluator/SKILL.md`); this doc records the local setup only.

## Installed

- CLI: `uv tool install --python 3.13 "skillevaluator[all]"` → `~/.local/bin/skillevaluator`
- SkillSpector: the evaluator's pinned wheel, installed as its own uv tool → `~/.local/bin/skillspector`. Export `SKILLEVALUATOR_SKILLSPECTOR_PATH` pointing at it; running the wheel through homebrew `uv tool run --from <wheel>` fails ("Distribution not found") even when the checksum matches.
- Gitleaks: already present from the system package manager. Semgrep: optional, not installed.

## Keyless commands (no provider, no spend)

`quality-check`, `tier1 <dir> --no-llm`, `security-scan`, `pii-scan`,
`lint-scripts`, `validate <dir> --tiers 1`.

## LLM tiers (provider)

The GLM key is read from the `zai` entry in `~/.pi/agent/auth.json` and exported
per command into the environment only — it never enters a file, a report, or a
commit:

```bash
export SKILL_EVAL_LLM_PROVIDER=openai-compatible
export SKILL_EVAL_LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4
export SKILL_EVAL_LLM_MODEL=glm-5.3
export SKILL_EVAL_LLM_API_KEY="$(jq -r .zai.key ~/.pi/agent/auth.json)"
```

Scope: Tier 1 rubric and LLM security review work. Tier 2 needs an embeddings
endpoint, which the zai coding gateway does not expose. Tier 3 additionally
needs a Docker daemon, an agent CLI, and user-supplied `evals/evals.json` cases.

## Reports

`~/.pi/agent/reports/skillevaluator/<skill>/` — json and markdown per tier.
Copy the current report to `baseline-*.json` before iterating on a skill so
before/after scores stay comparable.

## Uninstall

`uv tool uninstall skillevaluator skillspector`; remove
`~/.local/share/skillevaluator` for the evaluator's runtime cache.
