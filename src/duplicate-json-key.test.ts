/**
 * Duplicate-key guard.
 *
 * JSON.parse keeps only the last value when an object contains a duplicate
 * key. This scan therefore walks the raw JSON text and records keys per
 * object scope before any last-key-wins projection can hide the fork.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Candidates are presence-TOLERANT by design: this file ships to trees (the
// staging repo, fresh clones) where some candidates legitimately do not exist,
// so absent candidates get a printed skip disclosure, never a failure, and NO
// count of present candidates is pinned anywhere — an exact present-count assert
// would be true only on this machine's tier and would break the next promotion.
// Only package.json (present in every tier) is hard-asserted as scanned.
const JSON_CONFIG_CANDIDATES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'knip.json',
  'eslint-exemptions.json',
  'scripts/corpus/foreign-exclusions.json',
  'scripts/maintenance/audit-accepted-risks.json',
  'scripts/promotion/pii-baseline.json',
  '.replaytest/hand-finished.json',
  'scripts/promotion/stage-manifest.json',
] as const;
const EXPECTED_JSON_CONFIG_CANDIDATE_COUNT = 10;
const DUPLICATE_KEY_CLASS = 'one of these definitions is silently dead — editors can change the dead copy and see no effect';

export interface DuplicateJsonKeyFinding {
  objectPath: string;
  key: string;
}

class JsonDuplicateKeyScanner {
  private readonly findings: DuplicateJsonKeyFinding[] = [];
  private offset = 0;

  public constructor(private readonly source: string) {}

  public scan(): DuplicateJsonKeyFinding[] {
    this.skipWhitespace();
    this.parseValue('$');
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail('expected one JSON value');
    return this.findings;
  }

  private parseValue(objectPath: string): void {
    this.skipWhitespace();
    const character = this.source[this.offset];
    if (character === '{') {
      this.parseObject(objectPath);
      return;
    }
    if (character === '[') {
      this.parseArray(objectPath);
      return;
    }
    if (character === '"') {
      this.parseString();
      return;
    }
    if (character === '-' || (character !== undefined && /[0-9]/.test(character))) {
      this.parseNumber();
      return;
    }
    if (this.source.startsWith('true', this.offset)) {
      this.offset += 4;
      return;
    }
    if (this.source.startsWith('false', this.offset)) {
      this.offset += 5;
      return;
    }
    if (this.source.startsWith('null', this.offset)) {
      this.offset += 4;
      return;
    }
    this.fail('expected a JSON value');
  }

  private parseObject(objectPath: string): void {
    this.expect('{');
    this.skipWhitespace();
    if (this.consume('}')) return;

    const keys = new Set<string>();
    const reportedKeys = new Set<string>();
    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') this.fail('expected an object key');
      const key = this.parseString();
      this.skipWhitespace();
      this.expect(':');

      if (keys.has(key) && !reportedKeys.has(key)) {
        this.findings.push({ objectPath, key });
        reportedKeys.add(key);
      }
      keys.add(key);
      this.parseValue(childPath(objectPath, key));
      this.skipWhitespace();
      if (this.consume('}')) return;
      this.expect(',');
    }
  }

  private parseArray(arrayPath: string): void {
    this.expect('[');
    this.skipWhitespace();
    if (this.consume(']')) return;

    let index = 0;
    while (true) {
      this.parseValue(`${arrayPath}[${index}]`);
      index += 1;
      this.skipWhitespace();
      if (this.consume(']')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.expect('"');
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      }
      if (character === '\\') {
        this.offset += 1;
        const escape = this.source[this.offset];
        if (escape === 'u') {
          const hex = this.source.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid unicode escape');
          this.offset += 5;
        } else if (escape !== '"' && escape !== '\\' && escape !== '/' && escape !== 'b' && escape !== 'f' && escape !== 'n' && escape !== 'r' && escape !== 't') {
          this.fail('invalid string escape');
        } else {
          this.offset += 1;
        }
        continue;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) this.fail('unescaped control character in string');
      this.offset += 1;
    }
    this.fail('unterminated string');
  }

  private parseNumber(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.offset));
    if (match === null) this.fail('invalid number');
    this.offset += match[0].length;
  }

  private skipWhitespace(): void {
    while (this.offset < this.source.length && /[\u0020\u0009\u000a\u000d]/.test(this.source[this.offset] ?? '')) this.offset += 1;
  }

  private consume(character: string): boolean {
    if (this.source[this.offset] !== character) return false;
    this.offset += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) this.fail(`expected "${character}"`);
  }

  private fail(reason: string): never {
    throw new Error(`invalid JSON at byte ${this.offset}: ${reason}`);
  }
}

function childPath(parentPath: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parentPath}.${key}`
    : `${parentPath}[${JSON.stringify(key)}]`;
}

export function scanDuplicateJsonKeys(source: string): DuplicateJsonKeyFinding[] {
  return new JsonDuplicateKeyScanner(source).scan();
}

function formatFinding(candidate: string, finding: DuplicateJsonKeyFinding): string {
  return `${candidate} · JSON object path ${finding.objectPath} · duplicate key "${finding.key}" · ${DUPLICATE_KEY_CLASS}`;
}

function scanJsonCandidates(): string[] {
  const failures: string[] = [];
  let packageJsonScanned = false;

  assert.equal(
    JSON_CONFIG_CANDIDATES.length,
    EXPECTED_JSON_CONFIG_CANDIDATE_COUNT,
    '[dupkey-guard] enumerated JSON candidate list changed; update the exact count with the list',
  );

  for (const candidate of JSON_CONFIG_CANDIDATES) {
    const absolutePath = path.join(repoRoot, candidate);
    if (!fs.existsSync(absolutePath)) {
      console.log(`[dupkey-guard] SKIP: ${candidate} is absent; not scanned.`);
      continue;
    }

    const source = fs.readFileSync(absolutePath, 'utf8');
    let findings: DuplicateJsonKeyFinding[];
    try {
      findings = scanDuplicateJsonKeys(source);
    } catch (error) {
      throw new Error(`[dupkey-guard] ${candidate} could not be scanned: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (candidate === 'package.json') packageJsonScanned = true;
    failures.push(...findings.map((finding) => formatFinding(candidate, finding)));
  }

  assert.equal(fs.existsSync(path.join(repoRoot, 'package.json')), true, '[dupkey-guard] package.json must exist in every tier');
  assert.equal(packageJsonScanned, true, '[dupkey-guard] package.json must be scanned, not merely present');
  return failures;
}

test('real JSON config candidates contain no duplicate keys at any object depth', () => {
  const failures = scanJsonCandidates();
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('strict scanner finds root, nested-array, and dotted-key duplicates', () => {
  const fixture = `{
    "message": "literal colon: and escaped quote \\\"key\\\"",
    "scripts": {
      "dotted.key": "first",
      "items": [{ "id": 1, "id": 2 }],
      "dotted.key": "second"
    }
  }`;

  assert.deepEqual(scanDuplicateJsonKeys(fixture), [
    { objectPath: '$.scripts.items[0]', key: 'id' },
    { objectPath: '$.scripts', key: 'dotted.key' },
  ]);
});

test('same key in different objects is legitimate and string punctuation is inert', () => {
  const fixture = '{ "left": { "name": "a:b" }, "right": { "name": "escaped \\\"quote\\\"" } }';
  assert.deepEqual(scanDuplicateJsonKeys(fixture), []);
});

test('strict scanner reports a triple duplicate once per object path and key', () => {
  const fixture = '{ "settings": { "mode": "first", "mode": "second", "mode": "third" } }';
  assert.deepEqual(scanDuplicateJsonKeys(fixture), [
    { objectPath: '$.settings', key: 'mode' },
  ]);
});
