# Change Discipline

- Simplest thing that works — ponytail ladder, tried in arrow order, stop at the first that suffices: YAGNI (don't build it) → reuse this codebase → language stdlib → platform/OS → already-installed dep → one-line fix → new code. Understand the problem first.
- Bug fix = root cause; `rg` the callers first.
- Deployment constraints first: fix touches env vars, network/TLS, proxy, auth or startup → ask once, batched, about deployment realities (servers, env never set, proxies). A correct fix that breaks a standing deployment is a regression.
- Addition and deletion both solve the task → prefer deletion.
- Never delete beyond approved scope.

## Commit shape

Local, unpushed history is editable; published history is not. Rewrite only commits no remote has.

- Record the pre-rewrite SHA in the reply before touching anything. Recovery is `git reset --hard <sha>`; the reflog holds it only until gc.
- Regroup with `git reset <base>` (mixed): history moves, files stay, nothing is lost. `--soft` is only needed when the index state itself matters.
- Commit per scope by pathspec, one call each: `git commit` after staging one group. Partial staging (`add -p`) splits a hunk that usually belongs together and cannot be reviewed later.
- Message states why the group is one change, not what the diff shows. Squashing a revert pair leaves the subject describing the net effect, never the detour.
