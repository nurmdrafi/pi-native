# Portability

The supported targets are macOS and Linux. Windows is not a supported runtime target unless a specific component documents otherwise.

## Paths and machine state
- Never commit absolute user, host, device, or machine-specific paths.
- Derive paths at runtime from the executable location, home directory, environment, arguments, or repository root.
- Use repository-relative or home-relative paths in generated and recorded artifacts.
- Use placeholders such as `<home>` and `<user>` when documenting historical paths.
- Keep credentials, private endpoints, and machine-local configuration out of tracked files.

## Shell and operating-system behavior
- Use POSIX `sh` for portable setup scripts; use Bash only where the script explicitly requires it.
- Do not assume GNU and BSD command-line utilities behave identically. Detect or branch where behavior differs.
- Avoid hard-coded system paths when a PATH lookup or runtime capability check is appropriate.
- Provide a documented fallback when a platform-specific command is optional.
- Do not assume an interactive shell has been initialized in a non-interactive process.

## Determinism
- Sort filesystem traversal results when output order affects behavior, tests, hashes, or generated artifacts.
- Use explicit byte order and stable serialization for persisted binary or structured formats.
- Test platform-dependent behavior on both macOS and Linux where practical; otherwise state which platform was not tested.
