#!/usr/bin/env node
/**
 * Screenshot archify diagram HTML files to dual-theme PNG snapshots for
 * inline markdown embedding (GitHub strips scripts, so only the static
 * image renders inline; the HTML stays linked for the interactive view).
 * Uses the viewer's embed mode (no toolbar, diagram gets the viewport)
 * and theme query parameter; markdown embeds both via a <picture> block.
 *
 * Usage: node scripts/render-diagram-pngs.mjs [diagrams-dir]
 * Regenerate after changing any diagram JSON/HTML.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const CHROME = "/usr/bin/google-chrome";
const THEMES = ["light", "dark"];
const dir = resolve(process.argv[2] ?? join("docs", "assets", "diagrams"));

const htmls = readdirSync(dir).filter((f) => f.endsWith(".html"));
if (htmls.length === 0) {
  console.error(`no diagram HTML files in ${dir}`);
  process.exit(1);
}

for (const f of htmls) {
  for (const theme of THEMES) {
    const stem = f.replace(/\.html$/, "");
    const png = join(dir, `${stem}-${theme}.png`);
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        `--screenshot=${png}`,
        "--window-size=1600,900",
        "--force-device-scale-factor=2",
        "--virtual-time-budget=8000",
        "--hide-scrollbars",
        `file://${join(dir, f)}?embed=1&theme=${theme}`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const kb = Math.round(statSync(png).size / 1024);
    console.log(`${f} [${theme}] -> ${png} (${kb} KB)`);
  }
}
