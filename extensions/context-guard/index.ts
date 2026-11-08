/**
 * Context guard — keeps session context size visible on every turn.
 *
 * AGENTS.md asks for a compact or split past ~150K tokens, but nothing in the
 * default UI surfaces context size until the host's own auto-compaction fires
 * (contextWindow - reserveTokens, i.e. ~92% of the window). This extension
 * estimates context from the last assistant message's usage: `cacheRead` is
 * the context the provider re-read, so it tracks sent context closely; when a
 * provider reports no cache (cacheRead 0) fall back to cacheRead + input.
 *
 * An always-on widget shows "ctx 132K/200K (66%) WARN" above the editor.
 * States: OK below 60% and 120K; WARN at >=60% or >=120K; ALERT at >=75% or
 * >=150K. In ALERT a one-line reminder is emitted at most once per 10 turns
 * (UI notify, stderr in headless modes). Compaction clears the ALERT latch.
 *
 * Pure helpers are exported for source-level tests (test.mjs). Registration
 * follows the standard convention: `export default function (pi: ExtensionAPI)`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const WARN_PERCENT = 60;
const ALERT_PERCENT = 75;
const WARN_TOKENS = 120_000;
const ALERT_TOKENS = 150_000;
const REMINDER_INTERVAL_TURNS = 10;

export type GuardState = "OK" | "WARN" | "ALERT";

/**
 * Known context-window sizes by model id substring (glm-5.3: 1M per the
 * bundled pi-ai models catalog). Unknown or missing models fall back to the 200K default (adapted from the subagents extension; not
 * imported across extensions by design).
 */
export function contextWindowFor(model: string | null | undefined): number {
	if (!model) return DEFAULT_CONTEXT_WINDOW;
	const m = model.toLowerCase();
	if (m.includes("claude")) return 200_000;
	if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
	if (m.includes("gemini")) return 1_000_000;
	if (m.includes("glm")) return 1_000_000;
	return DEFAULT_CONTEXT_WINDOW;
}

/** Context proxy for one turn: cache re-read, or with input when no cache hit. */
export function proxyTokens(usage: { input: number; cacheRead: number }): number {
	return usage.cacheRead > 0 ? usage.cacheRead : usage.cacheRead + usage.input;
}

/** OK below 60% and 120K; WARN at >=60% or >=120K; ALERT at >=75% or >=150K. */
export function stateFor(tokens: number, contextWindow: number): GuardState {
	const pct = (tokens / contextWindow) * 100;
	if (pct >= ALERT_PERCENT || tokens >= ALERT_TOKENS) return "ALERT";
	if (pct >= WARN_PERCENT || tokens >= WARN_TOKENS) return "WARN";
	return "OK";
}

/** Compact token label: "132K", "0K", or "1.5M" from a million up. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/** Widget line; tokens null means "unknown until the next assistant turn". */
export function widgetLine(
	tokens: number | null,
	contextWindow: number,
	state: GuardState,
	compacted = false,
): string {
	const ctxPart =
		tokens === null ? `–/${formatTokens(contextWindow)}` : `${formatTokens(tokens)}/${formatTokens(contextWindow)}`;
	const pctPart = tokens === null ? "" : ` (${Math.round((tokens / contextWindow) * 100)}%)`;
	return `ctx ${ctxPart}${pctPart} ${state}${compacted ? " · compacted" : ""}`;
}

export default function (pi: ExtensionAPI) {
	let tokens: number | null = null;
	let window = DEFAULT_CONTEXT_WINDOW;
	let state: GuardState = "OK";
	let lastAlertTurn: number | null = null;
	let compacted = false;

	function draw(ctx: ExtensionContext): void {
		try {
			if (!ctx.hasUI) return;
			ctx.ui.setWidget("context-guard", [widgetLine(tokens, window, state, compacted)], {
				placement: "aboveEditor",
			});
		} catch {
			// The ctx goes stale once the session is torn down (headless/print-mode
			// exit). The widget is cosmetic — never crash the host from it.
		}
	}

	function remind(ctx: ExtensionContext, turnIndex: number): void {
		if (lastAlertTurn !== null && turnIndex - lastAlertTurn < REMINDER_INTERVAL_TURNS) return;
		lastAlertTurn = turnIndex;
		const line = `ctx ${formatTokens(tokens ?? 0)} past 150K budget — compact or split (AGENTS.md)`;
		try {
			if (ctx.hasUI) ctx.ui.notify(line, "warning");
			else console.error(`[context-guard] ${line}`);
		} catch {
			// Cosmetic; never break the agent loop.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// Reset latches: a loaded or reloaded session starts from a clean slate.
		tokens = null;
		window = DEFAULT_CONTEXT_WINDOW;
		state = "OK";
		lastAlertTurn = null;
		compacted = false;
		draw(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		const message = event.message;
		if (message?.role !== "assistant" || !message.usage) return;
		tokens = proxyTokens(message.usage);
		window = contextWindowFor(message.model);
		compacted = false;
		state = stateFor(tokens, window);
		if (state === "ALERT") remind(ctx, event.turnIndex);
		draw(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		// Clear the ALERT latch; true usage is unknown until the next turn.
		state = "OK";
		lastAlertTurn = null;
		tokens = null;
		compacted = true;
		draw(ctx);
	});
}
