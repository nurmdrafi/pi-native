// Permission-gate cases for rules.tokenEconomy (TE1, audit AB-5): linear
// one-call-per-turn chains dominate the heaviest sessions, so 5 consecutive
// single-tool-call assistant turns with no batching must ride a Token
// Economy warn carrying a batching recipe. Contract (Phase 5 T5.3):
// - delivery shape is the cadence-nudge one — appended to a PASSING
//   tool_result, never a block, surfacing by the tool_result of the 5th
//   consecutive single-call turn (earlier turns stay clean);
// - the note is recognizable by /token econom/i plus a batching recipe
//   matching /batch/i ("batch independent calls in one turn" style);
// - a turn that batches multiple independent tool calls resets the streak —
//   single-call turns before and after a batched turn never reach the warn.
// RED until the rule exists; the severity contract is pinned at `warn` in
// tests/gate/fixtures/rules-calibrated.json (a missing key defaults to
// error, which would block instead of warn).
import { runBash, noteOf, textBlocks } from "../../harness/helpers.mjs";

/** TE needle: any note text naming the Token Economy family. */
const teNote = (r) => {
  const n = noteOf(r);
  return /token econom/i.test(n) ? n : "";
};

/** One assistant turn carrying exactly ONE tool call (the unbatched shape). */
const singleCallTurn = async (pi, tag) => {
  await pi.invoke("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: `turn ${tag}`,
    systemPromptOptions: {},
  });
  return runBash(pi, `echo ${tag}`);
};

export const cases = [
  [
    "TE1: 5 consecutive single-call turns ride a Token Economy batching warn",
    "pass",
    async (pi) => {
      for (let i = 1; i <= 4; i++) {
        const r = await singleCallTurn(pi, `te-single-${i}`);
        if (r.blocked)
          return { blocked: true, reason: `single-call turn ${i} blocked: ${String(r.reason).slice(0, 80)}` };
        if (teNote(r))
          return { blocked: true, reason: `TE warn fired early, on single-call turn ${i}` };
      }
      const fifth = await singleCallTurn(pi, "te-single-5");
      if (fifth.blocked)
        return {
          blocked: true,
          reason: `5th single-call turn blocked (TE1 is a warn, never a block): ${String(fifth.reason).slice(0, 100)}`,
        };
      const n = noteOf(fifth);
      return /token econom/i.test(n) && /batch/i.test(n)
        ? { blocked: false }
        : {
            blocked: true,
            reason: `no Token Economy batching recipe on the 5th single-call turn: ${n.slice(0, 120) || "(no note)"}`,
          };
    },
  ],
  [
    "TE1: a batched turn resets the single-call streak (no warn)",
    "pass",
    async (pi) => {
      const notes = [];
      for (let i = 1; i <= 4; i++) {
        const r = await singleCallTurn(pi, `te-reset-${i}`);
        if (r.blocked)
          return { blocked: true, reason: `single-call turn ${i} blocked: ${String(r.reason).slice(0, 80)}` };
        notes.push(noteOf(r));
      }
      // one batched turn: two independent calls in the SAME assistant turn —
      // both tool_calls are issued BEFORE any result (the real harness
      // streams a message's tool_use blocks together), which is exactly the
      // batching the recipe teaches
      await pi.invoke("before_agent_start", {
        type: "before_agent_start",
        messageType: "user",
        prompt: "turn te-batch",
        systemPromptOptions: {},
      });
      const batchCall = async (id, cmd) => {
        const block = await pi.invoke(
          "tool_call",
          { type: "tool_call", toolName: "pibash", toolCallId: id, input: { command: cmd } },
          undefined,
        );
        return block ? { blocked: true, reason: block.reason } : { blocked: false };
      };
      const batchRes = async (id) => {
        const res = await pi.invoke(
          "tool_result",
          { type: "tool_result", toolName: "pibash", toolCallId: id, input: { command: "" }, content: textBlocks("out"), isError: false },
          undefined,
        );
        return { blocked: false, ...res };
      };
      const c1 = await batchCall("te-batch-1", "echo te-batch-1");
      if (c1.blocked)
        return { blocked: true, reason: `batched call 1 blocked: ${String(c1.reason).slice(0, 80)}` };
      const c2 = await batchCall("te-batch-2", "echo te-batch-2");
      if (c2.blocked)
        return { blocked: true, reason: `batched call 2 blocked: ${String(c2.reason).slice(0, 80)}` };
      const b1 = await batchRes("te-batch-1");
      notes.push(noteOf(b1));
      const b2 = await batchRes("te-batch-2");
      notes.push(noteOf(b2));
      // a fresh single-call turn right after the batch: streak restarted at 1,
      // so even as the session's 5th single-call turn it must stay unwarned
      const after = await singleCallTurn(pi, "te-reset-after");
      if (after.blocked)
        return { blocked: true, reason: `post-batch single-call turn blocked: ${String(after.reason).slice(0, 80)}` };
      notes.push(noteOf(after));
      const fired = notes.find((n) => /token econom/i.test(n));
      return fired
        ? { blocked: true, reason: `TE warn fired although the batched turn reset the streak: ${fired.slice(0, 120)}` }
        : { blocked: false };
    },
  ],
];
