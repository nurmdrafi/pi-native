# Contributing

## Setup
Follow the prerequisites and bootstrap instructions in `README.md`. Use the Node and Rust versions declared by the repository. Bootstrap reports missing toolchains; it does not install privileged system dependencies.

## Development
- Read `AGENTS.md` and the scoped document for the area being changed.
- Make the smallest change that addresses the requirement.
- Add regression coverage for behavior changes.
- Native-tool behavior must remain consistent with the documented contract and parity tests. Follow the relevant native-tool architecture and optimization guidance before changing execution semantics.
- Do not include credentials, private endpoints, machine-specific paths, or private project data in tracked files.

## Validation
Use `package.json` as the source of truth for available scripts. Run the narrowest relevant test while iterating, then the repository's full check before submitting when practical. Report commands that could not be run and why.

## Documentation
Keep each rule in one authoritative location. Global behavior belongs in `AGENTS.md`; detailed procedures belong in `docs/`; repeatable user-invoked workflows belong in `prompts/`; deterministic enforcement belongs in extensions and tests.

## Pull requests
Describe the behavior change, rationale, scope, and verification evidence. For native-tool changes, include relevant parity or differential test results. Do not publish releases or change versions unless requested by the maintainer.
