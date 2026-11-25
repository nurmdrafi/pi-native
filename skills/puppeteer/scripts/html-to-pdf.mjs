#!/usr/bin/env node
/**
 * HTML file -> PDF through headless Chrome, with the print-parity steps that
 * are easy to skip: a local static server for the document's assets, a wait for
 * the webfont set, and a page-count check.
 *
 *   node scripts/html-to-pdf.mjs <input.html> <output.pdf> [--public <dir>]
 *       [--margin 5] [--expect-pages 1] [--port 4321]
 *
 * See the "Print parity" section of the puppeteer skill for why each step
 * exists.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";

// Resolve puppeteer from the project being served (the caller's cwd), not from
// wherever this script file happens to live.
const requireFromCwd = createRequire(join(process.cwd(), "package.json"));
const puppeteer = requireFromCwd("puppeteer");

const TYPES = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css",
};

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const [input, output] = positional;
if (!input || !output) {
  console.error("usage: html-to-pdf.mjs <input.html> <output.pdf> [--public <dir>] [--margin 5] [--expect-pages 1]");
  process.exit(2);
}

const publicDir = resolve(flag("public", dirname(resolve(input))));
const marginMm = Number(flag("margin", "5"));
const expectedPages = Number(flag("expect-pages", "1"));
const port = Number(flag("port", "4321"));

// @font-face loads are cross-origin from a setContent document, so the asset
// server must answer CORS or Chrome prints the system fallback.
const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
  try {
    const body = await readFile(join(publicDir, path));
    response.writeHead(200, {
      "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((listening) => server.listen(port, "127.0.0.1", listening));

const browser = await puppeteer.launch({
  headless: "shell",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
});

try {
  const page = await browser.newPage();
  try {
    await page.setContent(await readFile(resolve(input), "utf8"), { waitUntil: "load", timeout: 30_000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 30_000 }).catch(() => {});
    await page.evaluate(async () => {
      await document.fonts.ready;
      return true;
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: `${marginMm}mm`, right: `${marginMm}mm`, bottom: `${marginMm}mm`, left: `${marginMm}mm` },
    });
    await writeFile(resolve(output), pdf);
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
  server.close();
}

const { execFileSync } = await import("node:child_process");
let pageCount = null;
try {
  const info = execFileSync("pdfinfo", [resolve(output)], { encoding: "utf8" });
  pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
} catch {
  // pdfinfo is optional; the PDF itself is already written.
}
if (pageCount !== null && pageCount !== expectedPages) {
  console.error(`html-to-pdf: expected ${expectedPages} page(s), got ${pageCount}`);
  process.exit(1);
}
console.log(`html-to-pdf: wrote ${output}${pageCount === null ? "" : ` (${pageCount} page(s))`}`);
