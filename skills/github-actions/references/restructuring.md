# Restructuring workflows — removing jobs and build gates

Steps 5–6 of hardening procedure.

## Removing a job: audit `needs:` + setup it carried

Job deletion looks like one block; really two edits.

- `rg` for `needs:` before removing. Surviving `needs: <deleted-job>` = dangling — GitHub rejects whole workflow; failure lands at next push, not edit time:

  ```sh
  rg -n 'needs:' .github/workflows/
  ```

- Job = only place its toolchain was set up. Removing build/verify job commonly removes sole `actions/setup-node` (or setup-python/setup-go), silently moving later steps onto runner image's version — works today, breaks on image rotation. `rg` after removing:

  ```sh
  rg -n 'setup-node|setup-python|setup-go' .github/workflows/
  ```

  Remaining step runs language tool → restore setup action into that job, pinned SHA, or version becomes unversioned infrastructure.

Parse with real YAML parser after, not eyeball — `python3 -c 'import yaml,sys; print(yaml.safe_load(open(sys.argv[1])))' <file>` or Ruby `YAML.load_file`; both stdlib, macOS+Linux. Then list job keys + `needs:` targets; every target resolves to real job. Unquoted `$GITHUB_OUTPUT` worth fixing here: `"$GITHUB_OUTPUT"` — path with spaces can't split.

## Deleting a build gate = decision, not cleanup

`verify`/`build-check` job running install + build before deploy = only thing between broken tree and published image. Removing = policy change: deploy job's own build still compiles app, so compile errors surface later not never, but no signal reaches pull requests. State trade-off in commit message + open issue that asked for gate — gap recorded, not rediscovered.

Pre-push git hook ≠ CI gate substitute even when present — hooks skipped by `--no-verify`, not installed on every clone, invisible to PR reviewer. Verify hook exists before trusting enforcement claims (`ls .husky/`, `husky` key in `package.json`, `git config core.hooksPath`) — often proposed in review, never committed.

## Removing a whole workflow that enforced a control

Deleted control workflow (secret scanning, e.g. gitleaks; dependency audit) = coverage decision, not cleanup. Document the replacement control in the CHANGELOG/PR so reviewers can verify coverage is not lost — when the replacement is local hooks, state the accepted trade-off explicitly (hook-substitute caveat above). Then `rg` the whole repo — not just `.github/workflows/` — for stale claims that the removed workflow still runs (hook comments, docs, scripts): they must describe the replacement, not the dead workflow.
