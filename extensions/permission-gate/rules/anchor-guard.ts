/** Anchor Guard (AG): edit-call oldText pre-validation — existence (exact +
 * fuzzy), uniqueness with line numbers, intra-call overlap — with actual file
 * context on a miss so the model fixes its anchor in one retry. Also derives
 * the post-application line spans R1 certifies, the pre-edit stat (drift
 * check) and whether any anchor matched only fuzzily. */
import { readFile } from "fs/promises";
import { hashText, normPath, snapshot } from "./read-coverage.ts";
import type { CoverageEntry, LineSpan } from "./read-coverage.ts";

export interface EditEntry {
  oldText: string;
  newText: string;
}

/** Mirror of edit-diff.js normalizeForFuzzyMatch: trailing ws, NFKC, smart quotes/dashes/spaces */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export const toLF = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** 1-based line number of a character index (line boundaries survive normalization) */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++)
    if (content[i] === "\n") line++;
  return line;
}

function snippetAround(
  content: string,
  line: number,
  spanLines: number,
  pad = 2,
  maxLines = 8,
): string {
  const lines = content.split("\n");
  const start = Math.max(1, line - pad);
  const end = Math.min(lines.length, line + spanLines + pad - 1);
  const shown = Math.min(end, start + maxLines - 1);
  const width = String(shown).length;
  const parts: string[] = [];
  for (let n = start; n <= shown; n++)
    parts.push(`${String(n).padStart(width)} | ${lines[n - 1]}`);
  if (shown < end) parts.push("…");
  return parts.join("\n");
}

/** Longest run of anchor lines (from the tail, else the head) that exists in fuzzyContent */
function findClosestFragment(
  fuzzyContent: string,
  oldText: string,
): { index: number; lines: number; end: "tail" | "head" } | undefined {
  const lines = oldText.split("\n");
  for (let take = lines.length; take >= 1; take--) {
    const tail = normalizeForFuzzyMatch(
      lines.slice(lines.length - take).join("\n"),
    );
    if (tail.trim()) {
      const index = fuzzyContent.indexOf(tail);
      if (index !== -1) return { index, lines: take, end: "tail" };
    }
    const head = normalizeForFuzzyMatch(lines.slice(0, take).join("\n"));
    if (head.trim()) {
      const index = fuzzyContent.indexOf(head);
      if (index !== -1) return { index, lines: take, end: "head" };
    }
  }
  return undefined;
}

/**
 * Validates an edit call's anchors; returns a block (with corrective context)
 * or the call's post-application edited line spans (exact-match anchors only)
 * if ok.
 */
export async function validateEditAnchors(
  input: {
    path?: unknown;
    edits?: unknown;
  },
  cwd?: string,
  cov?: CoverageEntry,
  /** AG2 (editRegionGuard): when false, the M2 check downgrades to
   * Claude-Code parity — the path having been read this session suffices;
   * the per-anchor region-intersect is skipped. Never-read still blocks. */
  regionGuard = true,
  /** Lines this session's own search PRINTED for this path (2026-10-27).
   * Printed rows are content in context, like a read span: a
   * bulk edit anchored on a line rg just showed must not pay a piread for
   * text already on screen. Path-only seeds (`rg -l`, `wc -l`) carry no lines
   * and certify nothing. */
  searchShown?: Set<number>,
): Promise<
  | {
      block: true;
      reason: string;
      stale?: boolean;
      /** Which config key owns the decision: AG (hard) or AG2 (relaxable). */
      rule?: "editAnchorGuard" | "editRegionGuard";
    }
  | {
      spans?: LineSpan[];
      origSpans?: { i: number; start: number; end: number }[];
      firstEditedLine?: number;
      regions?: { start: number; end: number; delta: number }[];
      delta?: number;
      preStat?: { mtimeMs: number; size: number };
      fuzzy?: boolean;
    }
  | undefined
> {
  const edits = input.edits;
  if (!Array.isArray(edits)) return; // let the tool's own validation respond

  const absPath = normPath(input.path, cwd);
  const display = String(input.path ?? "");
  let content: string;
  try {
    const raw = await readFile(absPath, "utf8");
    content = toLF(raw).replace(/^\uFEFF/, "");
  } catch {
    return; // unreadable/missing file: the edit tool reports it
  }
  // item 6 (2026-10-11): pre-edit stat — the tool_result compares it against
  // the coverage snapshot to drop externally-drifted spans instead of
  // re-validating them against the post-edit file
  const preStat = await snapshot(absPath);

  // S5 M1 (2026-10-16): stale-bind. The coverage entry's stat is the last
  // content this session certified into context; if the file drifted since
  // (external writer: bash, git, watcher), the anchors were built against
  // old bytes — one that still matches SOMEWHERE in the drifted file lands
  // silently in the wrong place. Block before matching; the fix is one
  // targeted re-read. Missing entry/stat fails open like the existing
  // freshness posture (spec §5.1); M2 owns the never-read case.
  if (
    cov?.stat &&
    preStat &&
    (cov.stat.mtimeMs !== preStat.mtimeMs || cov.stat.size !== preStat.size)
  ) {
    const shown = display.length > 57 ? `…${display.slice(-56)}` : display;
    return {
      block: true,
      reason: `Anchor Guard (Stale): '${shown}' changed on disk since your last read (mtime/size) — re-read the region with the piread tool (path/offset/limit), then re-send the edit.`,
    };
  }

  // S5 M3 (2026-10-16): content-hash chain — closes the same-stat tail M1
  // cannot see (sub-ms same-size writes, deliberate utimes/touch -r
  // restores). Both sides hash the same normalized view; entries never
  // carry a hash above the 1 MiB cap (hashFile), so the compare self-skips
  // there, and plain reads store no hash (spec §5.3) — the read→same-stat-
  // drift→edit tail stays stat-only (residual R2). A block carries
  // stale: true so the caller drops the (now disproven) coverage entry —
  // otherwise R1 would block the corrective re-read as a dup-read.
  if (cov?.hash && cov.hash !== hashText(content)) {
    const shown = display.length > 57 ? `…${display.slice(-56)}` : display;
    return {
      block: true,
      stale: true,
      reason: `Anchor Guard (Stale): '${shown}' changed without mtime/size change (fast write / restored mtime) — re-read with the piread tool before editing.`,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  // verified exact-match spans, for the intra-call overlap check
  const spans: { i: number; start: number; end: number }[] = [];
  // fuzzy-matched anchors contribute no span (index only exists in normalized
  // space) — and mark the call fuzzy so tool_result drops the path's coverage
  // instead of certifying line math that skipped them (2026-10-11)
  let fuzzyUsed = false;

  for (let i = 0; i < edits.length; i++) {
    const oldText = toLF(String((edits[i] as EditEntry)?.oldText ?? ""));
    if (!oldText) continue; // tool has a dedicated empty-oldText error

    const exact = content.indexOf(oldText);
    const fuzzy = exact === -1 ? normalizeForFuzzyMatch(oldText) : "";

    if (exact === -1 && fuzzyContent.indexOf(fuzzy) === -1) {
      const frag = findClosestFragment(fuzzyContent, oldText);
      // frag.end is the matched EDGE ("head"|"tail"), not a count: report the
      // line count plus which edge matched, so the hint is actionable.
      const edge = frag?.end === "head" ? "first" : "last";
      const near = frag
        ? `Its ${edge} ${frag.lines} line(s) occur at line ${lineOf(fuzzyContent, frag.index)}; the inferred lines around them are wrong:\n${snippetAround(content, lineOf(fuzzyContent, frag.index), frag.lines)}\nUse these exact lines (incl. whitespace) as oldText.`
        : `No part exists — rebuild oldText from the window already in context; use the piread tool (path/offset/limit) only for a region not yet in context.`;
      return {
        block: true,
        reason: `Anchor Guard: edits[${i}].oldText not found in ${String(input.path)} (exact+fuzzy). ${near}`,
      };
    }

    // uniqueness (mirror of the tool's duplicate check) with line numbers
    const probe = exact !== -1 ? oldText : fuzzy;
    const haystack = exact !== -1 ? content : fuzzyContent;
    const occurrences: number[] = [];
    let at = haystack.indexOf(probe);
    while (at !== -1) {
      occurrences.push(lineOf(haystack, at));
      at = haystack.indexOf(probe, at + 1);
    }
    if (occurrences.length > 1) {
      return {
        block: true,
        reason:
          `Anchor Guard: edits[${i}].oldText occurs ${occurrences.length}× in ${String(input.path)} ` +
          `(lines ${occurrences.join(", ")}). Widen the anchor with adjacent lines until unique.`,
      };
    }

    // overlap (exact matches only — fuzzy indices live in normalized space)
    if (exact !== -1) {
      const start = exact;
      const end = exact + oldText.length;
      for (const s of spans) {
        if (start < s.end && s.start < end) {
          return {
            block: true,
            reason:
              `Anchor Guard: edits[${s.i}] and edits[${i}] overlap in ${String(input.path)} — ` +
              `the edit tool rejects overlapping edits. Merge into one edit (or disjoint anchors).`,
          };
        }
      }
      spans.push({ i, start, end });
    } else {
      fuzzyUsed = true; // this anchor matched only after normalization
    }
  }

  // H9/B3 (2026-10-08): edits[] are applied as ONE overlay against the
  // ORIGINAL file — a span's post-edit line depends on edits EARLIER IN THE
  // FILE, not on array order (the old in-loop delta accumulated array order
  // and mis-certified out-of-order calls). Position-sort, then fold deltas.
  // B4: also report the first edited ORIGINAL line — tool_result truncates
  // stale coverage at it, because every line below a line-count-changing
  // edit shifted and old spans there describe different content.
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const edited: LineSpan[] = [];
  // S5 M2 (2026-10-16): ORIGINAL 1-based line span per exact anchor — the
  // region whose certified presence in context M2 requires (spec §5.2)
  const origSpans: { i: number; start: number; end: number }[] = [];
  let delta = 0;
  let firstEditedLine = Infinity;
  for (const s of sorted) {
    const oldLines = toLF(
      String((edits[s.i] as EditEntry)?.oldText ?? ""),
    ).split("\n").length;
    const newLines = String((edits[s.i] as EditEntry)?.newText ?? "").split(
      "\n",
    ).length;
    const oStart = lineOf(content, s.start);
    origSpans.push({ i: s.i, start: oStart, end: oStart + oldLines - 1 });
    if (oStart < firstEditedLine) firstEditedLine = oStart;
    const eStart = oStart + delta;
    edited.push({ start: eStart, end: eStart + newLines - 1 });
    delta += newLines - oldLines;
  }

  // S5 M2 (2026-10-16): region-read requirement. An edit is bound to content
  // the session actually certified: no coverage at all → the anchors came
  // from assumption or bash output (the luck-match silent-corruption class);
  // a region-intersect miss → the anchor's lines were never in context.
  // Fuzzy anchors carry no original span (indices live in normalized space)
  // — existence of coverage suffices for them (residual R3). Coordinate
  // spaces align: M1/M3 just proved the file identical to the latest
  // certification, and spans truncated at firstEditedLine kept only
  // unshifted lines (spec §5.2 alignment argument).
  {
    const shown = display.length > 57 ? `…${display.slice(-56)}` : display;
    // fuzzy anchors carry no original span (normalized space) — no line can be
    // matched against a printed row, so they stay on the read requirement
    const shownHit = (start: number, end: number) => {
      for (const l of searchShown ?? [])
        if (l >= start && l <= end) return true;
      return false;
    };
    if (!cov) {
      const first = origSpans[0];
      if (!first || !shownHit(first.start, first.end)) {
        // A search that named this path but landed outside the target lines is
        // the usual dead end: the block is correct (nobody certified those
        // lines), yet it reads like a conflict with Locate-first. Name the line
        // the search did hit so the remedy is obvious instead of looking like a
        // loop between the two rules.
        const nearest = [...(searchShown ?? [])].reduce<number | undefined>(
          (best, l) =>
            first === undefined || best === undefined
              ? (best ?? l)
              : Math.abs(l - first.start) < Math.abs(best - first.start)
                ? l
                : best,
          undefined,
        );
        const why =
          first !== undefined && nearest !== undefined
            ? ` Your search on this path hit line ${nearest}, outside ${first.start}–${first.end}.`
            : "";
        return {
          block: true,
          reason:
            `Anchor Guard (Unread): '${shown}' not read this session — ` +
            (first
              ? `read lines ${first.start}–${first.end} with the piread tool (piread {path:'${String(input.path)}', offset:${first.start}, limit:${first.end - first.start + 1}}) first.`
              : `read it with the piread tool (piread {path:'${String(input.path)}'}) first.`) +
            why,
        };
      }
    }
    if (regionGuard)
      for (const os of origSpans) {
        const covered =
          (cov?.spans.some(
            (cs) => cs.start <= os.end && os.start <= cs.end,
          ) ??
            false) || shownHit(os.start, os.end);
        if (!covered) {
          // C2: when the target sits in a recorded compaction gap, say so —
          // the remedy read is sanctioned (R1 blocks only fully covered
          // windows), so the gap marker must not read as a "never re-read"
          // instruction (SYSTEM.md Re-reads).
          const inGap = cov?.gaps?.some(
            (g) => g.start <= os.end && os.start <= g.end,
          );
          return {
            block: true,
            rule: "editRegionGuard",
            reason:
              `Anchor Guard (Unread): '${shown}' edits[${os.i}] targets lines ` +
              `${os.start}–${os.end}, not in certified context — read lines ` +
              `${os.start}–${os.end} with the piread tool ` +
              `(piread {path:'${String(input.path)}', offset:${os.start}, limit:${os.end - os.start + 1}}) first.` +
              (inGap
                ? " The target falls in a compaction gap — this sub-window read is permitted (uncertified lines are never re-reads)."
                : ""),
          };
        }
      }
  }

  return {
    spans: edited.length ? edited : undefined,
    origSpans: origSpans.length ? origSpans : undefined,
    // backlog §8: per-edit ORIGINAL regions + deltas — tool_result rebases
    // prior certified spans by the regions above each span (not one total
    // delta) and splits straddlers instead of dropping them
    regions: origSpans.length
      ? origSpans.map((os) => {
          const newLines = String(
            (edits[os.i] as EditEntry)?.newText ?? "",
          )
            .split("\n")
            .length;
          return {
            start: os.start,
            end: os.end,
            delta: newLines - (os.end - os.start + 1),
          };
        })
      : undefined,
    firstEditedLine:
      edited.length && firstEditedLine !== Infinity
        ? firstEditedLine
        : undefined,
    preStat,
    fuzzy: fuzzyUsed || undefined,
    delta: edited.length ? delta : undefined,
  }; // all anchors verified: let the edit proceed
}
