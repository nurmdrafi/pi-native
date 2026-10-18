# Change Discipline

- Simplest thing that works — ponytail ladder, tried in arrow order, stop at the first that suffices: YAGNI (don't build it) → reuse this codebase → language stdlib → platform/OS → already-installed dep → one-line fix → new code. Understand the problem first.
- Bug fix = root cause; `rg` the callers first.
- Deployment constraints first: fix touches env vars, network/TLS, proxy, auth or startup → ask once, batched, about deployment realities (servers, env never set, proxies). A correct fix that breaks a standing deployment is a regression.
- Addition and deletion both solve the task → prefer deletion.
- Never delete beyond approved scope.
