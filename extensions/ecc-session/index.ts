import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMAND = "ecc-session";
const HOOK_FLAG = "ECC_DISABLED_HOOKS";
const HOOK_ID = "session:start";
const CHOICES = ["on", "off"] as const;
type Choice = (typeof CHOICES)[number];

function isChoice(value: string): value is Choice {
  return CHOICES.some((choice) => choice === value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPreference(path: string): Choice | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (isChoice(value)) return value;
    process.emitWarning(`${COMMAND}: invalid saved preference; leaving ECC hook flags unchanged`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.emitWarning(`${COMMAND}: could not read preference: ${errorText(error)}`);
    }
  }
}

async function savePreference(path: string, choice: Choice): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, `${choice}\n`, { flag: "wx" });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export default function eccSession(pi: ExtensionAPI): void {
  const path = join(getAgentDir(), ".cache", COMMAND);
  const saved = readPreference(path);
  // Pi loads extension factories before session_start. ECC reads these flags
  // when its hook runs, not when its own factory loads.
  if (saved !== undefined) {
    const otherIds = (process.env[HOOK_FLAG] ?? "").split(",").map((id) => id.trim())
      .filter((id) => id && id.toLowerCase() !== HOOK_ID);
    process.env[HOOK_FLAG] = (saved === "off" ? [...otherIds, HOOK_ID] : otherIds).join(",");
  }

  pi.registerCommand(COMMAND, {
    description: "Enable or skip the ECC session-start hook on future launches",
    getArgumentCompletions(prefix) {
      const matches = CHOICES.filter((choice) => choice.startsWith(prefix));
      return matches.length ? matches.map((choice) => ({ value: choice, label: choice })) : null;
    },
    async handler(args, ctx) {
      const choice = args.trim();
      if (!isChoice(choice)) {
        ctx.ui.notify(`Usage: /${COMMAND} ${CHOICES.join(" | ")}`, "warning");
        return;
      }
      try {
        await savePreference(path, choice);
        ctx.ui.notify(`ECC startup hook: ${choice} on next Pi launch.`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save ECC startup preference: ${errorText(error)}`, "error");
      }
    },
  });
}
