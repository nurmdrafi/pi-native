# Change and release discipline

## Implementation
- Understand the defect and its callers before changing code.
- Prefer deletion or reuse when it solves the requirement without reducing correctness.
- Fix root causes, not symptoms. Add a regression test for behavioral defects.
- Consider deployment constraints when a change touches environment variables, networking, TLS, proxies, authentication, or startup.
- Never expand beyond the approved file and behavior scope.

## Commit history
- Do not rewrite published history.
- Rewrite only local commits that are confirmed not to exist on a remote.
- Before rewriting local history, record the pre-rewrite commit SHA and state the recovery command.
- Stage and commit by explicit path scope. Avoid staging unrelated user changes.
- Commit messages must follow the repository's Conventional Commit configuration and current commitlint rules. Do not duplicate validator constraints here; inspect the configuration when changing the policy.

## Release
- Versioning and changelog policy are defined by the release workflow and CI configuration.
- A successful test suite does not itself authorize publishing. Follow the authorization rule in `AGENTS.md` and the explicit conditions in `prompts/ship.md`.
