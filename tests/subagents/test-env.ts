// Unit tests must observe a clean top-level session: the spawning extension
// reads PI_SUBAGENT_* at module scope (SPAWN_TOOLS_GATED, spawn allowlist),
// so a suite launched from inside a spawned subagent — which exports those —
// would otherwise flip tool gating, agent discovery, and error paths.
// The child-runtime keys are scrubbed for the same reason, and the durable
// inbox is redirected to a tmp file: without that, a suite running inside a
// subagent inherits the real child identity and its self-reports leak into
// the live parent's inbox as phantom "recovered" results.
// Import this module FIRST (static-import side effects run in source order).
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of [
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENTS",
  "PI_SUBAGENT_ALLOWED",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_TASK",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_SURFACE",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_SUBAGENT_START_MS",
]) {
  delete process.env[key];
}
process.env.PI_SUBAGENT_INBOX ??= join(tmpdir(), "pi-subagent-test-inbox.jsonl");
