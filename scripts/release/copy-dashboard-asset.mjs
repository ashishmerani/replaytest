// Build helper: copy the dashboard HTML asset into dist/, scrubbing internal
// dev-session marker parentheticals so they never ship in the open-source tarball.
//
// The .js files get their comments stripped wholesale by `removeComments` in
// tsconfig.build.json. The dashboard HTML is a copied (non-tsc) asset, so its
// internal markers are removed here instead. The scrub targets ONLY parenthetical
// attributions that carry a session marker (e.g. "(S<NN> bug class, caught by a probe …)")
// — the surrounding explanatory prose is preserved. Source (src/dashboard/index.html)
// keeps every comment for developers; only the shipped copy is scrubbed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "src/dashboard/index.html";
const DEMO_STORE_SRC = "src/dashboard/demo-store.json";
const OUT_DIR = "dist/dashboard";
const OUT = `${OUT_DIR}/index.html`;
const DEMO_STORE_OUT = `${OUT_DIR}/demo-store.json`;

// A parenthetical group ("(" … ")", no nested parens) that contains a session
// marker token like `S<NN>`. `[^()]` spans newlines, covering multi-line comments.
const MARKER_PARENTHETICAL = / ?\([^()]*\bS[0-9]+\b[^()]*\)/g;

const html = readFileSync(SRC, "utf8");
const scrubbed = html.replace(MARKER_PARENTHETICAL, "");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, scrubbed);
writeFileSync(DEMO_STORE_OUT, readFileSync(DEMO_STORE_SRC));

const removed = (html.match(MARKER_PARENTHETICAL) || []).length;
console.log(`copy-dashboard-asset: wrote ${OUT} and ${DEMO_STORE_OUT} (scrubbed ${removed} marker parenthetical${removed === 1 ? "" : "s"})`);
