# Tool-use conventions

These conventions apply to maintenance of the pi-native repository. They are not global requirements for unrelated projects.

## Search and read
- Search the narrowest relevant directory or file set first. Use one search pass for independent targets.
- Resolve unknown paths before reading. Do not guess filenames.
- Read only the relevant ranges; use continuation offsets returned by the read tool rather than reconstructing ranges from truncated output.
- For symbols, inspect the definition and its consumers. For behavior claims, inspect the runtime consumption site, not only the helper that computes a value.
- Before relying on an output shape, inspect the producer and the consumer.

## Edit
- Group independent edits to the same file into one operation where practical.
- Apply multiple non-overlapping replacements from bottom to top.
- After an edit is rejected, correct only the rejected region; do not resend an unchanged operation.
- Avoid broad rewrites when a targeted change is sufficient.

## Shell
- A shell invocation is a fresh process. Do not assume a prior `cd`, shell variable, or environment activation persists.
- Use absolute paths or explicitly establish the working directory in each call.
- Follow the repository's declared Node and Rust toolchain versions.
- Prefer structured file/search tools for inspection; use the shell for commands, tests, builds, and genuine side effects.
- Keep command output bounded. Save large output to a temporary file and inspect relevant ranges.

## Recovery
- Follow corrective instructions returned by a tool or permission gate.
- After two failed attempts, change the approach. After three unsuccessful probes of the same fact, report it unresolved or combine the remaining checks.
- Never route around a permission denial by changing tools, splitting commands, or disguising the operation.

## Delegation
- Before spawning a subagents workflow, read `docs/subagent-orchestration.md`.
- Avoid package-execution shortcuts such as `npx` when they could download and execute an unreviewed package.
