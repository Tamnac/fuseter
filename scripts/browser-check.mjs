// Runs the Fuse equivalence checks, the typing options and the fallback logic in real browsers, with and without a CSP that blocks wasm.
// Not part of `npm test`. Setup (kept out of devDependencies because of the browser downloads):
//   npm i --no-save playwright esbuild && npx playwright install chromium firefox
// Usage: node scripts/browser-check.mjs [chromium] [firefox] [webkit]   (default: chromium firefox)
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const playwright = await import("playwright");
const out = mkdtempSync(join(tmpdir(), "fuseter-browser-"));
await build({
  entryPoints: [fileURLToPath(new URL("./browser-entry.mjs", import.meta.url))], outdir: out, bundle: true, splitting: true, format: "esm", minify: true, entryNames: "entry",
});

const CSP_NO_WASM = "default-src 'self'; script-src 'self'";
let csp = null;
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const headers = { "content-type": req.url === "/" ? "text/html" : extname(req.url) === ".js" ? "text/javascript" : "text/plain", ...(csp && { "content-security-policy": csp }) };
  let body;
  try {
    body = req.url === "/" ? `<script type="module" src="/entry.js"></script>` : readFileSync(join(out, req.url));
  } catch { return res.writeHead(404).end(); }
  res.writeHead(200, headers).end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const expect = (cond, message) => { if (!cond) failures.push(message); return cond; };
const chunks = () => requests.filter(r => /-[A-Z0-9]{8}\.js$/.test(r)).length;

async function session(browserType, label, policy, scenario) {
  csp = policy;
  requests.length = 0;
  const browser = await browserType.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", e => problems.push(`${label}: page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.checkFallback);
  try { await scenario(page); } catch (e) { problems.push(`${label}: ${e.message}`); }
  await browser.close();
  failures.push(...problems);
}

const summary = ({ checked, errors }) => `${checked} checks, ${errors.length} mismatches${errors.length ? `: ${errors[0]}` : ""}`;

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox"]) {
  const browserType = playwright[name];
  console.log(`\n${name} ${(await browserType.launch().then(async b => { const v = b.version(); await b.close(); return v; }))}`);

  await session(browserType, `${name} wasm allowed`, null, async page => {
    const eq = await page.evaluate(() => window.checkEquivalence());
    console.log(`  equivalence with Fuse (simd, wasm, js): ${summary(eq)}`);
    expect(eq.errors.length === 0, `${name}: equivalence ${eq.errors[0]}`);
    const before = chunks();
    expect(before === 0, `${name}: ${before} simd chunks loaded before typing was used`);
    const typing = await page.evaluate(() => window.checkTyping());
    console.log(`  typing options, tiers agree: ${summary(typing)}; lazy chunks fetched: ${chunks()}`);
    expect(typing.errors.length === 0, `${name}: typing ${typing.errors[0]}`);
    expect(chunks() === 3, `${name}: expected 3 lazy simd chunks, saw ${chunks()}`);
    const fb = await page.evaluate(() => window.checkFallback());
    console.log(`  default create: ${fb.simd.backend}, createSync: ${fb.syncBackend}`);
    expect(fb.simd.backend === "simd" && fb.wasm.backend === "wasm" && fb.syncBackend === "js" && fb.found === "Harry Potter", `${name}: ${JSON.stringify(fb)}`);
  });

  await session(browserType, `${name} CSP blocks wasm`, CSP_NO_WASM, async page => {
    const fb = await page.evaluate(() => window.checkFallback());
    console.log(`  CSP without wasm-unsafe-eval: simd request -> ${fb.simd.backend} (${fb.simd.reason}); wasm request -> ${fb.wasm.backend}; fallback "throw" rejects: ${fb.throwRejected}`);
    expect(fb.simd.backend === "js" && fb.simd.requested === "simd" && fb.simd.reason, `${name} CSP: simd did not fall back: ${JSON.stringify(fb.simd)}`);
    expect(fb.wasm.backend === "js" && fb.wasm.reason, `${name} CSP: wasm did not fall back: ${JSON.stringify(fb.wasm)}`);
    expect(fb.throwRejected && fb.found === "Harry Potter", `${name} CSP: ${JSON.stringify(fb)}`);
  });
}

server.close();
rmSync(out, { recursive: true, force: true });
console.log(failures.length ? `\nFAILED\n${failures.map(f => `  ${f}`).join("\n")}` : "\nall browser checks passed");
process.exit(failures.length ? 1 : 0);
