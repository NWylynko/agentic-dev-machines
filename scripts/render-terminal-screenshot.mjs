// Render a captured terminal session as a PNG terminal window for the docs.
// Plain text: lines starting with "$ " are drawn as prompts.
// --ansi COLSxROWS: the input is raw PTY output (e.g. from `script`); the final screen is rendered with its colors.
// Needs google-chrome (or CHROME=path).
// Usage: node scripts/render-terminal-screenshot.mjs [--ansi 110x34] INPUT OUT.png [TITLE]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import xtermHeadless from "@xterm/headless";

const args = process.argv.slice(2);
const ansiSize = args[0] === "--ansi" ? args.splice(0, 2)[1] : null;
const [inputPath, outPath, title = "adm"] = args;
if (!inputPath || !outPath) {
  throw new Error(
    "usage: render-terminal-screenshot.mjs [--ansi COLSxROWS] INPUT OUT.png [TITLE]",
  );
}

const foreground = "#d8dae6";
const background = "#1e1f29";
// Dracula-ish 16-color palette.
const palette = [
  "#21222c",
  "#ff5555",
  "#50fa7b",
  "#f1fa8c",
  "#bd93f9",
  "#ff79c6",
  "#8be9fd",
  "#d8dae6",
  "#6272a4",
  "#ff6e6e",
  "#69ff94",
  "#ffffa5",
  "#d6acff",
  "#ff92df",
  "#a4ffff",
  "#ffffff",
];

const escapeHtml = (text) =>
  text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );

function colorOf(cell, kind) {
  const isDefault = kind === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;
  const value = kind === "fg" ? cell.getFgColor() : cell.getBgColor();
  const isRgb = kind === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) return `#${value.toString(16).padStart(6, "0")}`;
  if (value < 16) return palette[value];
  if (value < 232) {
    const level = (n) => (n === 0 ? 0 : 55 + n * 40);
    const n = value - 16;
    return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
  }
  const gray = 8 + (value - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

async function renderAnsiScreen(raw, cols, rows) {
  const terminal = new xtermHeadless.Terminal({
    cols,
    rows,
    allowProposedApi: true,
  });
  await new Promise((done) => terminal.write(raw, done));
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    let html = "";
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      let fg = colorOf(cell, "fg");
      let bg = colorOf(cell, "bg");
      if (cell.isInverse()) [fg, bg] = [bg ?? background, fg ?? foreground];
      const style = [
        fg && `color:${fg}`,
        bg && `background:${bg}`,
        cell.isBold() && "font-weight:bold",
        cell.isItalic() && "font-style:italic",
        cell.isDim() && "opacity:.6",
        cell.isUnderline() && "text-decoration:underline",
      ].filter(Boolean);
      const text = escapeHtml(cell.getChars() || " ");
      html += style.length
        ? `<span style="${style.join(";")}">${text}</span>`
        : text;
    }
    lines.push(html);
  }
  return { body: lines.join("\n"), columns: cols, rowCount: rows };
}

function renderTranscript(text) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const body = lines
    .map((line) =>
      line.startsWith("$ ")
        ? `<span style="color:${palette[2]}">$</span> <span style="color:${palette[3]}">${escapeHtml(line.slice(2))}</span>`
        : escapeHtml(line),
    )
    .join("\n");
  return {
    body,
    columns: Math.max(60, ...lines.map((line) => line.trimEnd().length)),
    rowCount: lines.length,
  };
}

const { body, columns, rowCount } = ansiSize
  ? await renderAnsiScreen(
      readFileSync(inputPath),
      ...ansiSize.split("x").map(Number),
    )
  : renderTranscript(readFileSync(inputPath, "utf8"));

const charWidth = 8.43,
  lineHeight = 19,
  pad = 20,
  bar = 36,
  margin = 20;
const width = Math.ceil(columns * charWidth + pad * 2 + margin * 2);
const height = Math.ceil(rowCount * lineHeight + pad * 2 + bar + margin * 2);

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
.w{margin:${margin}px;border-radius:10px;overflow:hidden;background:${background};box-shadow:0 8px 24px #0006;width:${width - margin * 2}px}
.b{height:${bar}px;background:#2b2d3a;display:flex;align-items:center;padding:0 14px;gap:8px;font:13px system-ui;color:#a0a3b8}
.d{width:12px;height:12px;border-radius:50%}.t{flex:1;text-align:center;margin-right:52px}
pre{margin:0;padding:${pad}px;font:14px/${lineHeight}px "DejaVu Sans Mono",Menlo,monospace;color:${foreground};white-space:pre}
</style><div class="w"><div class="b"><span class="d" style="background:#ff5f56"></span><span class="d" style="background:#ffbd2e"></span><span class="d" style="background:#27c93f"></span><span class="t">${escapeHtml(title)}</span></div><pre>${body}</pre></div>`;

const dir = mkdtempSync(join(tmpdir(), "adm-terminal-screenshot-"));
writeFileSync(join(dir, "index.html"), html);
execFileSync(
  process.env.CHROME ?? "google-chrome",
  [
    "--headless",
    "--no-sandbox",
    "--hide-scrollbars",
    "--default-background-color=00000000",
    `--window-size=${width},${height}`,
    `--screenshot=${resolve(outPath)}`,
    `file://${join(dir, "index.html")}`,
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);
console.log(`wrote ${outPath}`);
