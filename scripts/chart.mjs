// Usage: node scripts/chart.mjs [docs/bench.json] [outdir=docs]   (input from `node scripts/bench.mjs --fuse --json=docs/bench.json`)
// Writes benchmark.svg (Fuse against the three tiers) and benchmark-tiers.svg (the tiers only), both on linear axes.
import { readFileSync, writeFileSync } from "node:fs";

const [input = "docs/bench.json", outdir = "docs"] = process.argv.slice(2);
const { docs, results } = JSON.parse(readFileSync(input, "utf8"));
const THRESHOLD = 0.3;

const SERIES = {
  fuse: ["Fuse", "#8b949e"],
  js: ["fuseter/js", "#e8a33d"],
  wasm: ["fuseter/wasm", "#3b8eea"],
  simd: ["fuseter (simd)", "#1f9d55"],
};
const LEFT = 195, RIGHT = 70, WIDTH = 760, BAR = 14, GAP = 3, GROUP_GAP = 16;
const plot = WIDTH - LEFT - RIGHT;
const fmt = ms => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms)) + " ms";
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const label = q => (q.length > 30 ? q.slice(0, 29) + "…" : q);

function chart({ series, queries, max, step }) {
  const x = ms => LEFT + ms / max * plot;
  const groupHeight = series.length * (BAR + GAP) - GAP;
  const top = 40, height = queries.length * (groupHeight + GROUP_GAP) - GROUP_GAP, total = top + height + 62;
  let body = series.map((key, i) => `<rect x="${LEFT + i * 140}" y="4" width="12" height="12" rx="2" fill="${SERIES[key][1]}"/><text x="${LEFT + i * 140 + 18}" y="14">${SERIES[key][0]}</text>`).join("");
  for (let t = 0; t <= max; t += step) body += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${top + height + 6}" class="grid"/><text x="${x(t)}" y="${top + height + 22}" text-anchor="middle" class="tick">${t} ms</text>`;
  queries.forEach((query, g) => {
    const row = results.find(r => r.threshold === THRESHOLD && r.query === query), y = top + g * (groupHeight + GROUP_GAP);
    body += `<text x="${LEFT - 10}" y="${y + groupHeight / 2 + 4}" text-anchor="end">${esc(label(query))}</text>`;
    series.forEach((key, i) => {
      const by = y + i * (BAR + GAP), ms = row.times[key];
      body += `<rect x="${LEFT}" y="${by}" width="${x(ms) - LEFT}" height="${BAR}" rx="2" fill="${SERIES[key][1]}"/><text x="${x(ms) + 5}" y="${by + BAR - 2}" class="value">${fmt(ms)}</text>`;
    });
  });
  body += `<text x="10" y="${top + height + 48}" class="sub">${docs.toLocaleString("en-US")} books, keys title and author, threshold ${THRESHOLD}, time per search (shorter is faster)</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${total}" viewBox="0 0 ${WIDTH} ${total}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">
<style>text{fill:#24292f}.tick,.value,.sub{fill:#57606a;font-size:11px}.grid{stroke:#d0d7de;stroke-width:1}</style>
<rect width="100%" height="100%" fill="#fff"/>
${body}
</svg>
`;
}

writeFileSync(`${outdir}/benchmark.svg`, chart({ series: ["fuse", "js", "wasm", "simd"], queries: ["harry potter", "the lord of the rings the fe"], max: 200, step: 50 }));
writeFileSync(`${outdir}/benchmark-tiers.svg`, chart({ series: ["js", "wasm", "simd"], queries: ["harry potter", "tolkein", "the lord of the rings the fe"], max: 6, step: 1 }));
