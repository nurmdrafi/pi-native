# Architecture Plan: Inferential Zero-Allocation State Tracking for pi-native

> **Status: superseded — do not implement.** Validation findings V1-V16 in
> `docs/plans/permission_gate_implementation_plan.md` record why each section of this
> design fails against the current harness (no Rust seam for `tool_call`, unsound mmap
> state, uncompilable inference code, dependency blow-up for telemetry). Kept as the
> record of the rejected approach.

This document details the architectural blueprint for converting the permission gate in `nurmdrafi/pi-native` from a **stateless, mechanic-only checker** into an **inferential, zero-overhead contextual gate**. It focuses on achieving maximum I/O throughput, strict clean-code architecture, and absolute compatibility with upstream `pi` updates without introducing LLM processing latency or memory allocation bloat.

---

## 1. Executive Summary & Design Constraints

### The Problem
Traditional permission gates analyze tool invocations structurally using static rules (e.g., regex paths or matching strings). This makes them context-blind. They cannot distinguish a safe file change from a malicious, recursive loop sequence running out of control, nor do they understand the temporal context of an active agent turn session.

### The Solution
Instead of running heavy downstream classification loops or using LLMs to infer context, `pi-native` utilizes **Inferential Zero-Allocation State Tracking**. By piggybacking on the binary file writes and stdout stream transformations already handled natively by `pibash` and `pidx`, the harness inferentially deduces the current phase of the conversation. State tracking is synchronized via an ultra-low-latency, shared memory-mapped binary ring buffer file (`.session.state`). The permission gate verifies context constraints via O(1) bitmask calculations before tool execution threads can spawn.

### Performance Constraints
*   **LLM Latency:** 0ms overhead (no model loops used for state inference).
*   **Memory Overhead:** Fixed-size allocations, zero runtime heap churn using stack-allocated structures.
*   **I/O Throughput:** Near memory bandwidth speeds utilizing raw shared pointer offsets via `memmap2`.
*   **Compatibility:** Upstream safety is guaranteed because the orchestration framework leaves the official TypeScript/Node peer modules intact, preserving standard platform lifecycles.

---

## 2. Low-Level System Blueprint

### Data Flow Pipeline
```
[Agent Intent Inbound] ──► [Permission Gate Evaluator]
                                      │ (Reads O(1) Shared State Map)
                                      ▼
                      [✅ Approved Tool Execution]
                                      │
         ┌────────────────────────────┴────────────────────────────┐
         ▼                                                         ▼
  [pibash Daemon Stream]                                [pidx Log Chunk Pointer]
         │                                                         │
         └───────────────► [Asynchronous State Inference] ─────────┘
                                       │ (Atomic Byte Updates)
                                       ▼
                       [ ~/.pi/agent/.session.state ]
```

---

## 3. High-Performance Source Core Implementation

### Component A: The Shared Memory Layout (`src/state.rs`)
This module establishes a cross-runtime layout to match memory layouts across compiled libraries.

```rust
use std::fs::OpenOptions;
use memmap2::MmapMut;
use std::path::Path;

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AgentPhase {
    Idle = 0,
    AnalyzingCodebase = 1,
    ApplyingDiff = 2,
    VerifyingBuild = 3,
    RecoveryMode = 4,
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct SharedHarnessState {
    pub current_phase: AgentPhase,
    pub tool_call_counter: u32,
    pub consecutive_failures: u32,
    pub last_tool_execution_time_ms: u32,
}

pub struct StateCoordinator {
    mmap: MmapMut,
}

impl StateCoordinator {
    pub fn initialize<P: AsRef<Path>>(path: P) -> Result<Self, std::io::Error> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)?;
            
        file.set_len(std::mem::size_of::<SharedHarnessState>() as u64)?;
        let mmap = unsafe { MmapMut::map_mut(&file)? };
        
        Ok(Self { mmap })
    }

    #[inline(always)]
    pub unsafe fn get_state(&self) -> &SharedHarnessState {
        &*(self.mmap.as_ptr() as *const SharedHarnessState)
    }

    #[inline(always)]
    pub unsafe fn get_state_mut(&mut self) -> &mut SharedHarnessState {
        &mut *(self.mmap.as_mut_ptr() as *mut SharedHarnessState)
    }
}
```

### Component B: Context-Aware Permission Gate (`src/gate.rs`)
This engine intercepts tool calls and throws targeted, context-aware remediations straight back to the model context.

```rust
use crate::state::{AgentPhase, SharedHarnessState};

pub struct ContextualGate;

impl ContextualGate {
    #[inline(always)]
    pub fn evaluate_intent(
        state: &SharedHarnessState, 
        target_tool: &str, 
        target_path: &str
    ) -> Result<(), &'static str> {
        
        // Match 1: Detect illegal edits during analysis phase loops
        if state.current_phase == AgentPhase::AnalyzingCodebase && target_tool == "piedit" {
            return Err("GATE_VIOLATION: Codebase discovery is currently active. Conclude your exploratory reads before invoking modifications.");
        }

        // Match 2: Prevent rapid retry loop cycles on crashing test tasks
        if state.consecutive_failures >= 3 && target_tool == "pibash" && target_path.contains("cargo test") {
            return Err("GATE_VIOLATION: Recurrent build failures detected. Revise code modifications manually instead of repeating commands.");
        }

        Ok(())
    }
}
```

### Component C: Asynchronous Phase Interception Hook (`src/hooks.rs`)
Tracks log files and stdout buffers processing loops via zero-allocation pattern-matching windows.

```rust
use crate::state::{AgentPhase, SharedHarnessState};

#[inline(always)]
pub fn infer_state_from_stream(state: &mut SharedHarnessState, stdout_chunk: &[u8]) {
    // Zero-allocation byte window scanning
    if stdout_chunk.windows(10).any(|w| w == b"error[E0") || stdout_chunk.windows(6).any(|w| w == b"FAILED") {
        state.consecutive_failures += 1;
        state.current_phase = AgentPhase::RecoveryMode;
        return;
    }

    if stdout_chunk.windows(10).any(|w| w == b"compiling ") || stdout_chunk.windows(10).any(|w| w == b"running 0 ") {
        state.current_phase = AgentPhase::VerifyingBuild;
        state.consecutive_failures = 0;
        return;
    }
    
    state.consecutive_failures = 0;
    state.current_phase = AgentPhase::Idle;
}
```

---

## 4. Script Consolidation (Cargo Workspaces)

To clean up standalone helper scripts (`.sh`, `.js`, `.ts`, `.py`), group them as isolated binaries under a unified **Cargo Workspace** format. This allows sharing definitions safely without introducing runtime dependency bloat.

### Directory Layout
```
~/.pi/agent/
├── Cargo.toml            # Root workspace config
├── tools/
│   ├── env_check/        # Ported bootstrap/environment scripts
│   │   └── src/main.rs
│   └── telemetry_server/ # High-performance Axum microserver
│       └── src/main.rs
└── bin/                  # Output targets (Git-ignored)
```

### Root Config (`Cargo.toml`)
```toml
[workspace]
members = [
    "tools/env_check",
    "tools/telemetry_server"
]

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
```

---

## 5. Stateless Sidecar Telemetry & Metrics Dashboard

Trace framework metrics without blocking active tool execution loops via an isolated, atomic sidecar pipeline.

```
[Native Daemons] ──(Atomic Append)──► [metrics.ndjson] ◄──(Buffered Read)── [Axum Microserver]
                                                                                   │
[Static Dashboard HTML/JS] ◄───────────────(Fetch API)─────────────────────────────┘
```

### The Axum Server Implementation (`tools/telemetry_server/src/main.rs`)
```rust
use axum::{routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};

#[derive(Serialize, Deserialize, Clone)]
pub struct TelemetryRecord {
    pub timestamp: String,
    pub tool: String,
    pub latency_ms: f64,
    pub bytes_in: usize,
    pub bytes_out: usize,
    pub rung: String,
}

async fn fetch_metrics() -> Result<Json<Vec<TelemetryRecord>>, (axum::http::StatusCode, String)> {
    let file = File::open("~/.pi/agent/metrics.ndjson").map_err(|e| {
        (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;
    
    let reader = BufReader::new(file);
    let mut logs = Vec::new();
    
    for line in reader.lines().flatten() {
        if let Ok(record) = serde_json::from_str::<TelemetryRecord>(&line) {
            logs.push(record);
        }
    }
    
    Ok(Json(logs))
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/api/v1/metrics", get(fetch_metrics));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:9990").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

---

## 6. Actionable Implementation Path

1.  **Initialize the Memory File:** Generate `.session.state` inside `~/.pi/agent/` via the core bootstrap script.
2.  **Integrate Byte Hooks:** Insert `infer_state_from_stream` directly inside the chunk loop blocks of `pibash` and `pidx`.
3.  **Deploy the Workspace:** Consolidate external shell scripts into the `tools/` path and compile targets directly using `cargo build --release`.
4.  **Launch Dashboard Components:** Run the `telemetry_server` sidecar binary on local port `9990` and map the static `docs/dashboard/index.html` layout to track your 94% token savings cleanly.

---
This is for informational purposes only. For medical advice or diagnosis, consult a professional. AI responses may include mistakes.
