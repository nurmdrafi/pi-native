# Providers and credentials

Set exactly one provider. If `SKILL_EVAL_LLM_PROVIDER` is unset and exactly
one of `NVIDIA_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` is exported,
it is auto-selected; with more than one, LLM commands fail until the
provider is set.

| Provider | Variables | Notes |
| --- | --- | --- |
| `nv_build` | `NVIDIA_API_KEY` | One key covers Tier 1 LLM, Tier 2 embeddings, and Tier 3 agents in `docker`, `kata`, `local`; default agent `opencode` |
| `openai` | `OPENAI_API_KEY` | Default agent `codex` |
| `anthropic` | `ANTHROPIC_API_KEY` | Default agent `claude-code`; Tier 2 needs a separate embedding provider |
| `bedrock` | AWS credential chain, `AWS_REGION` | Tier 2 needs a separate embedding provider |
| `openai-compatible` | `SKILL_EVAL_LLM_BASE_URL`, `SKILL_EVAL_LLM_API_KEY` | Any gateway; override models whose catalog IDs differ |

Overrides: `SKILL_EVAL_LLM_MODEL` (evaluator and judge),
`LLM_JUDGE_MODEL` (judge only), `SKILL_EVAL_EMBEDDING_MODEL`,
`--agent-model AGENT=MODEL` (Tier 3 agent). OpenCode on a gateway takes
`--agent-model opencode=openai/MODEL`. Codex needs a Responses-API model,
OpenCode Chat Completions, Claude Code Anthropic Messages, all with tool
calls.

Rules:

- Credentials come only from the host environment (or masked CI secrets).
  `harbor.runtime_env` in `<skill-dir>/evals/config.yml` rejects provider keys and base
  URLs with a hard error.
- `skillevaluator models` and `doctor --verify-models` check catalog
  reachability; a public catalog does not prove the inference key works.
- Judge failures make a result unscored (`NO SCORE`), not `0.0`.

## Z.ai (GLM)

Wire as `openai-compatible`: `SKILL_EVAL_LLM_BASE_URL=https://api.z.ai/api/paas/v4`,
`SKILL_EVAL_LLM_MODEL=glm-5.3` (catalog: glm-4.5 to glm-5.3 plus -flash variants;
`SKILLSPECTOR_MODEL=glm-5.3-flash` serves the scanner). Known limits:

- No embedding models on api.z.ai (`embedding-2`/`embedding-3` fail with error
  1211), so Tier 2 has no embeddings source on this provider.
- Low rate limits: SkillSpector's LLM analyzers exhaust retries on HTTP 429 even
  at `SKILLSPECTOR_MAX_LLM_CONCURRENCY=1`, leaving the Security check
  `incomplete`. Keyless runs are `incomplete` by design (LLM analyzers skipped).
- `tier1 --skillspector-baseline FILE` suppresses only audited findings;
  generate with `skillspector baseline <dir> --no-llm -o FILE`, keep reviewed
  fingerprints with real reasons, and rerun the gate with the file.
