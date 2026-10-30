/** H1: non-blocking bash output cap — oversized output is truncated in place
 * (head kept, oversized first line head+tail truncated), the full text spilled
 * to $TMPDIR/pgate-spill (0700/0600), pointer line appended. Zero block turns,
 * zero false positives: the model still gets the head; only the flood is cut. */
import type { ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "os";
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { BASH_CAP_BYTES, BASH_CAP_LINES } from "../bounds.gen.ts";

/** cap ceiling — whichever is hit first (2026-10-11 user feedback: 40 lines /
 * 2 KB — most terminal output is noise while a task runs; the spill pointer
 * keeps the full output reachable. Was 100 lines / 4 KB (2026-10-08).) */
const CAP_LINES = BASH_CAP_LINES;
const CAP_BYTES = BASH_CAP_BYTES;

/**
 * True when a result was already compressed by the native Rust engine
 * (pibash `compress.rs`) to the model-visible budget. Signals: the additive
 * `compression` metadata the extension forwards into `details`, or the Rust
 * omission marker in the text. When true the gate must NOT run H1 — re-truncating
 * would cut off the diagnostic lines the engine deliberately rescued.
 */
/**
 * The gate's own synthesized block text carries a family prefix. Detecting it
 * on a tool_result lets the gate skip work on results it just produced itself
 * (re-capping a block, re-reading a refusal), so this stays next to the other
 * result-inspection helpers.
 */
const BLOCK_FAMILY_RE =
  /^(Token Economy|Anchor Guard|Commitlint|Permission Gate|Toolchain|Search|Portability)[^:]*/;
export function blockFamilyOf(event: {
  isError?: boolean;
  content?: unknown[];
}): string | undefined {
  if (!event.isError) return undefined;
  const txt = (event.content as { text?: unknown }[] | undefined)?.[0]?.text;
  const m = typeof txt === "string" ? BLOCK_FAMILY_RE.exec(txt) : null;
  return m ? m[0] : undefined;
}

/**
 * Collapse the gate's own synthesized block text, so a tool_result that IS a
 * block is never re-capped into a second-generation message.
 */
export function isRustCompressed(event: {
  content?: unknown[];
  details?: unknown;
}): boolean {
  const details = event.details as { compression?: unknown } | undefined;
  if (details?.compression) return true;
  const text = (event.content ?? [])
    .filter((b) => (b as { type?: unknown })?.type === "text")
    .map((b) => String((b as { text?: unknown })?.text ?? ""))
    .join("\n");
  return /\.\.\. omitted |\.\.\. repeated /.test(text);
}

/** H1b read cap (2026-10-21): reads had NO post-cap — pibash/bash get H1's
 * 40/2KB, but a `piread`/`read` window rode straight into context (session
 * audit: piread median 1.6KB, p90 8.5KB, max 40KB; the pre-cap pidx incident
 * dumped 1.16M chars). 40 lines is too small for a code read, so the read cap
 * is looser than H1 but still bounded: 300 lines / 8KB, spill pointer kept. */
const CAP_READ_LINES = 300;
const CAP_READ_BYTES = 8_192;

/**
 * Replaces the deleted blocking viewing/dump rules (R2 viewing first;
 * R5/R6/R7/R8/verbose retire next): oversized bash output is truncated in
 * place — head kept, full output spilled to a tmp file, pointer line
 * appended. Applied via the tool_result RETURN value ({content, …}), which
 * the runner overlays onto what the model sees (emitToolResult; replacing
 * content without structuredContent drops it, so structuredContent is
 * passed through when present). Zero block turns, zero false positives: a
 * command the model legitimately needs still delivers its head; only the
 * flood is cut.
 */
/** Lines of a bash result the model actually sees — the view-credit path
 * must never certify capped-off lines. Mirrors capBashOutput's kept-loop
 * (head-only; the byte budget bites first for wide lines). */
export function visibleLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  if (lines.length <= CAP_LINES && Buffer.byteLength(text, "utf8") <= CAP_BYTES)
    return lines.length;
  let kept = 0;
  let bytes = 0;
  for (const l of lines) {
    if (kept >= CAP_LINES) break;
    const b = Buffer.byteLength(l, "utf8") + 1;
    if (bytes + b > CAP_BYTES) break;
    kept++;
    bytes += b;
  }
  return kept;
}

export function capBashOutput(event: {
  toolCallId: string;
  content?: unknown[];
  structuredContent?: unknown;
}): ToolResultEventResult | undefined {
  const blocks = event.content ?? [];
  const texts: string[] = [];
  for (const b of blocks)
    if ((b as { type?: unknown })?.type === "text")
      texts.push(String((b as { text?: unknown })?.text ?? ""));
  if (texts.length === 0) return;
  const full = texts.join("\n");
  const lines = full.split("\n");
  // 2026-10-11: count UTF-8 bytes, not UTF-16 code units — multibyte output
  // measured ~2x smaller before, so non-ASCII floods under-capped
  if (lines.length <= CAP_LINES && Buffer.byteLength(full, "utf8") <= CAP_BYTES)
    return;
  const kept: string[] = [];
  let bytes = 0;
  for (const l of lines) {
    if (kept.length >= CAP_LINES) break;
    const b = Buffer.byteLength(l, "utf8") + 1;
    if (bytes + b > CAP_BYTES) {
      // 2026-10-11: a first line larger than the whole budget used to
      // leave kept=[] — the model saw only the note. Truncate that line
      // head+tail so a long failure-summary line still carries its ends.
      if (kept.length === 0 && l) {
        const buf = Buffer.from(l, "utf8");
        const half = Math.max(64, Math.floor((CAP_BYTES - 64) / 2));
        kept.push(
          `${buf.subarray(0, half).toString("utf8")} … [line truncated: ${buf.length} B] … ${buf.subarray(Math.max(half, buf.length - half)).toString("utf8")}`,
        );
      }
      break;
    }
    kept.push(l);
    bytes += b;
  }
  let note = `… [output capped: kept ${kept.length}/${lines.length} lines]`;
  try {
    // 2026-10-11: toolCallId is foreign text — sanitize it for the spill
    // filename (path traversal), and create dir/file 0700/0600 (spills
    // hold command output)
    const safeId = String(event.toolCallId).replace(/[^A-Za-z0-9._-]/g, "_");
    const spillDir = join(tmpdir(), "pgate-spill");
    const spill = join(spillDir, `${safeId}.txt`);
    mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    writeFileSync(spill, full, { mode: 0o600 });
    // hygiene (2026-10-08): long-lived sessions accumulate spills — prune
    // entries older than 24h, bounded to 50 unlinks per cap so latency stays
    // flat; best-effort, never blocks the result path
    try {
      const cutoff = Date.now() - 24 * 60 * 60_000;
      let pruned = 0;
      for (const f of readdirSync(spillDir)) {
        if (pruned >= 50) break;
        const p = join(spillDir, f);
        const s = statSync(p);
        if (s.isFile() && s.mtimeMs < cutoff) {
          unlinkSync(p);
          pruned++;
        }
      }
    } catch {
      // pruning is hygiene only
    }
    note = `… [output capped: kept ${kept.length}/${lines.length} lines — full output in ${spill}; read it with offset/limit if needed]`;
  } catch {
    // spill is best-effort; truncation alone still caps the flood
  }
  const content: ToolResultEventResult["content"] = blocks.filter(
    (b) => (b as { type?: unknown })?.type !== "text",
  ) as NonNullable<ToolResultEventResult["content"]>;
  content.push({ type: "text", text: `${kept.join("\n")}\n${note}` });
  const out: ToolResultEventResult = { content };
  if (event.structuredContent !== undefined)
    out.structuredContent =
      event.structuredContent as ToolResultEventResult["structuredContent"];
  return out;
}

/**
 * H1b: non-blocking cap for read results (piread and the built-in `read`).
 * Mirrors capBashOutput with a looser ceiling (300 lines / 8KB) so a normal
 * code window still lands whole while a flood is cut and spilled. Returns
 * undefined when the result is already within budget or carries no text, so
 * the caller overlays nothing.
 */
export function capReadOutput(event: {
  toolCallId: string;
  content?: unknown[];
  structuredContent?: unknown;
}): ToolResultEventResult | undefined {
  const blocks = event.content ?? [];
  const texts: string[] = [];
  for (const b of blocks)
    if ((b as { type?: unknown })?.type === "text")
      texts.push(String((b as { text?: unknown })?.text ?? ""));
  if (texts.length === 0) return;
  const full = texts.join("\n");
  const lines = full.split("\n");
  if (
    lines.length <= CAP_READ_LINES &&
    Buffer.byteLength(full, "utf8") <= CAP_READ_BYTES
  )
    return;
  const kept: string[] = [];
  let bytes = 0;
  for (const l of lines) {
    if (kept.length >= CAP_READ_LINES) break;
    const b = Buffer.byteLength(l, "utf8") + 1;
    if (bytes + b > CAP_READ_BYTES) {
      if (kept.length === 0 && l) {
        const buf = Buffer.from(l, "utf8");
        const half = Math.max(64, Math.floor((CAP_READ_BYTES - 64) / 2));
        kept.push(
          `${buf.subarray(0, half).toString("utf8")} … [line truncated: ${buf.length} B] … ${buf.subarray(Math.max(half, buf.length - half)).toString("utf8")}`,
        );
      }
      break;
    }
    kept.push(l);
    bytes += b;
  }
  let note = `… [read capped: kept ${kept.length}/${lines.length} lines]`;
  try {
    const safeId = String(event.toolCallId).replace(/[^A-Za-z0-9._-]/g, "_");
    const spillDir = join(tmpdir(), "pgate-spill");
    const spill = join(spillDir, `${safeId}.txt`);
    mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    writeFileSync(spill, full, { mode: 0o600 });
    try {
      const cutoff = Date.now() - 24 * 60 * 60_000;
      let pruned = 0;
      for (const f of readdirSync(spillDir)) {
        if (pruned >= 50) break;
        const p = join(spillDir, f);
        const s = statSync(p);
        if (s.isFile() && s.mtimeMs < cutoff) {
          unlinkSync(p);
          pruned++;
        }
      }
    } catch {
      // pruning is hygiene only
    }
    note = `… [read capped: kept ${kept.length}/${lines.length} lines — full text in ${spill}; read it with offset/limit if needed]`;
  } catch {
    // spill is best-effort; truncation alone still caps the flood
  }
  const content: ToolResultEventResult["content"] = blocks.filter(
    (b) => (b as { type?: unknown })?.type !== "text",
  ) as NonNullable<ToolResultEventResult["content"]>;
  content.push({ type: "text", text: `${kept.join("\n")}\n${note}` });
  const out: ToolResultEventResult = { content };
  if (event.structuredContent !== undefined)
    out.structuredContent =
      event.structuredContent as ToolResultEventResult["structuredContent"];
  return out;
}
