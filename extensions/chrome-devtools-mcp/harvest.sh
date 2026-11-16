#!/usr/bin/env bash
# jobsearch harvest driver — jittered single-pass per query.
# usage: harvest.sh <pageId> <urlencoded-query> <tag>   (e.g. harvest.sh 3 '%23hiring%20frontend' pass4-nextjs)
set -euo pipefail
C="$HOME/.pi/agent/extensions/chrome-devtools-mcp"
OUT="$HOME/Desktop/MyProject/career-ops/jobsearch/runs/2026-11-13/raw"
PAGE="${1:?pageId}"; Q="${2:?query}"; TAG="${3:?tag}"

run_eval() {  # $1 = script file
  local arg
  arg="evaluate_script:$(jq -nc --rawfile f "$1" "{pageId:$PAGE,function:\$f}")"
  timeout 60 node "$C/mcp-client.mjs" "$arg" 2>&1
}

node "$C/mcp-client.mjs" "navigate_page:{\"pageId\":$PAGE,\"url\":\"https://www.linkedin.com/search/results/all/?keywords=$Q&origin=GLOBAL_SEARCH_HEADER\"}" >/dev/null
sleep $((RANDOM % 5 + 4))
i=0
while true; do
  i=$((i+1))
  R=$(run_eval "$C/expand1.js") || true
  echo "cycle $i: $(echo "$R" | tr -d '\n' | head -c 170)"
  if echo "$R" | rg -q '"done": ?true'; then break; fi
  if [ "$i" -ge 90 ]; then echo "ceiling 90 cycles"; break; fi
  sleep $((RANDOM % 8 + 3))   # jittered dwell 3-10s
done
F="$OUT/$(date +%Y-%m-%dT%H%M)-$TAG.json"
run_eval "$C/expand2.js" > "$F"
echo "saved $F"
