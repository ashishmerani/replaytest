/** Builds an inventory-key draft from development plans or the published key manifest. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The shipped map (`tests/dashboard-ui/gates/reachability-map.md`) is deliberately
// NOT written from here any more — its content column is hand-authored.

function uniquePlanPath(repoRoot: string, suffix: string): string | undefined {
  const plansDirectory = path.join(repoRoot, 'docs', 'plans');
  if (!fs.existsSync(plansDirectory)) return undefined;
  const matches = fs.readdirSync(plansDirectory).filter((name) => name.endsWith(suffix));
  if (matches.length > 1) throw new Error(`expected at most one ${suffix} plan, found ${matches.length}`);
  return matches[0] === undefined ? undefined : path.join(plansDirectory, matches[0]);
}

/** Locates the development-only source plan without shipping its dated session filename. */
export function inventorySourcePath(repoRoot = root): string | undefined {
  return uniquePlanPath(repoRoot, '-information-inventory.md');
}

function legacyMapPath(repoRoot = root): string | undefined {
  return uniquePlanPath(repoRoot, '-reachability-map.md');
}

export interface InventoryKey { key: string; text: string; surface: string; clicks: 0 | 1 | 2; fixture: string; note?: string }

function tableItems(source: string, group: string): string[] {
  const match = source.match(new RegExp(`## ${group}\\.\\s[^\\n]+([\\s\\S]*?)(?=\\n## [A-E]\\.|\\n## Appendix|\\n---|$)`));
  if (!match) throw new Error(`inventory group ${group} is missing`);
  return match[1].split('\n').flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return cells.length >= 3 && cells[1] !== 'Item' && cells[1] !== '---' && /^\|/.test(line) ? [cells[1]] : [];
  });
}

function appendix(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source.split('\n')) {
    const match = line.match(/^- \*\*(C\d+)\*\* — (.+)$/);
    if (match) values.set(match[1], match[2]);
  }
  // The exact count, never a floor: the inventory's appendix is 52 entries, including the
  // family/coarse Status- and Coverage-tile details of the drawer Overview.
  // A count that drifts either way is a map ⇄ inventory divergence this guard exists to name.
  if (values.size !== 52) throw new Error(`expected 52 appendix entries, found ${values.size}`);
  return values;
}

export function inventoryKeys(source: string): InventoryKey[] {
  const keys: InventoryKey[] = [];
  for (const group of ['A', 'B', 'C', 'D', 'E']) {
    for (const [index, text] of tableItems(source, group).entries()) {
      const surface = group === 'C' ? 'header ⓘ' : group === 'D' ? 'drawer' : 'on screen';
      const clicks = surface === 'on screen' ? 0 : 1;
      const fixture = group === 'E' ? `E${Math.min(index + 1, 8)}` : 'a';
      keys.push({ key: `I-${group}${index + 1}`, text, surface, clicks, fixture, ...(group === 'C' ? { note: 'review' } : {}) });
    }
  }
  for (const [key, text] of appendix(source)) keys.push({ key: `V-${key}`, text, surface: 'header ⓘ', clicks: 1, fixture: 'a' });
  const ladder = source.match(/## Appendix — Completion evidence ladder \(verbatim, as its own table\)([\s\S]*?)(?=\n## Appendix — verbatim explanatory strings)/)?.[1];
  if (!ladder) throw new Error('completion evidence ladder is missing');
  const ladderRows = ladder.split('\n').filter((line) => /^\| (Completed|Navigated|Submitted|Abandoned) \|/.test(line));
  ladderRows.forEach((row, index) => keys.push({ key: `L-${index + 1}`, text: row.split('|').slice(1, -1).map((cell) => cell.trim()).join(' · '), surface: 'header ⓘ', clicks: 1, fixture: 'a' }));
  const footnotes = ladder.split('\n').flatMap((line) => {
    const match = line.match(/^\*\*(?:Footnote|Minimum-count caveat) \(verbatim\):\*\* "(.+)"$/);
    return match ? [match[1]] : [];
  });
  if (footnotes.length !== 2) throw new Error(`expected two ladder footnotes, found ${footnotes.length}`);
  footnotes.forEach((text, index) => keys.push({ key: `L-${index + 5}`, text, surface: 'header ⓘ', clicks: 1, fixture: 'a' }));
  return keys;
}

export function renderedMap(keys: readonly InventoryKey[], source = 'inventory'): string {
  return ['# Sessions reachability ledger (draft)', '', `> Generated from the ${source}. \`review\` marks an item whose home the source does not specify.`, '', '| key | surface | clicks | triggering fixture | expected visible content | destination | note |', '|---|---|---:|---|---|---|---|', ...keys.map((entry) => `| ${entry.key} | ${entry.surface} | ${entry.clicks} | ${entry.fixture} | ${entry.text.replaceAll('|', '\\|')} | — | ${entry.note ?? ''} |`), ''].join('\n');
}

/**
 * Regenerates the KEY SET only.
 *
 * Expected content is the string the page renders
 * — hand-authored in `reachability-map.md` and mirrored into the manifest — and
 * no generator can derive it from the inventory's item labels. So this writer
 * (a) keeps the shipped text of every key that already exists, (b) writes the
 * mechanical inventory label only for a NEW key, as a starting draft, and
 * (c) never overwrites the shipped map: the draft goes to `tmp/`, for a human
 * to fold in.
 */
export function writeInventoryArtifacts(repoRoot = root, report: (message: string) => void = console.log): void {
  const outputPath = path.join(repoRoot, 'tests/dashboard-ui/fixtures/gates/inventory-keys.json');
  const inventoryPath = inventorySourcePath(repoRoot);
  const legacyPath = legacyMapPath(repoRoot);
  if (inventoryPath !== undefined && legacyPath === undefined) throw new Error('development reachability-map pointer is missing');
  const shipped = new Map<string, InventoryKey>(
    (fs.existsSync(outputPath) ? (JSON.parse(fs.readFileSync(outputPath, 'utf8')) as { keys: InventoryKey[] }).keys : []).map((entry) => [entry.key, entry]),
  );
  if (inventoryPath === undefined && shipped.size === 0) throw new Error('neither an inventory plan nor a published key manifest is available');
  const keys = inventoryPath === undefined ? [...shipped.values()] : inventoryKeys(fs.readFileSync(inventoryPath, 'utf8'));
  const merged = keys.map((entry) => ({ ...entry, text: shipped.get(entry.key)?.text ?? entry.text }));
  if (inventoryPath !== undefined) fs.writeFileSync(outputPath, `${JSON.stringify({ version: 1, keys: merged }, null, 2)}\n`);
  const draftPath = path.join(repoRoot, 'tmp/dashboard-reachability-map-draft.md');
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, renderedMap(merged, inventoryPath === undefined ? 'shipped key manifest' : 'inventory'));
  if (legacyPath !== undefined && inventoryPath !== undefined) fs.writeFileSync(legacyPath, '# Sessions reachability ledger\n\nSee `tests/dashboard-ui/gates/reachability-map.md`, which ships with the gates.\n');
  report(inventoryPath === undefined
    ? `No inventory source in this checkout; wrote a ${merged.length}-key draft of the shipped key manifest to ${draftPath}.`
    : `Wrote ${merged.length} inventory keys and a draft to ${draftPath}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeInventoryArtifacts();
