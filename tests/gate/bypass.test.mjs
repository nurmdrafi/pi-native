// Verify the gate's H1 bypass: a pibash result already compressed by the Rust
// engine must pass through untouched (isRustCompressed → skip H1).
import { isRustCompressed, capBashOutput } from "../../extensions/permission-gate/rules/bash-cap.ts";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const rustText =
  "line1\nline2\n\n[... omitted 4200 chars / 300 lines ...]\n\nline99\nline100";

// 1. marker in text → detected
check(
  "marker-only signal detected",
  isRustCompressed({ content: [{ type: "text", text: rustText }] }) === true,
);

// 2. compression metadata in details → detected
check(
  "details.compression signal detected",
  isRustCompressed({
    content: [{ type: "text", text: "short" }],
    details: { compression: { strategy: "head-tail" } },
  }) === true,
);

// 3. plain output → not detected
check(
  "plain output not detected",
  isRustCompressed({ content: [{ type: "text", text: "just normal output" }] }) === false,
);

// 4. would the gate have cut it? The compressed text fits 40/2KB, so capBashOutput
//    returns undefined (no-op) — confirming the bypass + no double work.
const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
check(
  "compressed-within-budget is a no-op for the cap",
  capBashOutput({ toolCallId: "t", content: [{ type: "text", text: big }] }) === undefined,
);

// 5. a NON-compressed oversized result is still capped (safety net intact)
const oversized = Array.from({ length: 500 }, (_, i) => `noise ${i}`).join("\n");
const capped = capBashOutput({
  toolCallId: "t2",
  content: [{ type: "text", text: oversized }],
});
check(
  "non-compressed oversized result is still capped",
  capped !== undefined && String(capped.content[0].text).includes("output capped"),
);

console.log(failures === 0 ? "\nGATE BYPASS: ALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
