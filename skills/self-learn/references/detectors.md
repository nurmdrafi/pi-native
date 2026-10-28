# Detectors — deterministic queries over pidx extracts

Run after `pidx`. All operate on the extracts JSONL (default
`~/.pi/agent/.cache/pidx-extracts.jsonl` as reported by the pidx call).
Extract schema: one line per session — `path` (filename embeds UTC date),
`calls[]` (`id`, `name`, `ts`, `ph` param hash, `cmd`, `path`), `results[]`
(`id`, `err`, `bytes`), `turns[]`, `compactions[]`, `skills[]`.

Window filter — set once, reuse in every query (default 2 days):

```sh
F=~/.pi/agent/.cache/pidx-extracts.jsonl
C=$(date -u -d '2 days ago' +%Y-%m-%d)
# inside jq: select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c)
```

## S1 — tool errors by tool (edit-anchor failure rate)

```sh
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | .calls[] as $c2 | .results[] | select(.id==$c2.id and .err==true) | $c2.name' $F | sort | uniq -c | sort -rn
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | [.calls[] | select(.name=="piedit")] | length' $F   # denominator
```

Rate = piedit errors / piedit calls. Cross-check: what fraction of errored
piedit calls were preceded (same session) by a `sed -n` or `cat` on the same
target — that is the bypass-feeds-anchor hypothesis.

## S2 — identical-call retries (same param hash, 2+ per session)

```sh
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | .calls | group_by(.ph) | .[] | select(length>1) | (length|tostring) + "x " + .[0].name + " :: " + ((.[0].cmd // .[0].path // "-")[0:70])' $F | sort -rn | head -15
```

## S3 — circling (3+ edits to one path per session)

```sh
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | .calls | map(select(.name=="piedit" and .path != null)) | group_by(.path) | .[] | select(length>=3) | (length|tostring) + " edits :: " + .[0].path' $F | sort -rn | head -10
```

## S4 — read-tool bypass (sed/cat vs native reader)

```sh
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | .calls[] | select(.cmd != null) | .cmd' $F > /tmp/cmds.txt
for p in 'sed -n' 'cat ' ' grep ' 'find ' '|| true' 'head -'; do
  printf '%-10s %s\n' "$p" "$(rg -c -F "$p" /tmp/cmds.txt || echo 0)"; done
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | [.calls[] | select(.name=="piread")] | length' $F
```

S4 = sed+cat counts vs piread count; S5 = grep/find/`|| true` counts;
S6 = distinct `nvm`-sourcing command variants (`rg -F nvm /tmp/cmds.txt |
sort -u | wc -l`, variants ≥2 = friction); S7 = head count (health signal,
higher is fine).

## S8 — gate-vs-context false-positive candidates

Errored read/edit calls on a file the same session already wrote or edited
(the agent plausibly held certified content, yet the call failed):

```sh
jq -r --arg c "$C" 'select((.path|capture("(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2})").d) >= $c) | .calls as $cs | .results as $rs | [ $cs[] | select((.name=="write" or .name=="piedit") and .path != null) | {p:.path, t:.ts} ] as $touched | [ $cs[] | select((.name=="piread" or .name=="piedit") and .path != null) ] as $tgts | [ $tgts[] as $t | select(any($rs[]; .id==$t.id and .err==true)) | select(any($touched[]; .p==$t.path and .t<$t.ts)) | $t.name+" :: "+($t.path|.[0:60]) ] | .[]' $F | sort | uniq -c | sort -rn | head -12
```

Candidates, not verdicts: a legitimate anchor mismatch on a recently touched
file lands here too. Classify by reading the block reason in the raw session
file (spot-check top offenders) — false positive = gate demanded
re-read/re-anchor for a span the session itself had produced.

## S9 — rule-source desync (static, periodic)

Scope: session-related rules and gates ONLY — rules with a tool-call
surface. Compare declared rules (SYSTEM.md tool-path/bash/blocks,
AGENTS.md safety, skills' tool-call instructions) vs gate enforcement
(`RULE_IDS` in extensions/permission-gate/config.ts plus the header table
in index.ts) vs session behaviour (S1-S8 window signals). Doc-style,
communication, and process rules have no gate surface — out of scope.
Classify every rule: A declared+enforced+compliant, B declared+enforced+
deviating, C declared+unenforced, D enforced+declared-nowhere, E soft by
design. Output: `lessons/<date>-sync-pass.md` matrix + numbered findings,
proposals not applied. Gate block reasons carry the fix — a block citing a
rule the prompt never stated is a D-class finding. Semantic matching is
agent work; rg only gathers.

## Caveats

- Extracts lag the live session; the running session is audited from
  in-context history, not from this file.
- Raw-log keyword counts are echo-polluted (rule text repeats every session);
  the queries above are the primary evidence, raw logs only for spot-checks.
- `group_by` needs sorted input within a session's calls; if a session file
  was resumed/forked, hashes may legitimately repeat across branches — check
  the session's `compactions`/branch markers before counting a retry as a
  violation.
