# Shared dependency checks for bootstrap and after-pull. Source from the repo root.

npm_deps_present() {
  npm --prefix "$1" ls --all --json 2>/dev/null | node -e '
    try {
      const { problems = [], error } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      // link-pi intentionally uses the installed host version, not the npm pin.
      const broken = problems.some(p => p.startsWith("missing: ") ||
        (p.startsWith("invalid: ") && !p.startsWith("invalid: @earendil-works/pi-")));
      if (broken || (error && error.code !== "ELSPROBLEMS")) process.exitCode = 1;
    } catch { process.exitCode = 1; }
  '
}

sync_research_deps() (
  result=0
  sh scripts/install-bx.sh || result=1
  reader=skills/browser-tools
  if ! command -v npm >/dev/null 2>&1; then
    echo '!! URL reader: npm not found; install Node and re-run setup' >&2
    result=1
  elif ! npm_deps_present "$reader" ||
       { git rev-parse --verify -q ORIG_HEAD >/dev/null 2>&1 &&
         ! git diff --quiet ORIG_HEAD HEAD -- "$reader/package.json" "$reader/package-lock.json"; }; then
    npm --prefix "$reader" install --no-audit --no-fund || result=1
  fi
  exit "$result"
)
