# workflow — fast path (applies to every task in this skill)

Budget: one comment/reply = max 5 tool rounds. Past that, stop and simplify.

## Fetch a post (ONE command, no re-probing)

tvly output is one giant JSON line; byte-slicing it wastes rounds. Extract, clean, print:

    tvly extract "<URL>" -o /tmp/li_t.md >/dev/null 2>&1
    jq -r '.results[0].raw_content' /tmp/li_t.md | sed '/To view or add a comment/,$d' | sed -E 's/!\[[^]]*\]\([^)]*\)//g; s/\[([^]]*)\]\([^)]*\)/\1/g' | sed '/^[[:space:]]*$/d' > /tmp/li_post.txt
    cat /tmp/li_post.txt

Post bodies land under the 2KB output cap once comments/CTA are stripped. If extract fails (login wall), ask for paste immediately - one attempt, no retry loop.

## Read state in parallel

voice.md + log.md (batched with the fetch). Don't re-page skill references already summarized elsewhere.

## Draft to the detector's thresholds FIRST TIME

Pass bars (detect.py): burstiness >= 0.55, specificity >= 4 markers/100 words, slop = 0, fingerprint clean (ASCII, no em dash, no curly quotes), voice = contractions + personal pronouns.

First draft, before any tool run:
- one 1-3 word sentence, one 25+ word sentence (burstiness)
- digits and proper nouns from the voice profile's proof list (specificity)
- contractions in from the start (voice)
- plain ASCII punctuation (fingerprint)
- 2-4 sentences per option, two options of different types, one idea each (comment rules)

## One detect run, then deliver

humanize + detect in a single command. PASS -> deliver + append log row in the same turn. FLAGGED -> one fix round on the named weakest check. Two failed rounds = wrong draft, rewrite differently (per references/human.md).

## No repo operations in the task loop

No git, no .gitignore, no commits as part of drafting. The user's data dir `~/.pi/agent/linkedin/` is personal state only.
