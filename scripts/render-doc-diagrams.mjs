// Render every docs/diagrams/*.html to docs/images/<name>.png at 2x with headless Chrome.
// Each page declares its viewport with <meta name="size" content="WIDTHxHEIGHT">.
// Needs google-chrome (or CHROME=path) and network access for the Inter web font.
// Usage: node scripts/render-doc-diagrams.mjs [NAME...]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const diagramsDir = resolve(import.meta.dirname, "../docs/diagrams");
const imagesDir = resolve(import.meta.dirname, "../docs/images");
const only = process.argv.slice(2);

for (const file of readdirSync(diagramsDir).filter((name) =>
  name.endsWith(".html"),
)) {
  const name = basename(file, ".html");
  if (only.length && !only.includes(name)) continue;
  const size = readFileSync(join(diagramsDir, file), "utf8").match(
    /<meta name="size" content="(\d+)x(\d+)">/,
  );
  if (!size)
    throw new Error(`${file} has no <meta name="size" content="WIDTHxHEIGHT">`);
  const outPath = join(imagesDir, `${name}.png`);
  execFileSync(
    process.env.CHROME ?? "google-chrome",
    [
      "--headless",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--virtual-time-budget=5000",
      "--default-background-color=00000000",
      `--window-size=${size[1]},${size[2]}`,
      `--screenshot=${outPath}`,
      `file://${join(diagramsDir, file)}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  console.log(`wrote ${outPath}`);
}
