// Usage: node scripts/chart.mjs [docs/bench.json] [docs/benchmark.svg]   (input from `node scripts/bench.mjs --fuse --json=docs/bench.json`)
import { readFileSync, writeFileSync } from "node:fs";

const [input = "docs/bench.json", output = "docs/benchmark.svg"] = process.argv.slice(2);
const { docs, results } = JSON.parse(readFileSync(input, "utf8"));

const SERIES = [["fuse", "Fuse", "#8b949e"], ["js", "fuseter/js", "#e8a33d"], ["wasm", "fuseter/wasm", "#3b8eea"], ["simd", "fuseter (simd)", "#1f9d55"]];
const MIN = 0.1, MAX = 1000, TICKS = [0.1, 1, 10, 100, 1000];
const LEFT = 175, RIGHT = 70, WIDTH = 790, BAR = 13, GAP = 2, GROUP_GAP = 14, PANEL_HEAD = 34, AXIS = 30;
const plot = WIDTH - LEFT - RIGHT;
const x = ms => LEFT + (Math.log10(Math.max(ms, MIN)) - Math.log10(MIN)) / (Math.log10(MAX) - Math.log10(MIN)) * plot;
const fmt = ms => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms)) + " ms";
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const groupHeight = SERIES.length * (BAR + GAP) - GAP;
let y = 14, body = "";
const thresholds = [...new Set(results.map(r => r.threshold))];

body += SERIES.map(([, label, color], i) => `<rect x="${LEFT + i * 140}" y="${y - 10}" width="12" height="12" rx="2" fill="${color}"/><text x="${LEFT + i * 140 + 18}" y="${y}">${label}</text>`).join("");
y += 16;

for (const threshold of thresholds) {
  const rows = results.filter(r => r.threshold === threshold);
  const panelTop = y + PANEL_HEAD, panelHeight = rows.length * (groupHeight + GROUP_GAP) - GROUP_GAP;
  body += `<text x="${LEFT - 140}" y="${y + 20}" class="head">threshold ${threshold}</text>`;
  for (const t of TICKS) body += `<line x1="${x(t)}" x2="${x(t)}" y1="${panelTop - 6}" y2="${panelTop + panelHeight + 6}" class="grid"/><text x="${x(t)}" y="${panelTop + panelHeight + 20}" text-anchor="middle" class="tick">${t} ms</text>`;
  rows.forEach((row, g) => {
    const top = panelTop + g * (groupHeight + GROUP_GAP);
    body += `<text x="${LEFT - 10}" y="${top + groupHeight / 2 + 4}" text-anchor="end">${esc(row.query.length > 24 ? row.query.slice(0, 23) + "…" : row.query)}</text>`;
    SERIES.forEach(([key, , color], i) => {
      const by = top + i * (BAR + GAP), ms = row.times[key];
      body += `<rect x="${LEFT}" y="${by}" width="${x(ms) - LEFT}" height="${BAR}" rx="2" fill="${color}"/><text x="${x(ms) + 5}" y="${by + BAR - 2}" class="value">${fmt(ms)}</text>`;
    });
  });
  y = panelTop + panelHeight + AXIS + 8;
}

const subtitle = `${docs.toLocaleString("en-US")} books, keys title and author, time per search (log scale, shorter is faster)`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${y + 24}" viewBox="0 0 ${WIDTH} ${y + 24}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">
<style>text{fill:#24292f}.head{font-size:13px;font-weight:600}.tick,.value{fill:#57606a;font-size:11px}.grid{stroke:#d0d7de;stroke-width:1}.sub{fill:#57606a;font-size:11px}</style>
<rect width="100%" height="100%" fill="#fff"/>
${body}
<text x="${LEFT - 140}" y="${y + 12}" class="sub">${subtitle}</text>
</svg>
`;
writeFileSync(output, svg);
