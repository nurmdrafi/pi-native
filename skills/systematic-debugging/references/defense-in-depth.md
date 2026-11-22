# Defense-in-Depth Validation

## Overview

Bug caused by invalid data: one validation point feels sufficient. Bypassable — different code paths, refactoring, mocks.

Core: validate at EVERY layer data passes through. Make bug structurally impossible.

## Why Multiple Layers

Single validation: "we fixed the bug"
Multiple layers: "we made the bug impossible"

Layers catch different cases:
- Entry validation: most bugs
- Business logic: edge cases
- Environment guards: context-specific dangers
- Debug logging: when other layers fail

## The Four Layers

### Layer 1: Entry Point Validation — reject invalid input at API boundary

```typescript
function createProject(name: string, workingDirectory: string) {
  if (!workingDirectory || workingDirectory.trim() === '') {
    throw new Error('workingDirectory cannot be empty');
  }
  if (!existsSync(workingDirectory)) {
    throw new Error('workingDirectory does not exist: ' + workingDirectory);
  }
  if (!statSync(workingDirectory).isDirectory()) {
    throw new Error('workingDirectory is not a directory: ' + workingDirectory);
  }
  // ... proceed
}
```

### Layer 2: Business Logic Validation — data must make sense for this operation

```typescript
function initializeWorkspace(projectDir: string, sessionId: string) {
  if (!projectDir) {
    throw new Error('projectDir required for workspace initialization');
  }
  // ... proceed
}
```

### Layer 3: Environment Guards — block dangerous ops in specific contexts

```typescript
async function gitInit(directory: string) {
  // In tests, refuse git init outside temp directories
  if (process.env.NODE_ENV === 'test') {
    const normalized = normalize(resolve(directory));
    const tmpDir = normalize(resolve(tmpdir()));

    if (!normalized.startsWith(tmpDir)) {
      throw new Error('Refusing git init outside temp dir during tests: ' + directory);
    }
  }
  // ... proceed
}
```

### Layer 4: Debug Logging — record the call site before the risky operation

```typescript
async function gitInit(directory: string) {
  const stack = new Error().stack;
  logger.debug('About to git init', {
    directory,
    cwd: process.cwd(),
    stack,
  });
  // ... proceed
}
```

## Applying the Pattern

Found a bug:
1. Trace data flow — bad value origin? where used?
2. Map all checkpoints — every point data passes through
3. Add validation at each layer — entry, business, environment, debug
4. Test each layer — try bypassing layer 1, verify layer 2 catches it

## Example from Session

Bug: empty `projectDir` → `git init` in source code

Flow: test setup → empty string → `Project.create(name, '')` → `WorkspaceManager.createWorkspace('')` → `git init` in `process.cwd()`

Four layers added:
- Layer 1: `Project.create()` validates not empty/exists/writable
- Layer 2: `WorkspaceManager` validates projectDir not empty
- Layer 3: `WorktreeManager` refuses git init outside tmpdir in tests
- Layer 4: stack trace logging before git init

Result: 1847 tests passed, bug impossible to reproduce

## Key Insight

All four layers necessary — each caught bugs others missed in testing:
- Different code paths bypassed entry validation
- Mocks bypassed business logic checks
- Cross-platform edge cases needed environment guards
- Debug logging identified structural misuse

One validation point ≠ enough. Checks at every layer.
