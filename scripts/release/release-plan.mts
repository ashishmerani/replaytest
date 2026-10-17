#!/usr/bin/env node

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TRUSTED_BLOCK_LABELS: readonly string[] = [
  'After this release', 'Version:', 'npm tag:', 'GitHub release:', 'Commit:', 'Release point:',
  'Registry latest:', 'Registry next:', 'Package file:', 'Size:', 'sha256:', 'sha512:',
  'gh version:', 'gh capabilities:', 'History fetched:', 'CHANGELOG.md packed size:', 'Dispatched by:',
  'Package files:', 'Matching sync tag:', 'History fetched in:', 'Skipped malformed release tags:', 'If approved, the workflow would send',
  'Install this version:', 'First release.', 'Full list of changes', 'Check this release yourself',
  'Release notes, exactly as they will appear:', 'End of release notes', 'DRY RUN', 'Release run',
];

/** Fixed customer-visible release copy. */
export const RELEASE_PUBLIC_STRINGS: readonly string[] = [
  'After this release, `npm install replaytest` gives:',
  'Install this version: npm install replaytest@',
  'First release.',
  'Full list of changes:',
  'Check this release yourself: sha256',
  'Download replaytest-',
  'then (needs the GitHub CLI, signed in):',
  'gh attestation verify replaytest-',
  'npm audit signatures', 'Skipped malformed release tags:',
  'Release notes, exactly as they will appear:',
  'End of release notes (sha256',
  'If approved, the workflow would send this package to npm under the',
  '## DRY RUN — nothing published, nothing tagged',
  '## Release run — package and release checks',
];

export type ReleaseChannel = {
  version: string;
  dist_tag: 'next' | 'latest';
  prerelease: boolean;
  make_latest: boolean;
  base_version: string;
};

export type RegistryTags = { latest?: string; next?: string };

export type ReleaseTag = { name: string; objectType: string; target: string };

export type ReleasePointInput = {
  sha: string;
  tags: readonly ReleaseTag[];
  message: string;
  gitError?: string;
  enforce: boolean;
};

export type ReleasePointResult = {
  passed: boolean;
  exitCode: 0 | 1;
  mode: 'enforce' | 'report';
  matchingTag?: string;
  reason: string;
};

export class ReleasePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleasePlanError';
  }
}

type ParsedVersion = { major: bigint; minor: bigint; patch: bigint; rc?: bigint };

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.([1-9][0-9]*))?$/;
const SYNC_TAG_PATTERN = /^sync\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[1-9][0-9]*$/;

export function parseVersion(raw: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(raw);
  if (match === null) {
    throw new ReleasePlanError('The raw version must be X.Y.Z or X.Y.Z-rc.N with canonical digits and no surrounding whitespace.');
  }
  return {
    major: BigInt(match[1] ?? '0'),
    minor: BigInt(match[2] ?? '0'),
    patch: BigInt(match[3] ?? '0'),
    ...(match[4] === undefined ? {} : { rc: BigInt(match[4]) }),
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  if (a.rc === undefined && b.rc !== undefined) return 1;
  if (a.rc !== undefined && b.rc === undefined) return -1;
  if (a.rc === undefined || b.rc === undefined) return 0;
  return a.rc > b.rc ? 1 : a.rc < b.rc ? -1 : 0;
}

export function channelFor(version: string, npmTag: string): ReleaseChannel {
  if (npmTag !== 'next' && npmTag !== 'latest') {
    throw new ReleasePlanError('npm_tag must be exactly next or latest.');
  }
  const parsed = parseVersion(version);
  const isPrerelease = parsed.rc !== undefined;
  if (isPrerelease && npmTag !== 'next') throw new ReleasePlanError('A pre-release can use only the next npm tag.');
  return {
    version,
    dist_tag: npmTag,
    prerelease: isPrerelease,
    make_latest: !isPrerelease,
    base_version: [parsed.major, parsed.minor, parsed.patch].join('.'),
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDistTags(raw: string): RegistryTags {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new ReleasePlanError('Could not read the registry: dist-tag output was not valid JSON.');
  }
  if (!plainRecord(decoded)) throw new ReleasePlanError('Could not read the registry: dist-tag output must be a JSON object.');
  const tags: RegistryTags = {};
  for (const name of ['latest', 'next'] as const) {
    if (!Object.hasOwn(decoded, name)) continue;
    const value = decoded[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ReleasePlanError('Could not read the registry: ' + name + ' is present without a version string.');
    }
    try {
      parseVersion(value);
    } catch {
      throw new ReleasePlanError('Could not read the registry: ' + name + ' has an invalid version string ' + JSON.stringify(value) + '.');
    }
    tags[name] = value;
  }
  return tags;
}

export function checkOrdering(version: string, channel: ReleaseChannel, tags: RegistryTags): void {
  const selected = tags[channel.dist_tag];
  if (selected !== undefined && compareVersions(version, selected) <= 0) {
    throw new ReleasePlanError(version + ' must be greater than the current ' + channel.dist_tag + ' version ' + selected + '.');
  }
  const latest = tags.latest;
  if (latest !== undefined) {
    const compared = channel.prerelease ? channel.base_version : version;
    if (compareVersions(compared, latest) <= 0) {
      throw new ReleasePlanError(compared + ' must be greater than the current latest version ' + latest + '.');
    }
  }
}

export function evaluateReleasePoint(input: ReleasePointInput): ReleasePointResult {
  const mode = input.enforce ? 'enforce' : 'report';
  if (input.gitError !== undefined) {
    return { passed: false, exitCode: 1, mode, reason: 'Git could not read the release point: ' + input.gitError };
  }
  const tag = input.tags.find((candidate) =>
    SYNC_TAG_PATTERN.test(candidate.name) && candidate.objectType === 'tag' && candidate.target === input.sha,
  );
  if (tag === undefined) {
    return {
      passed: false,
      exitCode: input.enforce ? 1 : 0,
      mode,
      reason: 'This commit is not a release point: push its sync/ marker tag, then run again. No pushed annotated sync/ tag at this commit was visible.',
    };
  }
  const lines = input.message.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const markerPattern = /^Promotion-Source: [0-9a-f]{40}$/;
  const markerIndexes = lines.flatMap((line, index) => markerPattern.test(line) ? [index] : []);
  if (markerIndexes.length !== 1) {
    return {
      passed: false,
      exitCode: input.enforce ? 1 : 0,
      mode,
      matchingTag: tag.name,
      reason: 'This commit did not arrive with exactly one Promotion-Source: line.',
    };
  }
  const markerIndex = markerIndexes[0] ?? -1;
  for (const line of lines.slice(markerIndex + 1)) {
    if (line === '') continue;
    if (/^(?:Signed-off-by|Co-authored-by): .+\S$/.test(line)) continue;
    return {
      passed: false,
      exitCode: input.enforce ? 1 : 0,
      mode,
      matchingTag: tag.name,
      reason: 'A line that is not a sign-off or co-author trailer follows Promotion-Source: ' + line,
    };
  }
  return { passed: true, exitCode: 0, mode, matchingTag: tag.name, reason: 'This commit passes the release-point check.' };
}

type ChangelogSection = { version: string; date: string; headingLine: number; text: string; lineCount: number };

function fenceDelimiter(line: string): { char: '`' | '~'; width: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const token = match[1] ?? '';
  const rest = match[2] ?? '';
  const char = token[0] as '`' | '~';
  if (char === '`' && rest.includes('`')) return undefined;
  return { char, width: token.length };
}

function closesFence(line: string, open: { char: '`' | '~'; width: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  if (match === null) return false;
  const token = match[1] ?? '';
  return token[0] === open.char && token.length >= open.width;
}

function dateIsReal(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function compareBlockStart(lines: readonly string[], start: number, end: number): number | undefined {
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\[[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[1-9][0-9]*)?\]: https:\/\/\S+$/.test(line)) continue;
    const remaining = lines.slice(index, end).filter((candidate) => candidate.trim() !== '');
    if (remaining.length > 0 && remaining.every((candidate) => /^\[[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[1-9][0-9]*)?\]: https:\/\/\S+$/.test(candidate))) return index;
  }
  return undefined;
}

function sectionLines(lines: readonly string[], start: number): { end: number; fenceError?: number } {
  let open: { char: '`' | '~'; width: number; line: number } | undefined;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (open !== undefined) {
      if (closesFence(line, open)) open = undefined;
      continue;
    }
    if (/^##\s/.test(line)) return { end: index };
    const fence = fenceDelimiter(line);
    if (fence !== undefined) open = { ...fence, line: index + 1 };
  }
  return open === undefined ? { end: lines.length } : { end: lines.length, fenceError: open.line };
}

function stripInlineCode(line: string): string {
  let result = '';
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') { result += line[index]; index += 1; continue; }
    let width = 1;
    while (line[index + width] === '`') width += 1;
    const marker = '`'.repeat(width);
    const close = line.indexOf(marker, index + width);
    if (close === -1) { result += marker; index += width; continue; }
    result += ' '.repeat(close + width - index);
    index = close + width;
  }
  return result;
}

function visibleLines(lines: readonly string[]): Array<{ text: string; raw: string; line: number }> {
  const visible: Array<{ text: string; raw: string; line: number }> = [];
  let open: { char: '`' | '~'; width: number } | undefined;
  let htmlComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (open !== undefined) {
      if (closesFence(line, open)) open = undefined;
      continue;
    }
    const fence = fenceDelimiter(line);
    if (fence !== undefined) { open = fence; continue; }
    let text = stripInlineCode(line);
    const raw = text.replace(/<https?:\/\/[^>]+>/g, ' ');
    text = text.replace(/<https?:\/\/[^>]+>/g, ' ');
    if (htmlComment) {
      const end = text.indexOf('-->');
      if (end === -1) continue;
      text = text.slice(end + 3);
      htmlComment = false;
    }
    while (text.includes('<!--')) {
      const begin = text.indexOf('<!--');
      const end = text.indexOf('-->', begin + 4);
      if (end === -1) { text = text.slice(0, begin); htmlComment = true; break; }
      text = text.slice(0, begin) + text.slice(end + 3);
    }
    visible.push({ text, raw, line: index + 1 });
  }
  return visible;
}

function labelAfterPrefix(line: string): string {
  return line.replace(/^(?:[\s>*#+-]|[0-9]+[.)]\s)+/, '').trimStart();
}

function validateSection(section: ChangelogSection): void {
  const rawLines = section.text.split('\n');
  const view = visibleLines(rawLines);
  const nonblank = view.filter(({ text }) => text.trim() !== '' && !/^\s*#{1,6}\s/.test(text));
  if (nonblank.length === 0) throw new ReleasePlanError('The CHANGELOG.md section has no visible text at line ' + section.headingLine + '.');
  for (const { text, raw, line } of view) {
    if (/<[A-Za-z!]/.test(raw)) throw new ReleasePlanError('Raw HTML is not allowed in the CHANGELOG.md section at line ' + (section.headingLine + line) + '.');
    if (/<[^>]+>|\.\.\.|\b(?:TODO|TBD|FIXME|DRAFT)\b/.test(text)) {
      throw new ReleasePlanError('A placeholder is not allowed in the CHANGELOG.md section at line ' + (section.headingLine + line) + '.');
    }
    if (/\[[^\]]+\](?:\[[^\]]*\]|(?![([]))/.test(text)) {
      throw new ReleasePlanError('Reference-style links are not allowed in the CHANGELOG.md section at line ' + (section.headingLine + line) + '.');
    }
    const normalized = labelAfterPrefix(text);
    const label = TRUSTED_BLOCK_LABELS.find((candidate) => normalized.toLowerCase().startsWith(candidate.toLowerCase()));
    if (label !== undefined) {
      throw new ReleasePlanError('A CHANGELOG.md line imitates a trusted label at line ' + (section.headingLine + line) + '.');
    }
  }
  const bytes = Buffer.byteLength(section.text, 'utf8');
  if (bytes > 20 * 1024) {
    throw new ReleasePlanError('The CHANGELOG.md section is ' + bytes + ' UTF-8 bytes at line ' + section.headingLine + '. The In brief list should carry the user-visible outcomes while the compare link carries the detail. Raising a cap is a reviewed commit.');
  }
}

export function extractChangelogSection(raw: string, version: string): ChangelogSection {
  parseVersion(version);
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const target = '## [' + version + ']';
  const starts = lines.flatMap((line, index) => line.startsWith(target) && (line[target.length] === ' ' || line[target.length] === '-' || line[target.length] === undefined) ? [index] : []);
  if (starts.length !== 1) throw new ReleasePlanError('CHANGELOG.md must contain exactly one heading for ' + version + '; found ' + starts.length + '.');
  const headingIndex = starts[0] ?? -1;
  const heading = lines[headingIndex] ?? '';
  const headingMatch = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(heading);
  if (headingMatch === null || headingMatch[1] !== version || !dateIsReal(headingMatch[2] ?? '')) {
    throw new ReleasePlanError('The CHANGELOG.md heading for ' + version + ' must include a real YYYY-MM-DD date at line ' + (headingIndex + 1) + '.');
  }
  const boundaries = sectionLines(lines, headingIndex + 1);
  if (boundaries.fenceError !== undefined) throw new ReleasePlanError('A code fence is not closed at line ' + boundaries.fenceError + '.');
  const end = compareBlockStart(lines, headingIndex + 1, boundaries.end) ?? boundaries.end;
  const body = lines.slice(headingIndex + 1, end);
  const section: ChangelogSection = {
    version,
    date: headingMatch[2] ?? '',
    headingLine: headingIndex + 1,
    text: body.join('\n').replace(/\n+$/, ''),
    lineCount: body.length,
  };
  validateSection(section);
  const bytes = Buffer.byteLength(section.text, 'utf8');
  if (bytes > 20 * 1024) {
    throw new ReleasePlanError('The CHANGELOG.md section is ' + bytes + ' UTF-8 bytes at line ' + section.headingLine + '. The In brief list should carry the user-visible outcomes while the compare link carries the detail. Raising a cap is a reviewed commit.');
  }
  return section;
}

export function isDateNotice(date: string, now = new Date()): boolean {
  const elapsed = now.getTime() - new Date(date + 'T00:00:00.000Z').getTime();
  return elapsed > 7 * 24 * 60 * 60 * 1000;
}

export function buildReleaseFooter(input: {
  version: string;
  repository: string;
  commit: string;
  packageSha256: string;
  previousStableTag?: string;
}): string {
  const target = parseVersion(input.version);
  let compareLine: string;
  if (input.previousStableTag === undefined) {
    compareLine = 'First release.';
  } else {
    const match = /^v(.+)$/.exec(input.previousStableTag);
    if (match === null || compareVersions(match[1] ?? '', input.version) >= 0 || parseVersion(match[1] ?? '').rc !== undefined) {
      throw new ReleasePlanError('The previous stable tag must be a strictly lower stable version.');
    }
    compareLine = 'Full list of changes: https://github.com/' + input.repository + '/compare/' + input.previousStableTag + '...v' + input.version;
  }
  if (target.rc !== undefined && input.previousStableTag === undefined) compareLine = 'First release.';
  return [
    '---',
    '',
    'Install this version: npm install replaytest@' + input.version,
    compareLine,
    'Check this release yourself: sha256 ' + input.packageSha256 + '.',
    'Download replaytest-' + input.version + '.tgz from this release, or run npm pack replaytest@' + input.version + ', then (needs the GitHub CLI, signed in):',
    'gh attestation verify replaytest-' + input.version + '.tgz -R ' + input.repository + ' --signer-workflow ' + input.repository + '/.github/workflows/release.yml --source-digest ' + input.commit,
    'npm audit signatures',
  ].join('\n');
}

export function buildNotes(section: ChangelogSection, footer: string): string {
  const notes = section.text + '\n\n' + footer + '\n';
  const bytes = Buffer.byteLength(notes, 'utf8');
  if (bytes > 48 * 1024) {
    throw new ReleasePlanError('The release notes are ' + bytes + ' UTF-8 bytes at line ' + (section.headingLine + section.lineCount) + '. The In brief list should carry the user-visible outcomes while the compare link carries the detail. Raising a cap is a reviewed commit.');
  }
  return notes;
}

export function renderSummary(input: {
  dryRun: boolean;
  version: string;
  distTag: string;
  prerelease: boolean;
  commit: string;
  syncTag: string;
  releasePoint: string;
  releasePointMode: string;
  latest: string;
  next: string;
  tarballName: string;
  size: number;
  sha256: string;
  sha512: string;
  ghVersion: string;
  ghCapabilities: readonly string[];
  historyFetchTime: string;
  changelogSize: number;
  notes: string;
  packFiles: readonly string[]; skippedMalformedTags?: readonly string[];
}): string {
  const notesHash = sha256(Buffer.from(input.notes, 'utf8'));
  const untaggedInstallVersion = input.distTag === 'latest' ? input.version : (input.latest || 'absent');
  const beforeNotes = [
    input.dryRun ? '## DRY RUN — nothing published, nothing tagged' : '## Release run — package and release checks',
    '',
    'After this release, `npm install replaytest` gives: ' + untaggedInstallVersion,
    '- Version: `' + input.version + '`',
    '- npm tag: `' + input.distTag + '`',
    '- GitHub release: `' + (input.prerelease ? 'pre-release' : 'latest') + '`',
    '- Commit: `' + input.commit + '`',
    '- Matching sync tag: `' + input.syncTag + '`',
    '- Release point: `' + input.releasePoint + '` (' + input.releasePointMode + ')',
    '- Registry latest: `' + (input.latest || 'absent') + '`',
    '- Registry next: `' + (input.next || 'absent') + '`',
    '- Package file: `' + input.tarballName + '`',
    '- Size: `' + input.size + ' bytes`',
    '- sha256: `' + input.sha256 + '`',
    '- sha512: `' + input.sha512 + '`',
    '- gh version: `' + input.ghVersion + '`',
    '- gh capabilities:',
    ...input.ghCapabilities.map((capability) => '  - ' + capability),
    '- History fetched in: `' + input.historyFetchTime + '`',
    // Git refnames forbid ~, so a tag cannot close this fence. Show only visible ASCII.
    '- CHANGELOG.md packed size: `' + input.changelogSize + ' bytes`' + (input.skippedMalformedTags?.length ? '\n\nSkipped malformed release tags:\n\n~~~\n' + input.skippedMalformedTags.map((tag) => tag.replace(/[^\x21-\x7e]/g, (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))).join('\n') + '\n~~~' : ''),
    '',
    'Release notes, exactly as they will appear:',
  ].join('\n');
  const afterNotes = [
    'End of release notes (sha256 ' + notesHash + ')',
    '',
    'Package files:',
    ...input.packFiles.map((file) => '- ' + file),
    '',
    'If approved, the workflow would send this package to npm under the ' + input.distTag + ' tag.',
  ].join('\n');
  return beforeNotes + '\n' + input.notes + afterNotes;
}

export function classifyBundleVerification(status: number | null, stdout: string, stderr: string): { passed: boolean; reason: string } {
  if (status === 0) return { passed: true, reason: 'The attestation verifies for the package, repository, workflow, and source commit.' };
  return { passed: false, reason: 'The attestation did not verify: ' + (stderr.trim() || stdout.trim() || 'gh returned no detail') };
}

export type GhRequirement = { command: string; flags: string[] };

// eslint-disable-next-line complexity -- The exact requirement walk mirrors the release CLI command arrays.
export function deriveGhRequirements(scriptSource: string): GhRequirement[] {
  const found = new Map<string, Set<string>>();
  const arrays: string[] = [];
  for (const match of scriptSource.matchAll(/(?:runGh|ghJson)\(\s*\[([\s\S]*?)\]\s*(?:,|\))/g)) arrays.push(match[1] ?? '');
  for (const match of scriptSource.matchAll(/exec\('gh',\s*\[([\s\S]*?)\]\s*(?:,|\))/g)) arrays.push(match[1] ?? '');
  for (const body of arrays) {
    const literals = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1] ?? '');
    if (literals.length === 0 || literals[0]?.startsWith('-')) continue;
    const commandParts = literals[0] === 'attestation' ? ['attestation', literals[1] ?? '']
      : literals[0] === 'release' ? ['release', literals[1] ?? '']
        : [literals[0] ?? ''];
    const command = commandParts.join(' ');
    const flags = new Set<string>();
    for (const token of literals.slice(commandParts.length)) {
      if (/^--[a-z][a-z0-9-]*(?:=.*)?$/.test(token)) flags.add(token.split('=', 1)[0] ?? token);
      else if (/^-[A-Za-z]$/.test(token)) flags.add(token);
    }
    const existing = found.get(command) ?? new Set<string>();
    for (const flag of flags) existing.add(flag);
    found.set(command, existing);
  }
  const createTail = /const flags = versionShape\.prerelease \? \[([\s\S]*?)\] : \[([\s\S]*?)\];\s*runGh\(\['release', 'create'/.exec(scriptSource)?.slice(1).join('\n') ?? '';
  const createOptions = [...createTail.matchAll(/'(--[a-z][a-z0-9-]*)(?:=[^']*)?'/g)].map((match) => match[1] ?? '');
  const createRequirement = found.get('release create') ?? new Set<string>();
  for (const flag of createOptions) createRequirement.add(flag);
  if (createOptions.length > 0) found.set('release create', createRequirement);
  return [...found.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([command, flags]) => ({ command, flags: [...flags].sort() }));
}

export function checkGhHelp(requirements: readonly GhRequirement[], help: Readonly<Record<string, string>>): string[] {
  const missing: string[] = [];
  for (const requirement of requirements) {
    const text = help[requirement.command];
    if (text === undefined) { missing.push(requirement.command); continue; }
    for (const flag of requirement.flags) {
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp('(?:^|[\\s,])' + escaped + '(?:[=,\\s]|$)').test(text)) missing.push(requirement.command + ' ' + flag);
    }
  }
  return missing;
}

export type ReleaseSnapshot = {
  tagStatus: 'absent' | 'present' | 'error';
  tagObjectType?: string;
  tagCommit?: string;
  releaseStatus: 'absent' | 'present' | 'error';
  draft?: boolean;
  title?: string;
  prerelease?: boolean;
  assets?: readonly string[];
  body?: string;
  tarballSha256?: string;
  bundleVerified?: boolean;
};

export type ReleaseDecision = { action: 'create' | 'delete-draft-and-create' | 'already-exists'; reason: string };

// eslint-disable-next-line complexity -- Keep the release state machine visible beside its fail-closed branches.
export function decideRelease(snapshot: ReleaseSnapshot, expected: {
  version: string; commit: string; title: string; prerelease: boolean; assets: readonly string[]; sha256: string; notes: string;
}): ReleaseDecision {
  if (snapshot.tagStatus === 'error' || snapshot.releaseStatus === 'error') throw new ReleasePlanError('GitHub could not read the release tag or release; no change was made.');
  if (snapshot.tagStatus === 'present') {
    if (snapshot.tagObjectType !== 'tag' && snapshot.tagObjectType !== 'commit') throw new ReleasePlanError('The release tag has an unsupported object type.');
    if (snapshot.tagCommit !== expected.commit) throw new ReleasePlanError('The release tag points at another commit; it was never moved.');
  }
  if (snapshot.releaseStatus === 'absent') {
    if (snapshot.tagStatus === 'absent') return { action: 'create', reason: 'No tag or release exists; create the release at this commit.' };
    return { action: 'create', reason: 'The tag already points at this commit; reuse it for the release.' };
  }
  if (snapshot.draft === true) {
    return { action: 'delete-draft-and-create', reason: 'A draft exists and no tag points elsewhere; replace the draft.' };
  }
  const expectedAssets = [...expected.assets].sort();
  const actualAssets = [...(snapshot.assets ?? [])].sort();
  const sameBody = normalizeNewlines(snapshot.body ?? '').trimEnd() === normalizeNewlines(expected.notes).trimEnd();
  if (snapshot.title !== expected.title) throw new ReleasePlanError('The published release title differs; it was never moved or edited.');
  if (snapshot.prerelease !== expected.prerelease) throw new ReleasePlanError('The published release pre-release flag differs; it was never moved or edited.');
  if (actualAssets.length !== expectedAssets.length || actualAssets.some((asset, index) => asset !== expectedAssets[index])) {
    throw new ReleasePlanError('The published release asset set differs; it was never moved or edited.');
  }
  if (snapshot.tarballSha256 !== expected.sha256) throw new ReleasePlanError('The published release package bytes differ; it was never moved or edited.');
  if (snapshot.bundleVerified !== true) throw new ReleasePlanError('The attached attestation does not verify; the release was never moved or edited.');
  if (!sameBody) throw new ReleasePlanError('The published release body differs; it was never moved or edited.');
  return { action: 'already-exists', reason: 'The published release matches the tested files and notes.' };
}

export type PublishSnapshot = { present: boolean; integrity?: string; provenance: boolean; tags: RegistryTags };

export type PublishDecision = { mode: 'publish' | 'already-published'; reason: string; tags: RegistryTags };

// eslint-disable-next-line complexity -- The bounded registry-read classifier is intentionally a single closed decision.
export function decidePublish(reads: readonly PublishSnapshot[], version: string, expectedSha512: string, channel: ReleaseChannel): PublishDecision {
  if (reads.length === 0) throw new ReleasePlanError('The registry returned no readable result.');
  if (expectedSha512 === '') throw new ReleasePlanError('The expected sha512 value is missing.');
  const states = reads.map((item) => ({ present: item.present, tagNamesVersion: item.tags[channel.dist_tag] === version }));
  const contradicts = states.some((item) => item.present !== states[0]?.present || item.present !== item.tagNamesVersion);
  if (contradicts) {
    throw new ReleasePlanError('This version looks published already and the registry has not caught up; wait a few minutes and use Re-run failed jobs again.');
  }
  const present = reads[0]?.present ?? false;
  if (!present) return { mode: 'publish', reason: 'The version is absent and the selected tag does not name it.', tags: reads.at(-1)?.tags ?? {} };
  for (const read of reads) {
    if (typeof read.integrity !== 'string' || !/^sha512-.+$/.test(read.integrity)) {
      throw new ReleasePlanError('The registry version is present with a missing or malformed sha512 integrity value.');
    }
    if (read.integrity !== expectedSha512) {
      throw new ReleasePlanError('The registry package bytes differ: expected ' + expectedSha512 + ', got ' + read.integrity + '.');
    }
    if (!read.provenance) throw new ReleasePlanError('Published without provenance: investigate.');
  }
  return { mode: 'already-published', reason: 'replaytest@' + version + ' is already on the registry with these exact bytes; not publishing again.', tags: reads.at(-1)?.tags ?? {} };
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha512Integrity(bytes: Buffer): string {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64');
}

export function verifyExpectedHash(filePath: string, expected: string, label: string): string {
  if (expected === '') throw new ReleasePlanError('The expected ' + label + ' hash is missing.');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new ReleasePlanError('The ' + label + ' file is missing: ' + filePath + '.');
  const actual = sha256(fs.readFileSync(filePath));
  if (actual !== expected) throw new ReleasePlanError('The ' + label + ' hash differs: expected ' + expected + ', got ' + actual + '.');
  return actual;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function exec(command: string, args: readonly string[], options: { cwd?: string; input?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { cwd: options.cwd, input: options.input, encoding: 'utf8' });
  if (result.error !== undefined) return { status: null, stdout: result.stdout ?? '', stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function requireSuccess(result: { status: number | null; stdout: string; stderr: string }, action: string): string {
  if (result.status !== 0) throw new ReleasePlanError(action + ' failed: ' + (result.stderr.trim() || result.stdout.trim() || 'no detail'));
  return result.stdout;
}

function output(name: string, value: string | number | boolean): void {
  const target = process.env.GITHUB_OUTPUT;
  if (target === undefined || target === '') return;
  fs.appendFileSync(target, name + '=' + String(value) + '\n');
}

function env(name: string): string {
  return process.env[name] ?? '';
}

function rootFromModule(): string {
  return path.resolve(process.cwd());
}

function git(commandArgs: readonly string[], cwd: string): string {
  return requireSuccess(exec('git', commandArgs, { cwd }), 'git ' + commandArgs.join(' ')).trim();
}

function collectReleasePoint(root: string): { tags: ReleaseTag[]; message: string; sha: string; gitError?: string } {
  const sha = env('GITHUB_SHA');
  try {
    const names = git(['tag', '--points-at', sha], root).split('\n').filter(Boolean);
    const tags: ReleaseTag[] = [];
    for (const name of names) {
      const objectType = git(['cat-file', '-t', name], root);
      const target = git(['rev-parse', name + '^{commit}'], root);
      tags.push({ name, objectType, target });
    }
    const message = git(['show', '-s', '--format=%B', sha], root);
    return { tags, message, sha };
  } catch (error) {
    return { tags: [], message: '', sha, gitError: error instanceof Error ? error.message : String(error) };
  }
}

function runReleasePoint(root: string): number {
  const started = Date.now();
  const data = collectReleasePoint(root);
  const elapsed = Date.now() - started;
  const enforce = env('DRY_RUN') !== 'true' || env('PUBLISH_ENABLED') === 'true';
  const result = evaluateReleasePoint({ ...data, enforce });
  output('release_point_passed', result.passed);
  output('matching_sync_tag', result.matchingTag ?? 'absent');
  output('release_point_mode', result.mode);
  output('history_fetch_time', elapsed + ' ms');
  const githubEnv = env('GITHUB_ENV');
  if (githubEnv !== '') {
    fs.appendFileSync(githubEnv, 'MATCHING_SYNC_TAG=' + (result.matchingTag ?? 'absent') + '\n');
    fs.appendFileSync(githubEnv, 'RELEASE_POINT_PASSED=' + String(result.passed) + '\n');
    fs.appendFileSync(githubEnv, 'RELEASE_POINT_MODE=' + result.mode + '\n');
    fs.appendFileSync(githubEnv, 'HISTORY_FETCH_TIME=' + elapsed + ' ms\n');
  }
  if (result.passed) console.log('This commit passes the release-point check in ' + result.mode + ' mode. Matching tag: ' + result.matchingTag + '.');
  else if (result.mode === 'report' && result.exitCode === 0) console.log('This commit would be refused: ' + result.reason);
  else console.error(result.reason);
  return result.exitCode;
}

function readRegistryTags(name: string): RegistryTags {
  const result = exec('npm', ['view', name, 'dist-tags', '--json']);
  if (result.status !== 0) throw new ReleasePlanError('Could not read the registry dist-tags: ' + (result.stderr.trim() || result.stdout.trim() || 'no detail'));
  return parseDistTags(result.stdout);
}

function runVersionPlan(root: string): number {
  const version = env('VERSION');
  const channel = channelFor(version, env('NPM_TAG'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown; name?: unknown };
  if (manifest.name !== 'replaytest' || manifest.version !== version) {
    throw new ReleasePlanError('The version input must exactly match the replaytest version in package.json.');
  }
  const tags = readRegistryTags('replaytest');
  checkOrdering(version, channel, tags);
  output('dist_tag', channel.dist_tag);
  output('prerelease', channel.prerelease);
  output('make_latest', channel.make_latest);
  output('registry_latest', tags.latest ?? 'absent');
  output('registry_next', tags.next ?? 'absent');
  const githubEnv = env('GITHUB_ENV');
  if (githubEnv !== '') {
    fs.appendFileSync(githubEnv, 'DIST_TAG=' + channel.dist_tag + '\n');
    fs.appendFileSync(githubEnv, 'PRERELEASE=' + String(channel.prerelease) + '\n');
    fs.appendFileSync(githubEnv, 'MAKE_LATEST=' + String(channel.make_latest) + '\n');
    fs.appendFileSync(githubEnv, 'REGISTRY_LATEST=' + (tags.latest ?? 'absent') + '\n');
    fs.appendFileSync(githubEnv, 'REGISTRY_NEXT=' + (tags.next ?? 'absent') + '\n');
  }
  console.log('Version ' + version + ' is valid for the ' + channel.dist_tag + ' npm tag. Registry latest: ' + (tags.latest ?? 'absent') + '; next: ' + (tags.next ?? 'absent') + '.');
  return 0;
}

function listStableTags(root: string, version: string): { previousStableTag: string | undefined; skippedTags: string[] } {
  const names = git(['tag', '--list', 'v*'], root).split('\n').filter(Boolean);
  const commit = env('GITHUB_SHA');
  const candidates: Array<{ name: string; version: string }> = [];
  for (const name of names) {
    const match = /^v(.+)$/.exec(name);
    if (match === null) continue;
    try {
      if (!VERSION_PATTERN.test(match[1] ?? '')) continue;
      const parsed = parseVersion(match[1] ?? '');
      if (parsed.rc !== undefined || compareVersions(match[1] ?? '', version) >= 0) continue;
      const ancestor = exec('git', ['merge-base', '--is-ancestor', name + '^{commit}', commit], { cwd: root });
      if (ancestor.status === 0) candidates.push({ name, version: match[1] ?? '' });
      else if (ancestor.status !== 1) throw new ReleasePlanError('Git could not determine whether a prior tag is an ancestor.');
    } catch (error) {
      if (error instanceof ReleasePlanError) throw error;
    }
  }
  candidates.sort((a, b) => compareVersions(a.version, b.version));
  return { previousStableTag: candidates.at(-1)?.name, skippedTags: names.filter((name) => !VERSION_PATTERN.test(name.slice(1))) };
}

function runNotes(root: string): number {
  const started = Date.now();
  const version = env('VERSION');
  const section = extractChangelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  const tarball = env('TARBALL');
  const bytes = fs.readFileSync(path.resolve(root, tarball));
  const digest = sha256(bytes);
  const repository = env('GITHUB_REPOSITORY');
  const { previousStableTag, skippedTags } = listStableTags(root, version);
  const footer = buildReleaseFooter({ version, repository, commit: env('GITHUB_SHA'), packageSha256: digest, previousStableTag });
  const notes = buildNotes(section, footer);
  fs.writeFileSync(path.join(root, 'release-notes.md'), notes);
  output('notes_sha256', sha256(notes));
  output('module_sha256', sha256(fs.readFileSync(fileURLToPath(import.meta.url))));
  output('tarball_sha256', digest);
  output('tarball_sha512', sha512Integrity(bytes));
  output('date_notice', isDateNotice(section.date) ? 'CHANGELOG.md date is more than seven days old.' : '');
  output('notes_line', section.headingLine);
  output('previous_stable_tag', previousStableTag ?? 'First release.'); if (env('GITHUB_ENV') !== '') fs.appendFileSync(env('GITHUB_ENV'), 'SKIPPED_RELEASE_TAGS_JSON=' + JSON.stringify(skippedTags) + '\n');
  console.log(isDateNotice(section.date) ? 'Notice: the CHANGELOG.md date is more than seven days old.' : 'CHANGELOG.md date is current.');
  console.log('Release notes created and hashed in ' + (Date.now() - started) + ' ms.');
  return 0;
}

function runPack(root: string): number {
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8')) as Array<{
    filename?: string;
    files?: Array<{ path?: string; size?: number }>;
  }>;
  const result = pack[0];
  const tarball = result?.filename;
  if (typeof tarball !== 'string' || tarball === '' || !fs.statSync(path.join(root, tarball), { throwIfNoEntry: false })?.isFile()) {
    throw new ReleasePlanError('npm pack did not produce a readable package file.');
  }
  const bytes = fs.readFileSync(path.join(root, tarball));
  const changelog = result?.files?.find((file) => file.path === 'package/CHANGELOG.md' || file.path === 'CHANGELOG.md');
  output('tarball_name', tarball);
  output('tarball_sha256', sha256(bytes));
  output('tarball_sha512', sha512Integrity(bytes));
  output('changelog_size', changelog?.size ?? 0);
  output('tarball_size', bytes.length);
  const githubEnv = env('GITHUB_ENV');
  if (githubEnv !== '') {
    fs.appendFileSync(githubEnv, 'TARBALL=' + tarball + '\n');
    fs.appendFileSync(githubEnv, 'CHANGELOG_SIZE=' + (changelog?.size ?? 0) + '\n');
  }
  return 0;
}

function runSummary(root: string): number {
  const notes = fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8');
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8')) as Array<{ filename?: string; files?: Array<{ path?: string }> }>;
  const tarballName = env('TARBALL') || pack[0]?.filename || '';
  const tarball = fs.readFileSync(path.join(root, tarballName));
  const ghVersion = requireSuccess(exec('gh', ['--version']), 'gh --version').split('\n')[0] ?? 'unknown';
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const ghCapabilities = deriveGhRequirements(source).map((requirement) =>
    'gh ' + requirement.command + (requirement.flags.length === 0 ? '' : ' ' + requirement.flags.join(' ')),
  );
  const report = renderSummary({
    dryRun: env('DRY_RUN') === 'true', version: env('VERSION'), distTag: env('DIST_TAG'),
    prerelease: env('PRERELEASE') === 'true', commit: env('GITHUB_SHA'),
    syncTag: env('MATCHING_SYNC_TAG') || 'absent',
    releasePoint: env('RELEASE_POINT_PASSED') === 'true' ? 'passes' : 'would refuse', releasePointMode: env('RELEASE_POINT_MODE'),
    latest: env('REGISTRY_LATEST') === 'absent' ? '' : env('REGISTRY_LATEST'),
    next: env('REGISTRY_NEXT') === 'absent' ? '' : env('REGISTRY_NEXT'),
    tarballName, size: tarball.length, sha256: sha256(tarball), sha512: sha512Integrity(tarball),
    ghVersion: ghVersion.trim(), ghCapabilities,
    historyFetchTime: env('HISTORY_FETCH_TIME'),
    changelogSize: Number(env('CHANGELOG_SIZE') || '0'), notes,
    packFiles: (pack[0]?.files ?? []).map((file) => file.path ?? '').filter(Boolean), skippedMalformedTags: JSON.parse(env('SKIPPED_RELEASE_TAGS_JSON') || '[]') as string[],
  });
  const summary = env('GITHUB_STEP_SUMMARY');
  if (summary === '') throw new ReleasePlanError('GITHUB_STEP_SUMMARY is missing.');
  fs.appendFileSync(summary, report + '\n');
  console.log('The release summary is ready for review.');
  return 0;
}

// eslint-disable-next-line complexity -- One registry read keeps version, integrity, provenance, and tags atomic.
function npmVersionSnapshot(name: string, version: string): PublishSnapshot {
  const versionRead = exec('npm', ['view', name + '@' + version, '--json']);
  if (versionRead.status !== 0) {
    let response: unknown;
    try { response = JSON.parse(versionRead.stdout) as unknown; } catch { response = undefined; }
    const error = plainRecord(response) && plainRecord(response.error) ? response.error : undefined;
    if (error?.code === 'E404') return { present: false, tags: readRegistryTags(name), provenance: false };
    throw new ReleasePlanError('Could not read the registry version: ' + (versionRead.stderr.trim() || versionRead.stdout.trim() || 'no detail'));
  }
  if (versionRead.stdout.trim() === '') return { present: false, tags: readRegistryTags(name), provenance: false };
  let decoded: unknown;
  try { decoded = JSON.parse(versionRead.stdout) as unknown; } catch { throw new ReleasePlanError('Could not read the registry version: output was not valid JSON.'); }
  if (!plainRecord(decoded)) throw new ReleasePlanError('Could not read the registry version: output must be a JSON object.');
  const dist = plainRecord(decoded.dist) ? decoded.dist : undefined;
  const attestations = dist !== undefined && plainRecord(dist.attestations) ? dist.attestations : undefined;
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity : undefined;
  const provenance = attestations !== undefined && Object.hasOwn(attestations, 'provenance') && attestations.provenance !== null;
  const tags = readRegistryTags(name);
  return {
    present: true,
    integrity,
    provenance,
    tags,
  };
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runManifest(root: string): number {
  const tarball = env('TARBALL');
  if (tarball === '') throw new ReleasePlanError('The package file path is missing.');
  const result = exec('tar', ['-xzOf', tarball, 'package/package.json'], { cwd: root });
  const raw = requireSuccess(result, 'read the package manifest');
  let manifest: unknown;
  try { manifest = JSON.parse(raw) as unknown; } catch { throw new ReleasePlanError('The package manifest is not valid JSON.'); }
  if (!plainRecord(manifest)) throw new ReleasePlanError('The package manifest must be a JSON object.');
  if (manifest.private === true) throw new ReleasePlanError('This package is marked private; nothing was published.');
  if (manifest.name !== 'replaytest') throw new ReleasePlanError('The package name is not replaytest.');
  if (manifest.version !== env('VERSION')) throw new ReleasePlanError('The package version differs from the requested version.');
  const channel = channelFor(String(manifest.version), env('NPM_TAG'));
  if (channel.dist_tag !== env('EXPECTED_DIST_TAG')) throw new ReleasePlanError('The package npm tag differs from the value checked before approval.');
  const githubEnv = env('GITHUB_ENV');
  if (githubEnv !== '') fs.appendFileSync(githubEnv, 'DIST_TAG=' + channel.dist_tag + '\n');
  console.log('The package manifest and npm tag are valid.');
  return 0;
}

function classifyPublish(_root: string): number {
  const name = 'replaytest';
  const version = env('VERSION');
  const channel = channelFor(version, env('NPM_TAG'));
  const tarball = env('TARBALL');
  const expectedSha = env('EXPECTED_TARBALL_SHA256');
  const expectedSha512 = env('EXPECTED_TARBALL_SHA512');
  verifyExpectedHash(tarball, expectedSha, 'package');
  if (expectedSha512 === '') throw new ReleasePlanError('The expected sha512 value is missing.');
  if (channel.dist_tag !== env('EXPECTED_DIST_TAG')) throw new ReleasePlanError('The selected npm tag differs from the value checked before approval.');
  const attempts = Number(env('GITHUB_RUN_ATTEMPT') || '1') > 1 ? 6 : 1;
  const reads: PublishSnapshot[] = [];
  for (let index = 0; index < attempts; index += 1) {
    process.stderr.write('Reading registry state ' + (index + 1) + ' of ' + attempts + '.\n');
    reads.push(npmVersionSnapshot(name, version));
    if (index + 1 < attempts) sleep(10_000);
  }
  const decision = decidePublish(reads, version, expectedSha512, channel);
  if (decision.mode === 'already-published') {
    process.stderr.write(decision.reason + '\n');
    process.stderr.write('Observed dist-tags: latest=' + (decision.tags.latest ?? 'absent') + ', next=' + (decision.tags.next ?? 'absent') + '; read at ' + new Date().toISOString() + '.\n');
    process.stdout.write('already-published');
    return 0;
  }
  checkOrdering(version, channel, decision.tags);
  process.stdout.write('publish');
  return 0;
}

function runCapabilities(root: string): number {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const requirements = deriveGhRequirements(source);
  const version = requireSuccess(exec('gh', ['--version']), 'gh --version').split('\n')[0] ?? 'unknown';
  console.log(version.trim());
  const help: Record<string, string> = {};
  for (const requirement of requirements) {
    const parts = requirement.command.split(' ');
    const result = exec('gh', [...parts, '--help'], { cwd: root });
    if (result.status !== 0) {
      console.error(requirement.command + ' --help failed: ' + (result.stderr.trim() || result.stdout.trim() || 'no detail'));
      return 1;
    }
    help[requirement.command] = result.stdout + '\n' + result.stderr;
  }
  const missing = checkGhHelp(requirements, help);
  if (missing.length > 0) {
    for (const item of missing) console.error('The installed gh is missing ' + item + '; nothing was published.');
    return 1;
  }
  for (const requirement of requirements) console.log('gh ' + requirement.command + ' is available.');
  return 0;
}

function ghJson(args: readonly string[], absentWords: readonly string[] = []): { status: 'present' | 'absent' | 'error'; json?: unknown; detail?: string } {
  const result = exec('gh', args);
  if (result.status === 0) {
    try { return { status: 'present', json: JSON.parse(result.stdout) as unknown }; }
    catch { return { status: 'error', detail: 'GitHub returned invalid JSON.' }; }
  }
  const detail = result.stderr.trim() || result.stdout.trim() || 'no detail';
  const normalized = detail.replace(/^gh:\s*/i, '').trim().toLowerCase();
  const confirmedNotFound = normalized === 'release not found' ||
    (/(?:http\s*)?404\b/.test(normalized) && /not found/.test(normalized));
  if (absentWords.length > 0 && confirmedNotFound) return { status: 'absent', detail };
  return { status: 'error', detail };
}

function peeledTag(repo: string, tag: string): { status: 'present' | 'absent' | 'error'; objectType?: string; commit?: string; detail?: string } {
  const ref = ghJson(['api', 'repos/' + repo + '/git/ref/tags/' + encodeURIComponent(tag)], ['HTTP 404', 'Not Found']);
  if (ref.status !== 'present') return { status: ref.status, detail: ref.detail };
  if (!plainRecord(ref.json) || !plainRecord(ref.json.object) || typeof ref.json.object.sha !== 'string' || typeof ref.json.object.type !== 'string') {
    return { status: 'error', detail: 'GitHub returned an unreadable tag reference.' };
  }
  let type = ref.json.object.type;
  let sha = ref.json.object.sha;
  let hops = 0;
  while (type === 'tag' && hops < 8) {
    const target = ghJson(['api', 'repos/' + repo + '/git/tags/' + sha]);
    if (target.status !== 'present' || !plainRecord(target.json) || !plainRecord(target.json.object) || typeof target.json.object.sha !== 'string' || typeof target.json.object.type !== 'string') {
      return { status: 'error', detail: target.detail ?? 'GitHub returned an unreadable annotated tag.' };
    }
    type = target.json.object.type;
    sha = target.json.object.sha;
    hops += 1;
  }
  if (type !== 'commit') return { status: 'error', detail: 'The release tag does not resolve to a commit.' };
  return { status: 'present', objectType: ref.json.object.type, commit: sha };
}

function releaseSnapshot(repo: string, tag: string): { status: 'present' | 'absent' | 'error'; release?: Record<string, unknown>; detail?: string } {
  const result = ghJson(['release', 'view', tag, '-R', repo, '--json', 'name,tagName,isDraft,isPrerelease,assets,body'], ['release not found', 'HTTP 404', 'Not Found']);
  if (result.status !== 'present') return { status: result.status, detail: result.detail };
  if (!plainRecord(result.json)) return { status: 'error', detail: 'GitHub returned an unreadable release.' };
  return { status: 'present', release: result.json };
}

function runGh(args: readonly string[], action: string): string {
  return requireSuccess(exec('gh', args), action);
}

// eslint-disable-next-line complexity -- Tag-first idempotency and release mutation order stay together for review.
function runRelease(root: string): number {
  const version = env('VERSION');
  parseVersion(version);
  const repo = env('GITHUB_REPOSITORY');
  const tag = 'v' + version;
  const commit = env('GITHUB_SHA');
  const tarballFiles = fs.readdirSync(path.join(root, 'release-candidate')).filter((name) => name.endsWith('.tgz'));
  if (tarballFiles.length !== 1) throw new ReleasePlanError('Expected exactly one package file; found ' + tarballFiles.length + '.');
  const tarballName = tarballFiles[0] ?? '';
  const tarball = path.join(root, 'release-candidate', tarballName);
  const notesPath = path.join(root, 'release-candidate', 'release-notes.md');
  const modulePath = path.join(root, 'release-candidate', 'release-plan.mts');
  const bundlePath = path.join(root, 'release-attestation', 'replaytest-' + version + '.sigstore.json');
  const expectedSha = env('EXPECTED_TARBALL_SHA256');
  const expectedNotes = env('EXPECTED_NOTES_SHA256');
  const expectedModule = env('EXPECTED_MODULE_SHA256');
  const expectedBundle = env('EXPECTED_BUNDLE_SHA256');
  verifyExpectedHash(tarball, expectedSha, 'package');
  verifyExpectedHash(notesPath, expectedNotes, 'notes');
  verifyExpectedHash(modulePath, expectedModule, 'release-plan module');
  verifyExpectedHash(bundlePath, expectedBundle, 'attestation bundle');
  const notes = fs.readFileSync(notesPath, 'utf8');
  const versionShape = channelFor(version, env('NPM_TAG'));
  if (String(versionShape.prerelease) !== env('EXPECTED_PRERELEASE') || String(versionShape.make_latest) !== env('EXPECTED_MAKE_LATEST')) {
    throw new ReleasePlanError('The GitHub release flags do not match the version shape.');
  }
  const expected = {
    version, commit, title: tag, prerelease: versionShape.prerelease,
    assets: ['replaytest-' + version + '.tgz', 'replaytest-' + version + '.sigstore.json'],
    sha256: expectedSha, notes,
  };
  const tagResult = peeledTag(repo, tag);
  if (tagResult.status === 'error') throw new ReleasePlanError('The release tag could not be read: ' + tagResult.detail);
  if (tagResult.status === 'present' && tagResult.commit !== commit) throw new ReleasePlanError('The release tag points at another commit; it was never moved.');
  const current = releaseSnapshot(repo, tag);
  if (current.status === 'error') throw new ReleasePlanError('The GitHub release could not be read: ' + current.detail);
  const release = current.release ?? {};
  const isDraft = current.status === 'present' && release.isDraft === true;
  if (isDraft) {
    const draftDecision = decideRelease({
      tagStatus: tagResult.status, tagObjectType: tagResult.objectType, tagCommit: tagResult.commit,
      releaseStatus: 'present', draft: true,
    }, expected);
    if (draftDecision.action !== 'delete-draft-and-create') throw new ReleasePlanError('The draft release decision was unexpected; no change was made.');
    runGh(['release', 'delete', tag, '-R', repo, '--yes'], 'delete the draft release');
  } else if (current.status === 'absent') {
    const absentDecision = decideRelease({
      tagStatus: tagResult.status, tagObjectType: tagResult.objectType, tagCommit: tagResult.commit,
      releaseStatus: 'absent',
    }, expected);
    if (absentDecision.action !== 'create') throw new ReleasePlanError('The absent release decision was unexpected; no change was made.');
  }
  if (current.status === 'present') {
    if (!isDraft) {
      const assetsValue = Array.isArray(release.assets) ? release.assets : [];
      const assetNames = assetsValue.flatMap((asset) => plainRecord(asset) && typeof asset.name === 'string' ? [asset.name] : []);
      if (tagResult.status !== 'present') throw new ReleasePlanError('A published release exists without its release tag; it was never moved or edited.');
      const tarballAsset = 'replaytest-' + version + '.tgz';
      const bundleAsset = 'replaytest-' + version + '.sigstore.json';
      const expectedAssets = [...expected.assets].sort();
      const actualAssets = [...assetNames].sort();
      if (actualAssets.length !== expectedAssets.length || actualAssets.some((asset, index) => asset !== expectedAssets[index])) {
        throw new ReleasePlanError('The published release asset set differs; it was never moved or edited.');
      }
      const downloaded = path.join(root, 'release-candidate', 'existing-release');
      fs.mkdirSync(downloaded, { recursive: true });
      runGh(['release', 'download', tag, '-R', repo, '--pattern', tarballAsset, '--dir', downloaded], 'download the published package');
      runGh(['release', 'download', tag, '-R', repo, '--pattern', bundleAsset, '--dir', downloaded], 'download the attached attestation');
      const existingTarball = path.join(downloaded, tarballAsset);
      const existingBundle = path.join(downloaded, bundleAsset);
      const verify = exec('gh', ['attestation', 'verify', existingTarball, '--bundle', existingBundle, '-R', repo, '--signer-workflow', repo + '/.github/workflows/release.yml', '--source-digest', commit]);
      const verified = classifyBundleVerification(verify.status, verify.stdout, verify.stderr);
      const decision = decideRelease({
        tagStatus: 'present', tagObjectType: tagResult.objectType, tagCommit: tagResult.commit,
        releaseStatus: 'present', draft: false,
        title: typeof release.name === 'string' ? release.name : '',
        prerelease: release.isPrerelease === true,
        assets: assetNames,
        body: typeof release.body === 'string' ? release.body : '',
        tarballSha256: fs.existsSync(existingTarball) ? sha256(fs.readFileSync(existingTarball)) : '',
        bundleVerified: verified.passed,
      }, expected);
      console.log(decision.reason);
      return 0;
    }
  }
  const flags = versionShape.prerelease ? ['--prerelease', '--latest=false'] : ['--latest'];
  runGh(['release', 'create', tag, '-R', repo, '--draft', '--target', commit, '--title', tag, '--notes-file', notesPath, ...flags], 'create the draft release');
  const packageNameForAsset = 'replaytest-' + version + '.tgz';
  const bundleNameForAsset = 'replaytest-' + version + '.sigstore.json';
  runGh(['release', 'upload', tag, tarball, bundlePath, '-R', repo], 'upload the release files');
  runGh(['release', 'edit', tag, '-R', repo, '--draft=false'], 'publish the release');
  console.log('The release is available with ' + packageNameForAsset + ' and ' + bundleNameForAsset + '.');
  return 0;
}

function main(): number {
  const root = rootFromModule();
  const command = process.argv[2] ?? '';
  try {
    if (command === 'release-point') return runReleasePoint(root);
    if (command === 'version') return runVersionPlan(root);
    if (command === 'capabilities') return runCapabilities(root);
    if (command === 'notes') return runNotes(root);
    if (command === 'pack') return runPack(root);
    if (command === 'summary') return runSummary(root);
    if (command === 'manifest') return runManifest(root);
    if (command === 'classify-publish') return classifyPublish(root);
    if (command === 'release') return runRelease(root);
    throw new ReleasePlanError('Unknown release-plan command.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) process.exitCode = main();
