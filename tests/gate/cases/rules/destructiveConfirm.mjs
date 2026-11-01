// Permission-gate cases for rules.destructiveConfirm.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { textBlocks, lineText, read, edit, editApplied, editsApplied, bash, pibash, write, denyUi, tmp, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- H2 (2026-10-08, suite t08/t09 evidence): destructive confirm ----
  [
    "H2: rm without UI fails closed (asks in chat)",
    "blocked",
    async (pi) => bash(pi, "rm -f /tmp/x", { hasUI: false, mode: "print" }),
  ],
  [
    "H2: git reset --hard without UI fails closed",
    "blocked",
    async (pi) =>
      bash(pi, "git reset --hard HEAD~1", { hasUI: false, mode: "print" }),
  ],
  [
    "H2: npm install without UI fails closed (t08)",
    "blocked",
    async (pi) =>
      bash(pi, "npm install lodash", { hasUI: false, mode: "print" }),
  ],
  [
    "H2: destructive with UI approval passes",
    "pass",
    async (pi) => bash(pi, "git reset --hard HEAD~1"),
  ],
  [
    "H2: destructive with UI denial is blocked",
    "blocked",
    async (pi) =>
      bash(pi, "git reset --hard HEAD~1", {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => false },
      }),
  ],
  [
    "H2: approved destructive re-send skips re-confirm (2 min window)",
    "pass",
    async (pi) => {
      let asks = 0;
      const ctx = {
        hasUI: true,
        mode: "tui",
        ui: {
          confirm: async () => {
            asks++;
            return true;
          },
        },
      };
      const r1 = await bash(pi, "git reset --hard HEAD~1", ctx);
      if (r1.blocked) return { blocked: true, reason: "first reset blocked" };
      const r2 = await bash(pi, "git reset --hard HEAD~1", ctx);
      return !r2.blocked && asks === 1
        ? { blocked: false }
        : {
            blocked: true,
            reason: `asks=${asks} r2=${JSON.stringify(r2).slice(0, 80)}`,
          };
    },
  ],
  [
    "H2: commitlint runs before the permission ask",
    "blocked",
    async (pi) => {
      const r = await bash(pi, 'git commit -m "Fix the thing"'); // auto-approving UI
      return r.blocked && r.reason.startsWith("Commitlint")
        ? r
        : { blocked: false };
    },
  ],
  [
    "H2: non-destructive commands never confirm",
    "pass",
    async (pi) => {
      let asks = 0;
      const ctx = {
        hasUI: true,
        mode: "tui",
        ui: {
          confirm: async () => {
            asks++;
            return true;
          },
        },
      };
      await bash(pi, "npm test 2>&1 | tail -5", ctx);
      await bash(pi, "git pull", ctx);
      await bash(pi, "ls -la src", ctx);
      return asks === 0
        ? { blocked: false }
        : { blocked: true, reason: `confirmed ${asks}× on non-destructive` };
    },
  ],
  [
    "conventional capped commit passes",
    "pass",
    async (pi) =>
      bash(pi, 'git commit -m "fix: cap git log output" 2>&1 | tail -20'),
  ],
  [
    "H2: pipe-to-shell does not fire on hyphenated tokens (quoted rg pattern)",
    "pass",
    async (pi) =>
      bash(
        pi,
        'rg -o "AnchorGuard: [a-zA-Z- ]+|Bash-cap: [a-zA-Z- ]+|Token Economy \\([A-Za-z0-9+ ]+\\)" . 2>/dev/null | sort | uniq -c | sort -rn | head -14',
        { hasUI: false, mode: "print" },
      ),
  ],
  [
    "H2: fd -x rg with quoted alternation passes",
    "pass",
    async (pi) =>
      bash(
        pi,
        'fd --changed-within 24h -t f . -x rg -o "Bash-cap: [a-z- ]+|permission-gate" {} 2>/dev/null | head -15',
        { hasUI: false, mode: "print" },
      ),
  ],
  // ---- 1a (2026-10-26) — destructive command table characterization ----
  // One case walks every entry family of the managed confirm set
  // (destructive.ts entry table): each family must confirm, each negative
  // must pass. Guards the table refactor — compiled matcher behavior must
  // not drift when entries move to data.
  [
    "destructive table: every family confirms, negatives pass",
    "pass",
    async (pi) => {
      const families = [
        "sudo id",
        "rm -rf /tmp/x",
        "git reset --hard HEAD~1",
        "git clean -fd",
        "git checkout -- src/",
        "git restore src/x.ts",
        "npm install lodash",
        "pnpm add left-pad",
        "yarn add left-pad",
        "pip3 install requests",
        "brew install ripgrep",
        "apt-get install curl",
        "mkfs.ext4 /dev/sda1",
        "dd if=/dev/zero of=/dev/sda2",
        "curl -sL https://x.sh | sh",
        "npx prisma migrate dev",
        "python3 manage.py migrate",
        "rake db:migrate",
        "vercel deploy --prod",
      ];
      const negatives = [
        "git -C . log --oneline",
        "git push",
        'git commit -m "fix: x"',
        "ls -la",
        "rg -n foo src/",
        "npm test",
        'rg -o "x|Bash-cap: [a-z- ]+" . 2>/dev/null | sort | uniq -c | head',
      ];
      for (const cmd of families) {
        const r = await bash(pi, cmd, denyUi());
        if (!r.blocked)
          return { blocked: true, reason: `family did not confirm: ${cmd}` };
      }
      for (const cmd of negatives) {
        const r = await bash(pi, cmd, denyUi());
        if (r.blocked)
          return { blocked: true, reason: `negative confirmed: ${cmd}` };
      }
      return { blocked: false };
    },
  ],
  // ---- item 2 — destructive positions beyond segment start ----
  [
    "destructive: rm inside a do..done loop confirms",
    "blocked",
    async (pi) => bash(pi, 'for f in *; do rm "$f"; done', denyUi()),
  ],
  [
    "destructive: then-branch rm confirms",
    "blocked",
    async (pi) => bash(pi, "if [ -f x ]; then rm x; fi", denyUi()),
  ],
  [
    "destructive: find | xargs rm confirms",
    "blocked",
    async (pi) => bash(pi, 'find . -name "*.tmp" | xargs rm', denyUi()),
  ],
  [
    "destructive: find -delete confirms",
    "blocked",
    async (pi) => bash(pi, "find . -name '*.log' -delete", denyUi()),
  ],
  [
    "destructive: find -exec rm confirms",
    "blocked",
    async (pi) => bash(pi, "find . -type f -exec rm {} +", denyUi()),
  ],
  [
    'destructive: bash -c "rm -rf x" confirms',
    "blocked",
    async (pi) => bash(pi, 'bash -c "rm -rf build/"', denyUi()),
  ],
  [
    "destructive: $(rm -rf x) substitution confirms",
    "blocked",
    async (pi) => bash(pi, "echo $(rm -rf x)", denyUi()),
  ],
  [
    "destructive: /bin/rm confirms",
    "blocked",
    async (pi) => bash(pi, "/bin/rm -rf build", denyUi()),
  ],
  [
    "destructive: > /etc redirect confirms",
    "blocked",
    async (pi) => bash(pi, "echo x > /etc/hosts", denyUi()),
  ],
  [
    "destructive: psql DROP TABLE confirms",
    "blocked",
    async (pi) => bash(pi, "psql -c 'DROP TABLE users'", denyUi()),
  ],
  [
    "non-destructive: plain loop body passes",
    "pass",
    async (pi) => bash(pi, 'for s in a b; do echo "$s"; done'),
  ],
  [
    "non-destructive: bash -c echo passes",
    "pass",
    async (pi) => bash(pi, 'bash -c "echo hi"'),
  ],
  // ---- item 8 — destructive re-send re-prompts; chat approval wired ----
  [
    "item8: destructive re-send re-prompts, never Re-block",
    "blocked",
    async (pi) => {
      const cmd = "git reset --hard HEAD~1";
      let asks = 0;
      const ctx = {
        hasUI: true,
        mode: "tui",
        ui: {
          confirm: async () => {
            asks++;
            return false;
          },
        },
      };
      const id1 = `d8${nextId()}`;
      const b1 = await pi.invoke(
        "tool_call",
        {
          type: "tool_call",
          toolName: "pibash",
          toolCallId: id1,
          input: { command: cmd },
        },
        ctx,
      );
      if (!b1) return { blocked: false };
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "pibash",
        toolCallId: id1,
        input: { command: cmd },
        content: textBlocks(b1.reason),
        isError: true,
      });
      const b2 = await pi.invoke(
        "tool_call",
        {
          type: "tool_call",
          toolName: "pibash",
          toolCallId: `d8${nextId()}`,
          input: { command: cmd },
        },
        ctx,
      );
      const ok = !!b2 && !b2.reason.includes("Re-block") && asks === 2; // re-prompted, not escalated
      return ok ? { blocked: true, reason: b2.reason } : { blocked: false };
    },
  ],
  [
    "item8: chat approval unlocks headless destructive (single ask)",
    "pass",
    async (pi) => {
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: "yes, run the deploy now",
        systemPromptOptions: {},
      });
      return bash(pi, "git reset --hard HEAD~1", {
        hasUI: false,
        mode: "print",
      });
    },
  ],
  [
    "item8: a later non-approving message re-arms the confirm",
    "blocked",
    async (pi) => {
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: "yes go ahead",
        systemPromptOptions: {},
      });
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: "what does the code do?",
        systemPromptOptions: {},
      });
      return bash(pi, "git reset --hard HEAD~1", denyUi());
    },
  ],
  // ---- item 9 — scope regex ----
  [
    "commitlint: scope with slash passes (feat(api/auth))",
    "pass",
    async (pi) => bash(pi, 'git commit -m "feat(api/auth): add token refresh"'),
  ],
  [
    "commitlint: comma scope passes (fix(a,b))",
    "pass",
    async (pi) => bash(pi, 'git commit -m "fix(a,b): handle both"'),
  ],
  // ---- pibash: deeper bash-kind coverage (destructive, mutation, malformed) ----
  [
    'pibash: destructive rm -rf is blocked/confirmed like bash',
    'blocked',
    async (pi) => pibash(pi, 'rm -rf /tmp/nonexistent-pibash-probe'),
  ],
  [
    // Not a destructive rule in destructive.ts — verified against plain `bash`
    // (identical result), so this pins that pibash is neither more nor less
    // strict than bash on the same command.
    'pibash: git push --force matches bash (neither blocks)',
    'pass',
    async (pi) => pibash(pi, 'git push --force origin main'),
  ],
  [
    'pibash: reset --hard is destructive like bash',
    'blocked',
    async (pi) => pibash(pi, 'git reset --hard HEAD~1'),
  ],
  [
    'pibash: rg-first rule fires on a pibash grep',
    'pass',
    async (pi) => pibash(pi, "grep -rn 'PATTERN' src/"),
  ],
  [
    'pibash: fd-first rule fires on a pibash find',
    'pass',
    async (pi) => pibash(pi, "find . -name '*.ts'"),
  ],
  [
    'pibash: mutating command bumps mutationSeq (R10 re-arms)',
    'pass',
    async (pi) => {
      // A mutating pibash run must count as an edit for the re-run economy rules:
      // run a benign command twice, with a mutating one in between.
      await pibash(pi, "fd -e ts . rust-tools/pibash");
      const mid = await pibash(pi, "touch /tmp/pibash-mutation-probe");
      if (mid.blocked) return { blocked: true, reason: mid.reason };
      const again = await pibash(pi, "fd -e ts . rust-tools/pibash");
      return again;
    },
  ],
  [
    'pibash: missing command field is malformed-blocked',
    'blocked',
    async (pi) => {
      const block = await pi.invoke('tool_call', {
        type: 'tool_call',
        toolName: 'pibash',
        toolCallId: `tc${nextId()}`,
        input: {},
      });
      return block ? { blocked: true, reason: block.reason } : { blocked: false };
    },
  ],
  [
    'pibash: non-string command is malformed-blocked',
    'blocked',
    async (pi) => {
      const block = await pi.invoke('tool_call', {
        type: 'tool_call',
        toolName: 'pibash',
        toolCallId: `tc${nextId()}`,
        input: { command: 12345 },
      });
      return block ? { blocked: true, reason: block.reason } : { blocked: false };
    },
  ],
  [
    'pibash: read-only command passes and is not over-blocked',
    'pass',
    async (pi) => pibash(pi, 'printf hello'),
  ],
  [
    'pibash: output cap keeps the head and spills the flood',
    'pass',
    async (pi) => {
      const toolCallId = 'tc-cap-2';
      await pi.invoke('tool_call', {
        type: 'tool_call',
        toolName: 'pibash',
        toolCallId,
        input: { command: 'seq 1 500' },
      });
      const out = await pi.invoke('tool_result', {
        type: 'tool_result',
        toolName: 'pibash',
        toolCallId,
        input: { command: 'seq 1 500' },
        content: textBlocks(lineText(500)),
      });
      const serialized = JSON.stringify(out ?? {});
      if (!serialized.includes('output capped')) {
        throw new Error('H1 cap did not fire for pibash output');
      }
      if (!serialized.includes('line 1')) {
        throw new Error('cap did not keep the head of the output');
      }
      return { blocked: false };
    },
  ],
  [
    "S8 §8: write then edit keeps whole-file coverage — later edits on self-authored lines pass",
    "pass",
    async (pi) => {
      const f = join(tmp, "ag8-write-edit.ts");
      const w = await write(pi, f, lineText(60), { apply: true });
      if (w.blocked) return w;
      // this edit straddles the write's [1,∞] span — the legacy single-delta
      // shift dropped it wholesale, wiping coverage for every other line
      const e1 = await editApplied(
        pi,
        f,
        "line 30",
        "authored A\nauthored B\nauthored C",
      );
      if (e1.blocked) return e1;
      const e2 = await edit(pi, f, [
        { oldText: "line 7", newText: "line seven" },
      ]);
      if (e2.blocked) return e2;
      return edit(pi, f, [{ oldText: "line 60", newText: "line sixty" }]);
    },
  ],
  [
    "S8 §8 test-spec: line-shifting second edit still certifies the first edit's inserted text",
    "pass",
    async (pi) => {
      const f = join(tmp, "ag8-spec.ts");
      writeFileSync(f, lineText(40));
      await read(pi, f, { offset: 1, limit: 40 }, { outputLines: 40 });
      const e1 = await editApplied(
        pi,
        f,
        "line 20",
        "INSERTED ONE\nINSERTED TWO",
      );
      if (e1.blocked) return e1;
      const e2 = await editApplied(pi, f, "line 9", "line 9\nextra line");
      if (e2.blocked) return e2;
      // the session authored INSERTED ONE/TWO one edit earlier — must pass
      // with no fresh read (backlog §8 repro sequence)
      return edit(pi, f, [
        { oldText: "INSERTED ONE\nINSERTED TWO", newText: "INSERTED ONE" },
      ]);
    },
  ],
  [
    "S8 §8: multi-edit call rebases between-region spans by per-edit deltas",
    "pass",
    async (pi) => {
      const f = join(tmp, "ag8-multi.ts");
      writeFileSync(f, lineText(200));
      await read(pi, f, { offset: 45, limit: 66 }, { outputLines: 66 });
      const edits = [
        { oldText: "line 50", newText: "line 50\nn1\nn2\nn3\nn4\nn5" }, // +5 at 50
        { oldText: "line 100\nline 101", newText: "line 100" }, // −1 at 100
      ];
      const e = await editsApplied(pi, f, edits);
      if (e.blocked) return e;
      // old lines 79–80 now sit at 84–85 (below the +5 region, above the −1).
      // The certified span [45,110] straddled firstEditedLine — the legacy
      // shift dropped it entirely, so this edit M2-blocked as never-read.
      return edit(pi, f, [
        { oldText: "line 79\nline 80", newText: "line 79" },
      ]);
    },
  ],
  // ---- H2 subagent autonomy: PI_SUBAGENT_NAME set -> fail closed instantly,
  // never open a confirm dialog (children run unattended; nobody answers) ----
  [
    "H2 subagent: destructive with approving UI still blocks, spy never called",
    "blocked",
    async (pi) => {
      process.env.PI_SUBAGENT_NAME = "gate-case-sub";
      try {
        let asks = 0;
        const r = await bash(pi, "git reset --hard HEAD~1", {
          hasUI: true,
          mode: "tui",
          ui: {
            confirm: async () => {
              asks++;
              return true;
            },
          },
        });
        if (!r.blocked || asks !== 0)
          return {
            blocked: false,
            reason: `subagent destructive approved or dialoged (blocked=${r.blocked}, dialog asks=${asks})`,
          };
        return r.reason?.includes("not permitted for subagents")
          ? r
          : { blocked: false, reason: `wrong text: ${r.reason}` };
      } finally {
        delete process.env.PI_SUBAGENT_NAME;
      }
    },
  ],
  [
    "H2 subagent: destructive headless blocks with subagent text",
    "blocked",
    async (pi) => {
      process.env.PI_SUBAGENT_NAME = "gate-case-sub";
      try {
        const r = await bash(pi, "git reset --hard HEAD~1", {
          hasUI: false,
          mode: "print",
        });
        return r.blocked && r.reason?.includes("not permitted for subagents")
          ? r
          : { blocked: false, reason: `wrong outcome: ${JSON.stringify(r)}` };
      } finally {
        delete process.env.PI_SUBAGENT_NAME;
      }
    },
  ],
  [
    "H2 subagent: non-subagent with UI approval still passes (regression)",
    "pass",
    async (pi) => bash(pi, "git reset --hard HEAD~1"),
  ],
  [
    "H2 subagent: non-subagent headless still asks in chat (regression)",
    "blocked",
    async (pi) => {
      const r = await bash(pi, "git reset --hard HEAD~1", {
        hasUI: false,
        mode: "print",
      });
      return r.blocked && r.reason?.includes("ask in chat")
        ? r
        : { blocked: false, reason: `wrong outcome: ${JSON.stringify(r)}` };
    },
  ],
  // ---- 16.1 (2026-11-02): heredoc bodies are data, not commands —
  // splitSegments tracks heredoc state, so only the opener segment is
  // scanned. Live failure: three review children were blocked on /tmp
  // durability writes solely because their markdown heredoc bodies quoted
  // interpreter-escape prose from the agent docs they reviewed ----
  [
    "16.1 heredoc: body quoting interpreter-escape prose passes",
    "pass",
    async (pi) =>
      bash(
        pi,
        "cat > /tmp/progress.md <<'EOF'\n## Review notes\nThe docs mention `node --eval` and `python3 -c` as escape routes.\nEOF",
        { hasUI: false, mode: "print" },
      ),
  ],
  [
    "16.1 heredoc: opener redirect to /etc/passwd still confirms",
    "blocked",
    async (pi) =>
      bash(
        pi,
        "cat >> /etc/passwd <<EOF\nroot2:x:0:0::/root:/bin/sh\nEOF",
        denyUi(),
      ),
  ],
  [
    "16.1 heredoc: <<- delimiter strips leading tabs",
    "pass",
    async (pi) =>
      bash(
        pi,
        "cat > /tmp/notes.md <<-EOF\n\t- example uses perl -e inline\n\tEOF",
        { hasUI: false, mode: "print" },
      ),
  ],
  [
    "16.1 heredoc: quoted delimiter body with $ ; || is not split",
    "pass",
    async (pi) =>
      bash(
        pi,
        "cat > /tmp/cost.txt <<'EOF'\ncost = \\$5 || none; rm -rf / is quoted prose\nEOF",
        { hasUI: false, mode: "print" },
      ),
  ],
  [
    "16.1 heredoc: same-line continuation after the opener still scanned",
    "blocked",
    async (pi) =>
      bash(
        pi,
        "cat > /tmp/h.md <<EOF && rm -rf /tmp/old\nbody quoting node --eval prose\nEOF",
        denyUi(),
      ),
  ],
  // ---- 16.1 wave-2 (review-16a): CRLF closing, quote-shape and verb-opener
  // pins — F1 was a fail-open lane: the opener regex's \s*$ ate the opener
  // line's \r but body lines kept theirs, so `TAG\r` never matched `TAG`,
  // the heredoc never closed, and every later line was swallowed unscanned
  // (real bash includes the \r in the delimiter word and closes on line 2) ----
  [
    "16.1 heredoc: CRLF delimiter closes; post-body line scanned",
    "blocked",
    async (pi) =>
      bash(
        pi,
        "cat > /tmp/crlf.md <<EOF\r\nbody\r\nEOF\r\nrm -rf /tmp/old",
        denyUi(),
      ),
  ],
  [
    "16.1 heredoc: unterminated quote swallows the opener — one segment, passes",
    "pass",
    async (pi) =>
      bash(
        pi,
        'echo "prose; cat <<EOF\nrm -rf /tmp/old inside quotes\nEOF tail',
        { hasUI: false, mode: "print" },
      ),
  ],
  [
    "16.1 heredoc: destructive verb before the opener still confirms",
    "blocked",
    async (pi) =>
      bash(pi, "rm -rf /tmp/old <<EOF\nbody\nEOF", denyUi()),
  ],
  // ---- 16.2 (2026-11-02): symmetric decision log — one record per
  // confirm-path verdict (allow AND block, both lanes); commands are hashed,
  // never logged raw. Each case captures the file under a fake HOME (S4
  // canary pattern) so records land in a temp home, not the real one. ----
  [
    "16.2 decision log: blocked destructive call writes one block record",
    "blocked",
    async (pi) => {
      const home = mkdtempSync(join(tmpdir(), "pgate-decisions-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const r = await bash(pi, "git reset --hard HEAD~1", {
          hasUI: false,
          mode: "print",
        });
        if (!r.blocked) return { blocked: false, reason: "call was not blocked" };
        const f = join(home, ".pi", "agent", "logs", "gate-decisions.ndjson");
        if (!existsSync(f))
          return { blocked: false, reason: "no decision file under fake HOME" };
        const text = readFileSync(f, "utf8");
        const lines = text.split("\n").filter((l) => l.trim());
        if (lines.length !== 1)
          return { blocked: false, reason: `expected 1 record, got ${lines.length}` };
        const rec = JSON.parse(lines[0]);
        const wantHash = createHash("sha256")
          .update("git reset --hard HEAD~1")
          .digest("hex")
          .slice(0, 16);
        if (rec.verdict !== "block" || rec.rule !== "destructiveConfirm")
          return { blocked: false, reason: `bad verdict/rule: ${lines[0].slice(0, 100)}` };
        if (rec.commandHash !== wantHash || !/^[0-9a-f]{16}$/.test(rec.commandHash))
          return { blocked: false, reason: `bad commandHash: ${rec.commandHash}` };
        if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(rec.ts))
          return { blocked: false, reason: `bad ts: ${rec.ts}` };
        if (text.includes("git reset"))
          return { blocked: false, reason: "raw command text present in log" };
        return { blocked: true };
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    },
  ],
  [
    "16.2 decision log: subagent lane fail-closed writes a block record",
    "blocked",
    async (pi) => {
      const home = mkdtempSync(join(tmpdir(), "pgate-decisions-"));
      const prevHome = process.env.HOME;
      const hadMarker = "PI_SUBAGENT_NAME" in process.env;
      const prevMarker = process.env.PI_SUBAGENT_NAME;
      process.env.HOME = home;
      process.env.PI_SUBAGENT_NAME = "scout";
      try {
        // auto-approving UI: the subagent short-circuit must beat the ladder
        const r = await bash(pi, "git reset --hard HEAD~1");
        if (!r.blocked)
          return { blocked: false, reason: "subagent lane did not fail closed" };
        const f = join(home, ".pi", "agent", "logs", "gate-decisions.ndjson");
        if (!existsSync(f))
          return { blocked: false, reason: "no decision file under fake HOME" };
        const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
        const rec = lines.length === 1 ? JSON.parse(lines[0]) : undefined;
        if (
          !rec ||
          rec.verdict !== "block" ||
          rec.rule !== "destructiveConfirm" ||
          !/^[0-9a-f]{16}$/.test(rec.commandHash)
        )
          return {
            blocked: false,
            reason: `bad record: ${lines.join(" | ").slice(0, 120)}`,
          };
        return { blocked: true };
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (hadMarker) process.env.PI_SUBAGENT_NAME = prevMarker;
        else delete process.env.PI_SUBAGENT_NAME;
      }
    },
  ],
  [
    "16.2 decision log: allowed non-destructive call writes no record",
    "pass",
    async (pi) => {
      const home = mkdtempSync(join(tmpdir(), "pgate-decisions-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const r = await bash(pi, "ls -la src"); // benign: never reaches the confirm ladder
        if (r.blocked) return r;
        const f = join(home, ".pi", "agent", "logs", "gate-decisions.ndjson");
        if (existsSync(f))
          return { blocked: true, reason: "benign call wrote a decision record" };
        return { blocked: false };
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    },
  ],
  [
    "16.2 decision log: approved destructive call writes one allow record",
    "pass",
    async (pi) => {
      const home = mkdtempSync(join(tmpdir(), "pgate-decisions-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const r = await bash(pi, "git reset --hard HEAD~1"); // auto-approving UI
        if (r.blocked) return r;
        const f = join(home, ".pi", "agent", "logs", "gate-decisions.ndjson");
        if (!existsSync(f))
          return { blocked: true, reason: "approval left no structured record" };
        const text = readFileSync(f, "utf8");
        const lines = text.split("\n").filter((l) => l.trim());
        if (lines.length !== 1)
          return { blocked: true, reason: `expected 1 record, got ${lines.length}` };
        const rec = JSON.parse(lines[0]);
        const wantHash = createHash("sha256")
          .update("git reset --hard HEAD~1")
          .digest("hex")
          .slice(0, 16);
        if (
          rec.verdict !== "allow" ||
          rec.rule !== "destructiveConfirm" ||
          rec.commandHash !== wantHash
        )
          return { blocked: true, reason: `bad record: ${lines[0].slice(0, 100)}` };
        if (text.includes("git reset"))
          return { blocked: true, reason: "raw command text present in log" };
        return { blocked: false };
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    },
  ],
  // ---- 16.3 (2026-11-02): the inline-interpreter tripwire fires on execution,
  // not on a quoted mention. Audit lesson: `rg -n "node -e" docs` confirmed as
  // destructive although nothing runs; the token now has to sit at command
  // position (segment start, after env assignments and wrappers, or inside a
  // command substitution), so prose and search patterns stay allowed while
  // every real inline interpreter call still confirms ----
  [
    "16.3 interp inline: mention inside an rg pattern passes",
    "pass",
    async (pi) =>
      bash(pi, 'rg -n "node -e|python3 -c" docs', { hasUI: false, mode: "print" }),
  ],
  [
    "16.3 interp inline: mention as a bare log argument passes",
    "pass",
    async (pi) =>
      bash(pi, "git log --grep python3 -c", { hasUI: false, mode: "print" }),
  ],
  [
    "16.3 interp inline: node -e at segment start confirms",
    "blocked",
    async (pi) => bash(pi, 'node -e "console.log(1)"', denyUi()),
  ],
  [
    "16.3 interp inline: after a separator confirms",
    "blocked",
    async (pi) => bash(pi, "ls; node -e x", denyUi()),
  ],
  [
    "16.3 interp inline: inside a command substitution confirms",
    "blocked",
    async (pi) => bash(pi, "echo $(node -e x)", denyUi()),
  ],
  [
    "16.3 interp inline: backtick substitution confirms",
    "blocked",
    async (pi) => bash(pi, "echo `perl -e x`", denyUi()),
  ],
  [
    "16.3 interp inline: env-prefixed python -c confirms",
    "blocked",
    async (pi) => bash(pi, "FOO=1 python3 -c 'print(1)'", denyUi()),
  ],
  [
    "16.3 interp inline: sudo-wrapped node -e confirms",
    "blocked",
    async (pi) => bash(pi, "sudo node -e x", denyUi()),
  ],
];
