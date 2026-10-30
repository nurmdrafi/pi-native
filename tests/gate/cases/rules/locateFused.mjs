// Permission-gate cases for the fused piread locate+read path: read-coverage
// certification and R1c hit anchoring run off the structured `details.locate`
// field, never off rendered-text line counting. Attribution is by section —
// these primarily assert fused-read certification, so they form their own
// family beside the rule modules.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { read, piread, edit, hydrate, lineText, tmp } from "../../harness/helpers.mjs";

// One fused call shape reused across cases: needle hit at line 50, printed
// window 38-62, file is 200 lines.
const fusedFile = join(tmp, "lf-fused.ts");
writeFileSync(fusedFile, lineText(200));
const fusedLoc = {
  needle: "line 50",
  hits: [50],
  hitsTotal: 1,
  windows: [[38, 62]],
  totalLines: 200,
};
const fusedCall = (pi) =>
  piread(pi, fusedFile, { hits: "line 50" }, { locate: fusedLoc, outputLines: 25 });

// Two disjoint windows: the span between them must stay unread.
const twoFile = join(tmp, "lf-two.ts");
writeFileSync(twoFile, lineText(100));
const twoLoc = {
  needle: "line 15",
  hits: [15, 55],
  hitsTotal: 2,
  windows: [[10, 20], [50, 60]],
  totalLines: 100,
};

// Never searched by any command: R1c anchor decisions rest on the fused seed.
const wideFile = join(tmp, "lf-wide.ts");
writeFileSync(wideFile, lineText(400));
const wideLoc = {
  needle: "line 200",
  hits: [200],
  hitsTotal: 1,
  windows: [[188, 212]],
  totalLines: 400,
};

// Replayed (resume hydration) fused read: windows 28-52 of a 200-line file.
const hydFile = join(tmp, "lf-hyd.ts");
writeFileSync(hydFile, lineText(200));

export const cases = [
  [
    "LF: fused read certifies its printed windows (in-window edit passes)",
    "pass",
    async (pi) => {
      await fusedCall(pi);
      return edit(pi, fusedFile, [{ oldText: "line 45", newText: "x" }]);
    },
  ],
  [
    "LF: lines outside fused windows stay unread (gap edit blocked)",
    "blocked",
    async (pi) => {
      await fusedCall(pi);
      return edit(pi, fusedFile, [{ oldText: "line 100", newText: "x" }]);
    },
  ],
  [
    "LF: the span between two fused windows stays unread",
    "blocked",
    async (pi) => {
      await piread(pi, twoFile, { hits: "line 15" }, { locate: twoLoc, outputLines: 22 });
      return edit(pi, twoFile, [{ oldText: "line 35", newText: "x" }]);
    },
  ],
  [
    "LF: fused miss certifies nothing (later window read is no duplicate)",
    "pass",
    async (pi) => {
      await piread(
        pi,
        fusedFile,
        { hits: "nope" },
        {
          locate: { needle: "nope", hits: [], hitsTotal: 0, windows: [], totalLines: 200 },
          outputLines: 0,
        },
      );
      // nothing certified: an ordinary read of any window must stay
      // legitimate — whole-file certification would make it an R1 duplicate
      return read(pi, fusedFile, { offset: 150, limit: 5 }, { outputLines: 5 });
    },
  ],
  [
    "LF: fused result with no locate payload certifies nothing (fail-closed)",
    "pass",
    async (pi) => {
      await piread(pi, fusedFile, { hits: "line 50" }, { outputLines: 25 });
      return read(pi, fusedFile, { offset: 150, limit: 5 }, { outputLines: 5 });
    },
  ],
  [
    "LF: malformed locate payload certifies nothing",
    "pass",
    async (pi) => {
      await piread(
        pi,
        fusedFile,
        { hits: "line 50" },
        {
          locate: { needle: "line 50", hits: [50], windows: "nope", totalLines: 200 },
          outputLines: 25,
        },
      );
      return read(pi, fusedFile, { offset: 150, limit: 5 }, { outputLines: 5 });
    },
  ],
  [
    "LF: fused hits seed the search-hit store (wide read over a hit passes)",
    "pass",
    async (pi) => {
      await piread(pi, wideFile, { hits: "line 200" }, { locate: wideLoc, outputLines: 25 });
      return read(pi, wideFile, { offset: 150, limit: 120 }, { outputLines: 120 });
    },
  ],
  [
    "LF: fused miss anchors nothing — a wide read still wants locate (R1c)",
    "blocked",
    async (pi) => {
      await piread(
        pi,
        wideFile,
        { hits: "nope" },
        {
          locate: { needle: "nope", hits: [], hitsTotal: 0, windows: [], totalLines: 400 },
          outputLines: 0,
        },
      );
      return read(pi, wideFile, { offset: 250, limit: 120 }, { outputLines: 120 });
    },
  ],
  [
    "LF: resume hydration replays fused windows, not the whole file",
    "pass",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "piread", callId: "c1", path: hydFile, args: { hits: "line 40" } },
        {
          id: "e2",
          resultFor: "c1",
          tool: "piread",
          text: lineText(25),
          details: {
            locate: { needle: "line 40", hits: [40], hitsTotal: 1, windows: [[28, 52]], totalLines: 200 },
          },
        },
      ]);
      return read(pi, hydFile, { offset: 100, limit: 3 }, { outputLines: 3 });
    },
  ],
];
