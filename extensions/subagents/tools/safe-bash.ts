/**
 * Safe bash extension for the worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `safe_bash`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
	// 2026-11-07 audit (LOW) — blocklist depth: three families the
	// permission gate already catches (commit 1f4e67c); defense-in-depth,
	// since the worker lane does not run the gate.
	// Heredoc-to-sh: a shell interpreter fed by a heredoc runs its body as
	// commands (`bash <<EOF ... EOF`) — the body must not count as data.
	// `\b...sh\b` keeps ssh/fish out; the char class before `<<` stops a
	// chained `cat <<EOF | sh` shape from matching cat's redirect.
	/\b(?:ba|z|da|k)?sh\b[^<>|;&\n]*<<-?\s*["']?\w/,
	// -e interpreter payloads: inline code the blocklist cannot scan.
	// `sed -e`/`grep -e` never match — only interpreter words do; python's
	// inline flag is -c (-m module runs are legitimate and stay allowed).
	/\b(?:perl|ruby|php|node(?:js)?|deno|bun)\b[^|;&]*\s(?:--eval|-e)\b/,
	/\bpython3?\b[^|;&]*\s-c\b/,
	// Redirects into shell rc files: persistence on next shell start
	// (`> ~/.bashrc`, `>> $HOME/.zshrc`, absolute home spellings). The
	// terminator lookahead keeps unrelated `.profile.md`-style names out.
	/>{1,2}\s*(?:[\w.$~/-]+\/)?\.(?:bashrc|zshrc|zprofile|zshenv|bash_profile|bash_aliases|bash_login|profile|tmux\.conf|gitconfig|inputrc)\b(?=[\s&;|]|$)/,
];

function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
