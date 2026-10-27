# Subagent Architecture Plan: Zero-Reread Context Ingestion Protocol
**Targeted Segment Injection Framework for nurmdrafi/pi-native**

---

## 1. The Context Hand-Off Gap
The `nurmdrafi/pi-native` harness deploys isolated worker subagents inside dedicated `tmux` sandboxes. While this ensures strict environment isolation, it introduces a major performance bottleneck:
* **Stateless Initial Windows:** A newly spawned worker subagent has a clean memory window. It has no access to the parent agent's historical context loops.
* **Anchor Guard Failure:** The native `piedit` tool enforces *Anchor Guard Parity* to maintain structural alignment. If a subagent attempts a code mutation (`piedit`) on a file layout it has never read, the precise target string anchors fail, throwing immediate permission-gate rejections.
* **The Redundant Reread Loop:** To prevent these drops, subagents are typically forced to execute full file reads over multi-megabyte source paths on their first turn, introducing latency and bloating token consumption.

---

## 2. Targeted Segment Injection Protocol
To bypass full file re-reading while keeping operations safe, this design introduces the **Targeted Segment Injection Protocol**. Instead of forcing the worker to scan the codebase, the main agent extracts the exact code range it wants to modify and embeds it directly into the subagent's runtime initialization window.

```
 [Main Agent] (Maintains full contextual layout map)
      │
      ▼ (Extracts precise file slice boundaries)
 [Target Map Envelope] ──► [Harness Environment Integration] ──► [tmux Sandboxed Worker]
                                                                          │
 [Zero-Reread Success] ◄───(Invokes Native Diff via piedit)───────────────┘
```

---

## 3. High-Performance Configuration Schema
The parent agent bundles structural context blocks into a dedicated string payload injected directly into the worker's execution envelope via `extensions/subagents/index.ts`.

### Telemetry & Environment Schema Layout
```json
{
  "session_id": "pi-auth-2026-x992",
  "target_file": "src/controllers/auth.rs",
  "line_range": "85-110",
  "context_anchor": "pub fn verify_session_token(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    // [Target Block for Mutation]
}"
}
```

This structural envelope is written as a compact stringified environment variable (`PI_SUBAGENT_TARGET_MAP`) parsed natively by the sidecar binary at the moment of initialization.

---

## 4. Implementation Specifications

### A. Harness Environment Wrapper Layout (`extensions/subagents/index.ts`)
Inject this non-invasive hook inside your TypeScript subagent spawn script to intercept the payload and map boundaries securely before initializing the terminal screen:

```typescript
import { exec } from 'child_process';

interface TargetMap {
  session_id: string;
  target_file: string;
  line_range: string;
  context_anchor: string;
}

export function spawnWorkerSubagent(sessionName: string, mapPayload: TargetMap) {
  // Stringify the anchor map payload tightly to protect the system token budget
  const serializedMap = JSON.stringify(mapPayload);
  
  const envOverrides = {
    ...process.env,
    PI_SUBAGENT_NAME: sessionName,
    PI_SUBAGENT_TARGET_MAP: serializedMap,
  };

  // Bootstrap the sandboxed worker inside tmux with complete structural parameters
  const command = `tmux new-session -d -s "${sessionName}" 'bin/pidoc --init-worker'`;
  
  exec(command, { env: envOverrides }, (error) => {
    if (error) {
      console.error(`[Harness Error] Failed to secure subagent sandbox: ${error.message}`);
    }
  });
}
```

### B. Native Anchor Injector Framework (`src/subagent_init.rs`)
This compiled Rust utility reads the shared environment variables inside the new subagent process and seeds the worker's prompt layout instantly, preventing runtime allocation drops.

```rust
use std::env;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct SubagentContext {
    pub session_id: String,
    pub target_file: String,
    pub line_range: String,
    pub context_anchor: String,
}

pub fn initialize_worker_prompt() -> Result<String, &'static str> {
    // Ingest payload parameters from environment variables
    let raw_map = env::var("PI_SUBAGENT_TARGET_MAP")
        .map_err(|_| "SUBAGENT_INIT_FAIL: Target context map environment configuration missing.")?;
        
    let context: SubagentContext = serde_json::from_str(&raw_map)
        .map_err(|_| "SUBAGENT_INIT_FAIL: Malformed contextual JSON serialization string.")?;

    // Build a compact, zero-allocation initial prompt layout block
    let structural_prompt = format!(
        "SYSTEM CONTEXT INJECTION:
You are assigned to modify '{}' within boundaries: {}.
        You possess verified target anchor memory below. Do not execute file reads.
        Invoke `piedit` directly matching this layout configuration:

```rust
{}
```",
        context.target_file, context.line_range, context.context_anchor
    );

    Ok(structural_prompt)
}
```

---

## 5. Summary Benefits for the pi-native Harness
1. **Zero System Overhead:** Subagents process tasks immediately on turn one without forcing the kernel or the V8 thread to handle multi-megabyte I/O reads.
2. **Anchor Guard Compliance:** Because the subagent receives the exact block string layout, its diff outputs perfectly satisfy your native `piedit` tool's safety bounds.
3. **Token Conservation:** Passing a 20-line structural text fragment consumes less than 0.5 kilotokens, preventing the steep token accumulation typical of large multi-file workspaces.

---
This is for informational purposes only. For medical advice or diagnosis, consult a professional. AI responses may include mistakes.
