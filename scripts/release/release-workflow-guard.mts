#!/usr/bin/env node

/* eslint-disable max-lines -- Keep the early-boot guard, its parser, and its pins auditable in one plain-node file. */

/**
 * The shape guard for this repository's GitHub Actions workflows.
 *
 * It is a PURE function over an in-memory map of workflow path -> file text, for
 * one load-bearing reason: several of the defects it exists to catch (a
 * fork-PR-privileged trigger, an unpinned action, a cache key on the release
 * path) can only be proven by a test that PLANTS them, and a workflow file with
 * one of those defects in it must never exist on disk, even for a moment. The
 * workflow files on disk are never mutated by this guard or its tests: the
 * runner test reads the real files and asserts zero findings, and every plant
 * runs against an in-memory copy of the map.
 *
 * Runs under plain `node` (type-stripping only, no tsx): the release workflow
 * calls `meetsVersionFloor` from it before any dependency has been installed.
 *
 * A note for whoever edits `release.yml` next: the pinned literals here — the
 * publish command, the publish job's `if:`, and the three guard conditionals —
 * are byte-exact shell and expression text. `${OWNER}` for `$OWNER`, a line
 * split, or one extra space reds the guard. That is deliberate (inverting one
 * operator in a guard is the whole attack it defends against), but it means a
 * legitimate reformat of the workflow needs the matching one-line edit here, in
 * the same commit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_WORKFLOW,
  CI_WORKFLOW,
  AUDIT_WORKFLOW,
  WORKFLOW_PATHS,
  EXPECTED_USES_COUNT,
  EXPECTED_TRIGGERS,
  PUBLISH_IF,
  BANNED_EXEC_TOKENS,
  PUBLISH_COMMAND,
  BLOCK_SCALAR_HEADER,
  PREFLIGHT_GUARD_BLOCKS,
  PUBLISH_GUARD_BLOCKS,
  PREFLIGHT_SAFETY_LINES,
  NEUTERING_SUFFIXES,
  RELEASE_COMMAND,
  EXPECTED_JOBS,
  WORKFLOW_RUNNER,
  USES_LINE,
  PINNED_USES,
  VERSION_COMMENT,
  PERMISSION_SCOPES,
  BANNED_STEP_KEYS,
  RELEASE_WORKFLOW_KEYS,
  RELEASE_JOB_KEYS,
  RELEASE_JOB_ENV_KEYS,
  RELEASE_STEP_ENV_KEYS,
  RELEASE_STEP_ENV_VALUES,
  RELEASE_NEEDS,
  RELEASE_OUTPUT_PRODUCERS,
  RELEASE_WRITE_GRANTS,
  RELEASE_SCRIPT_SHA256,
  ALLOWED_STEP_KEYS,
  PREFLIGHT_MANIFEST_STEP,
  PREFLIGHT_MANIFEST_GATE,
  PREFLIGHT_MANIFEST_TEST,
  PREFLIGHT_MANIFEST_SCRIPT,
} from './release-workflow-policy.mts';

export { RELEASE_WORKFLOW, CI_WORKFLOW, AUDIT_WORKFLOW, WORKFLOW_PATHS } from './release-workflow-policy.mts';

export interface Finding {
  pin: number;
  file: string;
  message: string;
}

function fileLines(text: string): string[] {
  return text.split('\n');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** Drops whole-line comments; a comment can never configure anything. */
function withoutComments(text: string): string {
  return fileLines(text).filter((line) => !line.trim().startsWith('#')).join('\n');
}

/**
 * The lines nested under `lines[headerIndex]` — everything more indented than the
 * header, blank lines included, up to the first line at the header's own indent.
 */
function nestedLines(lines: readonly string[], headerIndex: number): string[] {
  const baseIndent = indentOf(lines[headerIndex] ?? '');
  const body: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (isIgnorable(line)) {
      body.push(line);
      continue;
    }
    if (indentOf(line) <= baseIndent) break;
    body.push(line);
  }
  return body;
}

function headerIndex(lines: readonly string[], key: string, atIndent: number): number {
  return lines.findIndex((line) => !isIgnorable(line) && indentOf(line) === atIndent && mappingLine(line)?.key === key);
}

function minimumIndent(lines: readonly string[]): number {
  const meaningful = lines.filter((line) => !isIgnorable(line));
  return meaningful.length === 0 ? 0 : Math.min(...meaningful.map(indentOf));
}

/** The body of a top-level `key:` block, or undefined when the key is absent. */
function topLevelBlock(text: string, key: string): string[] | undefined {
  const lines = fileLines(text);
  const index = headerIndex(lines, key, minimumIndent(lines));
  return index === -1 ? undefined : nestedLines(lines, index);
}

/** The body of one job under `jobs:`, or undefined when the job is absent. */
function jobBlock(text: string, jobName: string): string[] | undefined {
  const jobs = topLevelBlock(text, 'jobs');
  if (jobs === undefined) return undefined;
  const index = headerIndex(jobs, jobName, minimumIndent(jobs));
  return index === -1 || mappingLine(jobs[index] ?? '')?.value !== '' ? undefined : nestedLines(jobs, index);
}

/** The immediate child keys of a block (one nesting level down, comments dropped). */
function childKeys(body: readonly string[]): string[] {
  const meaningful = body.filter((line) => !isIgnorable(line));
  if (meaningful.length === 0) return [];
  const childIndent = Math.min(...meaningful.map(indentOf));
  const keys: string[] = [];
  for (const line of meaningful) {
    if (indentOf(line) !== childIndent) continue;
    const parsed = mappingLine(line);
    if (parsed !== undefined) keys.push(parsed.key);
  }
  return keys;
}

/** `key: value` pairs at the shallowest level of a block, as written. */
function childEntries(body: readonly string[]): string[] {
  const meaningful = body.filter((line) => !isIgnorable(line));
  if (meaningful.length === 0) return [];
  const childIndent = Math.min(...meaningful.map(indentOf));
  return meaningful.filter((line) => indentOf(line) === childIndent).map((line) => line.trim());
}

type PermissionScope = (typeof PERMISSION_SCOPES)[number];
type PermissionLevel = 'none' | 'read' | 'write';
type PermissionMap = Record<PermissionScope, PermissionLevel>;

interface ParsedPermissionBlock {
  present: boolean;
  raw: string;
  permissions?: PermissionMap;
  error?: string;
}

interface WorkflowPermissionAnalysis {
  workflow: ParsedPermissionBlock;
  jobs: ReadonlyMap<string, PermissionMap | undefined>;
}

function emptyPermissions(): PermissionMap {
  return Object.fromEntries(PERMISSION_SCOPES.map((scope) => [scope, 'none'])) as PermissionMap;
}

/** Removes a YAML trailing comment without treating a quoted `#` as one. */
function stripYamlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(value[index - 1] ?? ''))) return value.slice(0, index).trimEnd();
  }
  return value;
}

/** Finds a delimiter outside quoted scalars. */
function delimiterIndex(value: string, delimiter: string): number {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === delimiter) return index;
  }
  return -1;
}

/** Decodes only plain identifier scalars and their single/double-quoted forms. */
function permissionScalar(token: string): string | undefined {
  const trimmed = token.trim();
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  if (first === "'" || first === '"') {
    if (trimmed.length < 2 || trimmed.at(-1) !== first) return undefined;
    const inner = trimmed.slice(1, -1);
    if (inner.length === 0 || /[\\'"\s]/.test(inner)) return undefined;
    return /^[A-Za-z0-9_-]+$/.test(inner) ? inner : undefined;
  }
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

interface MappingLine { key: string; value: string }

function mappingLine(line: string): MappingLine | undefined {
  const uncommented = stripYamlComment(line).trim();
  const colon = delimiterIndex(uncommented, ':');
  if (colon === -1) return undefined;
  const key = permissionScalar(uncommented.slice(0, colon));
  if (key === undefined) return undefined;
  return { key, value: uncommented.slice(colon + 1).trim() };
}

function splitFlowEntries(value: string): string[] | undefined {
  const entries: string[] = [];
  let quote: "'" | '"' | undefined;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ',') {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote !== undefined) return undefined;
  entries.push(value.slice(start).trim());
  return entries;
}

function applyPermissionEntry(target: PermissionMap, keyToken: string, valueToken: string): string | undefined {
  const key = permissionScalar(keyToken);
  const value = permissionScalar(valueToken);
  if (key === undefined) return `unrecognised permission key ${JSON.stringify(keyToken.trim())}`;
  if (!(PERMISSION_SCOPES as readonly string[]).includes(key)) return `unknown permission scope ${JSON.stringify(key)}`;
  if (value !== 'none' && value !== 'read' && value !== 'write') return `unrecognised value ${JSON.stringify(valueToken.trim())} for ${key}`;
  if (key === 'id-token' && value === 'read') return '`id-token` supports only `write` or `none`';
  target[key as PermissionScope] = value;
  return undefined;
}

function parsePermissionMapping(entries: readonly MappingLine[]): { permissions?: PermissionMap; error?: string } {
  const permissions = emptyPermissions();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) return { error: `duplicate permission scope ${JSON.stringify(entry.key)}` };
    seen.add(entry.key);
    const error = applyPermissionEntry(permissions, entry.key, entry.value);
    if (error !== undefined) return { error };
  }
  return { permissions };
}

function parseFlowPermissions(value: string): { permissions?: PermissionMap; error?: string } {
  if (!value.startsWith('{') || !value.endsWith('}')) return { error: 'flow permissions must be a single-line mapping in braces' };
  const inside = value.slice(1, -1).trim();
  if (inside === '') return { permissions: emptyPermissions() };
  const pairs = splitFlowEntries(inside);
  if (pairs === undefined || pairs.some((pair) => pair === '')) return { error: 'flow permissions contain an unterminated quote or empty entry' };
  const entries: MappingLine[] = [];
  for (const pair of pairs) {
    const colon = delimiterIndex(pair, ':');
    if (colon === -1) return { error: `flow entry ${JSON.stringify(pair)} is not a key/value pair` };
    const key = permissionScalar(pair.slice(0, colon));
    if (key === undefined) return { error: `unrecognised permission key ${JSON.stringify(pair.slice(0, colon).trim())}` };
    entries.push({ key, value: pair.slice(colon + 1).trim() });
  }
  return parsePermissionMapping(entries);
}

function parsePermissionValue(value: string): { permissions?: PermissionMap; error?: string } {
  const scalar = permissionScalar(value);
  if (scalar === 'write-all' || scalar === 'read-all') {
    const permissions = emptyPermissions();
    for (const scope of PERMISSION_SCOPES) {
      // GitHub's OIDC permission is write-only; read-all does not grant an OIDC token.
      permissions[scope] = scalar === 'write-all' ? 'write' : scope === 'id-token' ? 'none' : 'read';
    }
    return { permissions };
  }
  if (value.trim().startsWith('{')) return parseFlowPermissions(value.trim());
  return { error: `unrecognised permissions value ${JSON.stringify(value.trim())}` };
}

function permissionHeaderLike(line: string): boolean {
  const trimmed = stripYamlComment(line).trim();
  return /^(?:permissions|['"]permissions['"])(?:\s|:|$)/i.test(trimmed);
}

interface PermissionHeaderScan { matches: number[]; malformed: boolean }

function findPermissionHeader(lines: readonly string[], atIndent: number): PermissionHeaderScan {
  const matches: number[] = [];
  let malformed = false;
  for (const [index, line] of lines.entries()) {
    if (isIgnorable(line) || indentOf(line) !== atIndent) continue;
    if (unsupportedMappingKey(line) || mappingLine(line) === undefined) { malformed = true; continue; }
    if (!permissionHeaderLike(line)) continue;
    const parsed = mappingLine(line);
    if (parsed?.key === 'permissions') matches.push(index);
    else malformed = true;
  }
  return { matches, malformed };
}

/** YAML key features this small reader cannot safely interpret. */
function unsupportedMappingKey(line: string): boolean {
  const key = stripYamlComment(line).trim().split(':')[0] ?? '';
  return /^[?&*]/.test(key) || /^<<\s*$/.test(key) || (/^['"]/.test(key) && key.includes('\\'));
}

function parsePermissionBlock(lines: readonly string[], index: number, raw: string): ParsedPermissionBlock {
  const body = nestedLines(lines, index).filter((line) => !isIgnorable(line));
  if (body.length === 0) return { present: true, raw, error: 'an empty permissions block is not a mapping; use `{}` for no permissions' };
  if (body.some((line) => /^\s*\t/.test(line))) return { present: true, raw, error: 'tabs are not supported in permissions indentation' };
  const entryIndent = Math.min(...body.map(indentOf));
  const entries: MappingLine[] = [];
  for (const line of body) {
    if (indentOf(line) !== entryIndent) return { present: true, raw, error: 'nested permissions mappings are not recognised' };
    const parsed = mappingLine(line);
    if (parsed === undefined || parsed.value === '') return { present: true, raw, error: `permission entry ${JSON.stringify(line.trim())} is not a scalar key/value pair` };
    entries.push(parsed);
  }
  const parsed = parsePermissionMapping(entries);
  return parsed.permissions === undefined ? { present: true, raw, error: parsed.error } : { present: true, raw, permissions: parsed.permissions };
}

function parsePermissionHeader(lines: readonly string[], index: number, header: string): ParsedPermissionBlock {
  const raw = header.trim();
  const parsedHeader = mappingLine(header);
  if (parsedHeader === undefined) return { present: true, raw, error: 'the permissions key is malformed' };
  const inline = parsedHeader.value;
  if (inline !== '') {
    const hasChildren = nestedLines(lines, index).some((line) => !isIgnorable(line));
    if (hasChildren) return { present: true, raw, error: 'an inline permissions value also has nested entries' };
    const parsed = parsePermissionValue(stripYamlComment(inline).trim());
    return parsed.permissions === undefined ? { present: true, raw, error: parsed.error } : { present: true, raw, permissions: parsed.permissions };
  }
  return parsePermissionBlock(lines, index, raw);
}

function permissionEntry(lines: readonly string[], atIndent: number): ParsedPermissionBlock {
  const scan = findPermissionHeader(lines, atIndent);
  if (scan.matches.length === 0 && !scan.malformed) return { present: false, raw: '(absent)' };
  const index = scan.matches[0];
  if (scan.matches.length !== 1 || scan.malformed || index === undefined) {
    return { present: true, raw: lines[index ?? 0]?.trim() ?? '(malformed)', error: 'the permissions key is duplicated, malformed, or uses unsupported YAML key syntax (including tags, explicit keys, anchors, aliases, merges, or escapes)' };
  }
  const header = lines[index];
  if (header === undefined) return { present: true, raw: '(malformed)', error: 'the permissions key is malformed' };
  return parsePermissionHeader(lines, index, header);
}

function expectedPermissions(entries: Partial<Record<PermissionScope, PermissionLevel>>): PermissionMap {
  return { ...emptyPermissions(), ...entries };
}

function permissionMapsEqual(left: PermissionMap | undefined, right: PermissionMap): boolean {
  return left !== undefined && PERMISSION_SCOPES.every((scope) => left[scope] === right[scope]);
}

function permissionEntries(permissions: PermissionMap | undefined): string[] {
  if (permissions === undefined) return ['(unreadable)'];
  return PERMISSION_SCOPES.filter((scope) => permissions[scope] !== 'none')
    .map((scope) => `${scope}: ${permissions[scope]}`);
}

function checkJobKeys(file: string, jobsBody: readonly string[], findings: Finding[]): void {
  for (const line of jobsBody) {
    if (isIgnorable(line) || indentOf(line) !== minimumIndent(jobsBody)) continue;
    const parsed = mappingLine(line);
    if (parsed === undefined || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(parsed.key)) {
      findings.push(finding(20, file, `job key could not be read: ${JSON.stringify(line.trim())}`));
    } else if (jobsBody.filter((candidate) => indentOf(candidate) === indentOf(line) && mappingLine(candidate)?.key === parsed.key).length !== 1) {
      findings.push(finding(20, file, `duplicate job key ${JSON.stringify(parsed.key)}`));
    }
  }
}

function analyzeWorkflowPermissions(file: string, text: string, findings: Finding[]): WorkflowPermissionAnalysis {
  const clean = withoutComments(text);
  const workflow = permissionEntry(fileLines(clean), minimumIndent(fileLines(clean)));
  if (workflow.error !== undefined) findings.push(finding(20, file, `workflow-level permissions could not be read: ${workflow.error}`));
  const jobsBody = topLevelBlock(clean, 'jobs');
  const jobs = new Map<string, PermissionMap | undefined>();
  checkJobKeys(file, jobsBody ?? [], findings);
  for (const jobName of jobsBody === undefined ? [] : childKeys(jobsBody)) {
    const body = jobBlock(clean, jobName);
    if (body === undefined || body.every(isIgnorable)) {
      jobs.set(jobName, undefined);
      findings.push(finding(20, file, `the \`${jobName}\` job body could not be read; effective permissions cannot be determined`));
      continue;
    }
    const own = permissionEntry(body, minimumIndent(body));
    if (own.error !== undefined) findings.push(finding(20, file, `the \`${jobName}\` job permissions could not be read: ${own.error}`));
    if (own.present) {
      jobs.set(jobName, own.permissions);
    } else if (workflow.permissions !== undefined) {
      jobs.set(jobName, workflow.permissions);
    } else {
      jobs.set(jobName, undefined);
      if (workflow.error === undefined) {
        findings.push(finding(20, file, `the \`${jobName}\` job's effective permissions cannot be determined because neither it nor the workflow declares a permissions mapping`));
      }
    }
  }
  return { workflow, jobs };
}

/** Whole-file grant backstop, independent of permission/job enumeration. */
function checkPermissionBackstop(file: string, text: string, analysis: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const nonComment = fileLines(withoutComments(text)).map(stripYamlComment).join('\n');
  for (const scope of PERMISSION_SCOPES) {
    const observed = [...nonComment.matchAll(new RegExp(`['"]?${scope}['"]?\\s*:\\s*['"]?write(?:['"]|\\b)`, 'gi'))].length;
    const accounted = [...analysis.jobs.entries()].filter(([job, permissions]) =>
      permissions?.[scope] === 'write' && RELEASE_WRITE_GRANTS.some((grant) =>
        grant.workflow === file && grant.job === job && grant.scope === scope)).length;
    if (observed !== accounted) findings.push(finding(7, file, `whole-file backstop found ${observed} ${scope} write grants; effective jobs account for ${accounted} permitted grants`));
  }
  if (/write-all/i.test(nonComment)) {
    findings.push(finding(7, file, 'whole-file backstop found `write-all`; no job may take every write scope'));
  }
}

function checkPrivilegedPermissions(file: string, analysis: WorkflowPermissionAnalysis, findings: Finding[]): void {
  for (const [jobName, permissions] of analysis.jobs) {
    if (permissions === undefined) continue;
    for (const scope of PERMISSION_SCOPES) {
      const allowed = RELEASE_WRITE_GRANTS.some((grant) => grant.workflow === file && grant.job === jobName && grant.scope === scope);
      if (permissions[scope] !== 'write' || allowed) continue;
      const message = scope === 'id-token'
        ? `the \`${jobName}\` job requests an OIDC token; only the release workflow's publish job may`
        : `the \`${jobName}\` job takes \`${scope}: write\`; only literal write-grant table entries are allowed`;
      findings.push(finding(20, file, message));
    }
  }
}

function checkOidcPermissionCount(file: string, analysis: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const count = [...analysis.jobs.values()].filter((permissions) => permissions?.['id-token'] === 'write').length;
  const expected = file === RELEASE_WORKFLOW ? 1 : 0;
  if (count === expected) return;
  const message = file === RELEASE_WORKFLOW
      ? `the effective \`id-token: write\` grant appears in ${count} job(s); exactly one job (publish) may request it`
      : `the effective \`id-token: write\` grant appears in ${count} job(s); only the release workflow's publish job may request it`;
  findings.push(finding(7, file, message));
}

/**
 * Every `run:` script body in a file — both the inline `run: cmd` form and the
 * `run: |` block form. Used by the must-not-appear pin on expression
 * interpolation: an operator-typed value reaching a shell through `${{ }}` is
 * script injection, so no expression of any kind may sit inside a run script.
 */
function runScripts(text: string): string[] {
  const lines = fileLines(text);
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = new RegExp('^\\s*-?\\s*run:\\s*(.*)$').exec(line);
    if (match === null) continue;
    const inline = (match[1] ?? '').trim();
    // Any block-scalar header, not just the four plain ones: YAML allows a chomp
    // indicator and an explicit indentation digit, in either order, and Actions
    // treats `|+`, `|2`, `>-2` exactly like `|`. Reading those as inline commands
    // meant the body beneath them was never collected — and the pin that forbids
    // an expression inside a shell script would then fail OPEN, which is the one
    // direction a must-not-appear pin must never fail in.
    if (inline === '' || BLOCK_SCALAR_HEADER.test(inline)) {
      scripts.push(nestedLines(lines, index).join('\n'));
      continue;
    }
    // A plain scalar may also continue onto more-indented lines; a quoted scalar
    // is taken with its quotes intact, which is enough for substring pins.
    scripts.push([inline, ...nestedLines(lines, index)].join('\n'));
  }
  return scripts;
}

/**
 * The FIRST step of a job, as written — from its `- ` list marker to the next
 * one. Order is the point: a guard that has been shuffled below `setup-node` and
 * the artifact download is no longer the thing standing in front of them.
 */
/** Every step of a job, split at its own `- ` list markers. */
function stepBlocks(jobBody: readonly string[]): string[] {
  const stepsIndex = headerIndex(jobBody, 'steps', minimumIndent(jobBody));
  if (stepsIndex === -1) return [];
  const steps = nestedLines(jobBody, stepsIndex);
  const starts: number[] = [];
  const itemIndent = minimumIndent(steps);
  for (const [index, line] of steps.entries()) {
    if (!line.trim().startsWith('- ')) continue;
    if (indentOf(line) === itemIndent) starts.push(index);
  }
  return starts.map((start, position) => steps.slice(start, starts[position + 1] ?? steps.length).join('\n'));
}

function exactKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && expected.every((key) => actual.includes(key));
}

/** Decode every immediate key, including malformed/duplicate keys, before comparing. */
function exactMappingKeys(lines: readonly string[], expected: readonly string[]): boolean {
  const keys: string[] = [];
  for (const line of lines) {
    if (isIgnorable(line) || indentOf(line) !== minimumIndent(lines)) continue;
    const entry = mappingLine(line);
    if (/^\s*\t/.test(line) || entry === undefined) return false;
    keys.push(entry.key);
  }
  return exactKeys(keys, expected);
}

function checkJobRunners(workflowPath: string, text: string, findings: Finding[]): void {
  const jobs = topLevelBlock(text, 'jobs');
  for (const jobName of jobs === undefined ? [] : childKeys(jobs)) {
    const body = jobBlock(text, jobName) ?? [];
    const runners = body.filter((line) => !isIgnorable(line) && indentOf(line) === minimumIndent(body))
      .map(mappingLine).filter((entry) => entry?.key === 'runs-on');
    if (runners.length !== 1 || runners[0]?.value !== WORKFLOW_RUNNER) {
      findings.push(finding(23, workflowPath, `the \`${jobName}\` job must pin runs-on to ${WORKFLOW_RUNNER}`));
    }
  }
}

// eslint-disable-next-line complexity -- A single fail-closed walk catches unlisted jobs and exact mapping drift.
function checkReleaseMappingKeys(text: string, findings: Finding[]): void {
  const refuse = (reason: string): void => { findings.push(finding(22, RELEASE_WORKFLOW, reason)); };
  if (!exactMappingKeys(fileLines(text), RELEASE_WORKFLOW_KEYS)) refuse('workflow-level keys must be exactly name, on, permissions, concurrency, jobs; defaults and other additions are forbidden');
  const jobs = topLevelBlock(text, 'jobs');
  for (const jobName of jobs === undefined ? [] : childKeys(jobs)) {
    const keys = RELEASE_JOB_KEYS[jobName];
    const envTable = RELEASE_JOB_ENV_KEYS[jobName];
    if (keys === undefined || envTable === undefined || RELEASE_NEEDS[jobName] === undefined) {
      refuse(`the real \`${jobName}\` job has no key, env, or needs policy row`);
      continue;
    }
    const body = jobBlock(text, jobName) ?? [];
    if (!exactMappingKeys(body, keys)) refuse(`the \`${jobName}\` job keys must be exactly ${keys.join(', ')}; defaults, continue-on-error, and other additions are forbidden`);
    const envIndex = headerIndex(body, 'env', minimumIndent(body));
    const env = envIndex === -1 ? undefined : envEntries(body, envIndex, mappingLine(body[envIndex] ?? '')?.value ?? '');
    const expectedEnv = Object.entries(envTable);
    if (env === undefined || !exactKeys(env.map((entry) => entry.key), expectedEnv.map(([key]) => key)) ||
        expectedEnv.some(([key, value]) => env.find((entry) => entry.key === key)?.value !== value)) {
      refuse(`the \`${jobName}\` job env mapping must exactly match its key/value policy table`);
    }
    const needs = childEntries(body).find((entry) => entry.startsWith('needs:'))?.slice('needs:'.length).trim() ?? '';
    if (needs !== RELEASE_NEEDS[jobName]) refuse(`the \`${jobName}\` job needs value must be exactly ${RELEASE_NEEDS[jobName] || '(absent)'}`);
    const outputRows = RELEASE_OUTPUT_PRODUCERS[jobName];
    if (outputRows !== undefined) {
      const outputIndex = headerIndex(body, 'outputs', minimumIndent(body));
      const actualOutputs = outputIndex === -1 ? undefined : envEntries(body, outputIndex, mappingLine(body[outputIndex] ?? '')?.value ?? '');
      const expectedOutputs = Object.entries(outputRows);
      if (actualOutputs === undefined || !exactKeys(actualOutputs.map((entry) => entry.key), expectedOutputs.map(([key]) => key)) ||
          expectedOutputs.some(([key, value]) => actualOutputs.find((entry) => entry.key === key)?.value !== value)) {
        refuse(`the \`${jobName}\` job outputs must exactly match their named producer step and output table`);
      }
    }
  }
}

/** Reads only mapping attributes, never keys in scripts or nested action inputs. */
function stepAttributes(lines: string[]): { index: number; entry: MappingLine }[] | undefined {
  const first = lines[0] ?? '';
  const marker = /^\s*-\s+/.exec(first)?.[0] ?? '';
  // Replace only the sequence marker; the key keeps its YAML mapping column.
  lines[0] = ' '.repeat(marker.length) + first.slice(marker.length);
  const attributes: { index: number; entry: MappingLine }[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (/^\s*\t/.test(line)) return undefined;
    if (isIgnorable(line) || indentOf(line) > marker.length) continue;
    const entry = mappingLine(line);
    if (indentOf(line) !== marker.length || entry === undefined || !ALLOWED_STEP_KEYS.includes(entry.key) || seen.has(entry.key)) return undefined;
    seen.add(entry.key);
    attributes.push({ index, entry });
  }
  return attributes;
}

function envEntries(lines: readonly string[], index: number, value: string): MappingLine[] | undefined {
  const body = nestedLines(lines, index).filter((line) => !isIgnorable(line));
  if (body.some((line) => /^\s*\t/.test(line))) return undefined;
  let entries: string[] | undefined;
  if (value === '') {
    if (body.length === 0 || body.some((line) => indentOf(line) !== minimumIndent(body))) return undefined;
    entries = body;
  } else if (value.startsWith('{') && value.endsWith('}') && body.length === 0) {
    const inside = value.slice(1, -1).trim();
    entries = inside === '' ? [] : splitFlowEntries(inside);
  }
  const decoded = entries?.map(mappingLine);
  if (decoded === undefined || decoded.some((entry) => entry === undefined || entry.value === '') ||
      new Set(decoded.map((entry) => entry?.key)).size !== decoded.length) return undefined;
  return decoded as MappingLine[];
}

function checkStepBlock(block: string, expectedEnvValues: Readonly<Record<string, string>>, refuse: (reason: string) => void): void {
  const lines = fileLines(block);
  const attributes = stepAttributes(lines);
  if (attributes === undefined) {
    refuse('could not be read: unsupported, duplicate, or tab-indented step key');
    return;
  }
  const actualEnvKeys: string[] = [];
  for (const { index, entry } of attributes) {
    if ((BANNED_STEP_KEYS as readonly string[]).includes(entry.key)) refuse(`must not contain step-level \`${entry.key}:\``);
    if (entry.key !== 'env') continue;
    const env = envEntries(lines, index, entry.value);
    if (env === undefined) {
      refuse('could not be read: step-level env must be a mapping of distinct scalar entries');
      continue;
    }
    for (const entry of env) {
      actualEnvKeys.push(entry.key);
      if (Object.values(RELEASE_JOB_ENV_KEYS).some((values) => Object.hasOwn(values, entry.key))) refuse(`must not shadow job-level \`${entry.key}\` in step-level \`env:\``);
    }
  }
  const expectedEnvKeys = Object.keys(expectedEnvValues);
  if (!exactKeys(actualEnvKeys, expectedEnvKeys)) refuse(`env keys must be exactly [${expectedEnvKeys.join(', ')}]; new, missing, or moved step env keys are forbidden`);
  const parsedAttributes = stepAttributes(fileLines(block));
  const envAttribute = parsedAttributes?.find(({ entry }) => entry.key === 'env');
  const actualEnv = envAttribute === undefined ? [] : envEntries(fileLines(block), envAttribute.index, envAttribute.entry.value) ?? [];
  for (const [key, value] of Object.entries(expectedEnvValues)) {
    if (actualEnv.find((entry) => entry.key === key)?.value !== value) refuse(`step env value for \`${key}\` must be exactly \`${value}\``);
  }
}

function readableStepBlocks(body: readonly string[]): string[] | undefined {
  const headers = body.filter((line) => indentOf(line) === minimumIndent(body) && mappingLine(line)?.key === 'steps');
  const index = headerIndex(body, 'steps', minimumIndent(body));
  const steps = index === -1 ? [] : nestedLines(body, index).filter((line) => !isIgnorable(line));
  const blocks = stepBlocks(body);
  if (headers.length !== 1 || mappingLine(headers[0] ?? '')?.value !== '' || steps.length === 0 ||
      steps.some((line) => indentOf(line) === minimumIndent(steps) && !line.trim().startsWith('- ')) || blocks.length === 0) return undefined;
  return blocks;
}

/** Every step, including ordinary setup steps, must leave release gates effective. */
function checkReleaseStepAttributes(text: string, findings: Finding[]): void {
  const clean = withoutComments(text);
  const jobs = topLevelBlock(clean, 'jobs');
  for (const jobName of jobs === undefined ? [] : childKeys(jobs)) {
    const refuse = (reason: string): void => { findings.push(finding(22, RELEASE_WORKFLOW, `the \`${jobName}\` job's step attributes ${reason}`)); };
    const body = jobBlock(clean, jobName);
    const blocks = body === undefined ? undefined : readableStepBlocks(body);
    if (blocks === undefined) refuse('could not be read: steps must be a block sequence of mappings');
    else {
      const expected = RELEASE_STEP_ENV_KEYS[jobName];
      const values = RELEASE_STEP_ENV_VALUES[jobName];
      if (expected === undefined || values === undefined) {
        refuse('has no positional env policy row');
        continue;
      }
      if (blocks.length !== expected.length) refuse(`env layout requires exactly ${expected.length} steps, found ${blocks.length}`);
      for (const [index, block] of blocks.entries()) checkStepBlock(block, values[index] ?? {}, refuse);
    }
  }
}

/**
 * The script of the step that carries a given name — the step's OWN body, not
 * the job's text. Searching a whole job for a fragment proves the fragment is
 * somewhere; it does not prove the named step runs it. An `echo` of the same
 * characters in a neighbouring step satisfies the one and not the other.
 */
function namedStepScript(jobBody: readonly string[], stepName: string): string | undefined {
  const block = stepBlocks(jobBody).find((step) => step.includes(`- name: ${stepName}`));
  return block === undefined ? undefined : runScripts(block)[0];
}

/** The hand-off contract tests execute the exact run bytes through this parser. */
export function readJobStepScripts(workflowText: string, jobName: string): string[] {
  const job = jobBlock(withoutComments(workflowText), jobName);
  return job === undefined ? [] : stepBlocks(job).flatMap((step) => {
    const scripts = runScripts(step);
    return scripts.length === 0 ? [] : [scripts[0] ?? ''];
  });
}

export function readNamedStepScript(workflowText: string, jobName: string, stepName: string): string | undefined {
  const job = jobBlock(withoutComments(workflowText), jobName);
  return job === undefined ? undefined : namedStepScript(job, stepName);
}

function firstStepBlock(jobBody: readonly string[]): string | undefined {
  return stepBlocks(jobBody)[0];
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function finding(pin: number, file: string, message: string): Finding {
  return { pin, file, message };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function checkTriggers(file: string, text: string, pin: number, findings: Finding[]): void {
  const block = topLevelBlock(text, 'on');
  if (block === undefined) {
    findings.push(finding(pin, file, 'no `on:` block — the trigger set cannot be verified'));
    return;
  }
  const actual = sortedUnique(childKeys(block));
  const expected = [...(EXPECTED_TRIGGERS[file] ?? [])].sort();
  if (actual.join(',') !== expected.join(',')) {
    findings.push(finding(pin, file, `trigger set is [${actual.join(', ')}]; it must be exactly [${expected.join(', ')}]`));
  }
}

function checkUses(file: string, text: string, findings: Finding[]): void {
  const usesLines = fileLines(text).map((line) => line.trim()).filter((line) => new RegExp('^-?\\s*uses:').test(line));
  const expectedCount = EXPECTED_USES_COUNT[file];
  if (expectedCount !== undefined && usesLines.length !== expectedCount) {
    findings.push(finding(3, file, `has ${usesLines.length} \`uses:\` lines; exactly ${expectedCount} are expected`));
  }
  for (const line of usesLines) {
    const match = USES_LINE.exec(line);
    const reference = match?.[1];
    const comment = (match?.[2] ?? '').trim();
    if (reference === undefined || !PINNED_USES.test(reference)) {
      findings.push(finding(3, file, `\`${line}\` is not \`actions/<repo>@<40-hex sha>\` — only GitHub-owned, commit-pinned actions are allowed`));
      continue;
    }
    if (!VERSION_COMMENT.test(comment)) {
      findings.push(finding(3, file, `\`${line}\` has no trailing \`# vX.Y.Z\` comment naming the pinned release`));
    }
  }
}

function checkTopLevelReadPermissions(file: string, permissions: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const entries = permissionEntries(permissions.workflow.permissions);
  if (!permissionMapsEqual(permissions.workflow.permissions, expectedPermissions({ contents: 'read' }))) {
    findings.push(finding(11, file, `workflow-level permissions are [${entries.join(', ')}]; they must be exactly \`contents: read\``));
  }
}

// eslint-disable-next-line complexity -- The dispatch schema is one closed mapping and every field is checked together.
function checkReleaseTriggerInputs(text: string, findings: Finding[]): void {
  const on = topLevelBlock(text, 'on');
  const dispatchIndex = on === undefined ? -1 : headerIndex(on, 'workflow_dispatch', 2);
  if (on === undefined || dispatchIndex === -1) {
    findings.push(finding(5, RELEASE_WORKFLOW, 'no `workflow_dispatch:` block — the inputs cannot be verified'));
    return;
  }
  const dispatch = nestedLines(on, dispatchIndex);
  const inputsIndex = headerIndex(dispatch, 'inputs', 4);
  if (inputsIndex === -1) {
    findings.push(finding(5, RELEASE_WORKFLOW, 'no `inputs:` block under `workflow_dispatch:`'));
    return;
  }
  const inputs = nestedLines(dispatch, inputsIndex);
  const dryRunIndex = headerIndex(inputs, 'dry_run', 6);
  const versionIndex = headerIndex(inputs, 'version', 6);
  const npmTagIndex = headerIndex(inputs, 'npm_tag', 6);
  if (dryRunIndex === -1 || versionIndex === -1 || npmTagIndex === -1 || !exactMappingKeys(inputs, ['dry_run', 'version', 'npm_tag'])) {
    findings.push(finding(5, RELEASE_WORKFLOW, 'the `dry_run`, `version`, and `npm_tag` inputs must be the only declared inputs'));
    return;
  }
  const dryRun = childEntries(nestedLines(inputs, dryRunIndex));
  const version = childEntries(nestedLines(inputs, versionIndex));
  const npmTagBody = nestedLines(inputs, npmTagIndex);
  const npmTag = childEntries(npmTagBody);
  const optionsIndex = headerIndex(npmTagBody, 'options', minimumIndent(npmTagBody));
  const options = optionsIndex === -1 ? [] : nestedLines(npmTagBody, optionsIndex).filter((line) => !isIgnorable(line)).map((line) => line.trim());
  if (!dryRun.includes('type: boolean')) {
    findings.push(finding(5, RELEASE_WORKFLOW, '`dry_run` must be `type: boolean` — a string input is truthy even when it reads "false"'));
  }
  if (!dryRun.includes('default: true')) {
    findings.push(finding(5, RELEASE_WORKFLOW, '`dry_run` must default to `true` — the safe dispatch is the one an operator gets by accident'));
  }
  if (!version.includes('required: true')) {
    findings.push(finding(5, RELEASE_WORKFLOW, '`version` must be `required: true`'));
  }
  if (!npmTag.includes('type: choice') || !npmTag.includes('default: next') || !npmTag.includes('required: true') || options.join(',') !== '- next,- latest') {
    findings.push(finding(5, RELEASE_WORKFLOW, '`npm_tag` must be the required choice with exactly `next` and `latest`, defaulting to `next`'));
  }
}

function checkPublishJob(text: string, permissionsByJob: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const publish = jobBlock(text, 'publish');
  if (publish === undefined) {
    findings.push(finding(6, RELEASE_WORKFLOW, 'no `publish:` job'));
    return;
  }
  const entries = childEntries(publish);
  const ifEntry = entries.find((entry) => entry.startsWith('if:'));
  if (ifEntry !== PUBLISH_IF) {
    findings.push(finding(6, RELEASE_WORKFLOW, `the publish job's condition is \`${ifEntry ?? '(absent)'}\`; it must be exactly \`${PUBLISH_IF}\``));
  }
  if (!entries.includes('needs: preflight')) {
    findings.push(finding(6, RELEASE_WORKFLOW, 'the publish job must declare `needs: preflight`'));
  }
  if (!entries.includes('environment: npm-publish')) {
    findings.push(finding(6, RELEASE_WORKFLOW, 'the publish job must run in the `npm-publish` environment'));
  }
  const permissions = permissionsByJob.jobs.get('publish');
  if (!permissionMapsEqual(permissions, expectedPermissions({ contents: 'read', 'id-token': 'write', attestations: 'write' }))) {
    findings.push(finding(6, RELEASE_WORKFLOW, `the publish job's permissions are [${permissionEntries(permissions).join(', ')}]; they must be exactly \`contents: read\`, \`id-token: write\`, and \`attestations: write\``));
  }

  const envIndex = headerIndex(publish, 'env', 4);
  const env = envIndex === -1 ? [] : childEntries(nestedLines(publish, envIndex));
  // Exactly one entry, not merely one that mentions the variable: a later
  // duplicate key in the same mapping would decide what the guard actually reads.
  const publishEnabledEntries = env.filter((entry) => entry.startsWith('PUBLISH_ENABLED:'));
  if (publishEnabledEntries.length !== 1 || !(publishEnabledEntries[0] ?? '').includes('vars.NPM_PUBLISH_ENABLED')) {
    findings.push(finding(14, RELEASE_WORKFLOW, `the publish job's \`env:\` has ${publishEnabledEntries.length} \`PUBLISH_ENABLED\` entries; there must be exactly one and it must read \`vars.NPM_PUBLISH_ENABLED\``));
  }
}

/**
 * Both loud guard steps, checked WHERE they stand and WHAT they decide.
 *
 * Checking that the names appear somewhere in the file is not enough twice over:
 * the preflight guard alone satisfies a whole-file presence test, so the publish
 * guard — the last gate in front of the job that can reach the registry — could
 * be emptied with every pin still green; and a guard that is present but reads
 * `&&` where it must read `||` refuses nobody.
 */
function checkLoudGuards(release: string, findings: Finding[]): void {
  // The publish-enabled block is pin 14's subject; the branch and actor blocks
  // are pin 10's in BOTH jobs, so the pin a reader sees keeps its meaning.
  const required: readonly (readonly [string, readonly string[], (index: number) => number, string])[] = [
    ['preflight', PREFLIGHT_GUARD_BLOCKS, () => 10, '"Release guard passed: $OWNER on $REF."'],
    ['publish', PUBLISH_GUARD_BLOCKS, (index) => (index <= 1 ? 14 : 10), '"Publish guard passed: $OWNER on $REF, publishing enabled."'],
    ['release', PREFLIGHT_GUARD_BLOCKS, () => 8, '"Release guard passed: $OWNER on $REF."'],
  ];
  for (const [jobName, blocks, pinFor, trailer] of required) {
    const body = jobBlock(release, jobName);
    const step = body === undefined ? undefined : firstStepBlock(body);
    if (step === undefined) {
      findings.push(finding(10, RELEASE_WORKFLOW, `the \`${jobName}\` job has no first step, so nothing guards it`));
      continue;
    }
    for (const [index, block] of blocks.entries()) {
      if (!step.includes(block)) {
        const condition = (block.split('\n')[0] ?? '').trim();
        findings.push(finding(pinFor(index), RELEASE_WORKFLOW, `the \`${jobName}\` job's FIRST step must carry \`${condition}\` with its message and its \`exit 1\`, exactly — a guard that is absent, reordered below the steps it protects, logically inverted, or left refusing nothing stops nobody`));
      }
    }
    // The body WHOLE, not three substrings with free text between and above
    // them. The conditions read shell variables, and four assignment lines
    // prepended to the body — `REF=refs/heads/main`, `ACTOR="$OWNER"` — leave
    // every pinned block byte-exact while making every condition trivially
    // false. Pinning the operator and the outcome and not the operand leaves
    // the guard readable and inert.
    const expectedBody = [...blocks, `          echo ${trailer}`].join('\n');
    const actualBody = (runScripts(withoutComments(step))[0] ?? '').trimEnd();
    if (actualBody !== expectedBody) {
      findings.push(finding(10, RELEASE_WORKFLOW, `the \`${jobName}\` guard step's script must be exactly its conditionals and its closing message — nothing above them, nothing between them, nothing after them`));
    }
    // Backstop for a reformat rather than an edit: the guard refuses once per
    // condition and never merely continues.
    const refusals = occurrences(step, 'exit 1');
    if (refusals !== blocks.length) {
      findings.push(finding(10, RELEASE_WORKFLOW, `the \`${jobName}\` guard step refuses ${refusals} times; it must refuse exactly ${blocks.length} times, once per condition`));
    }
    if (step.includes('exit 0')) {
      findings.push(finding(10, RELEASE_WORKFLOW, `the \`${jobName}\` guard step contains \`exit 0\` — a guard that succeeds on its own failure path refuses nobody`));
    }
  }
}

/**
 * The preflight steps that must actually be CALLED. A release workflow whose
 * registry check has been swapped for `true` is green forever and lets a
 * duplicate publish through — the module existing on disk proves nothing.
 */
function checkPreflightSafetySteps(release: string, findings: Finding[]): void {
  // Comments stripped FIRST. The must-not-appear pins learned to ignore comments;
  // a must-appear pin that believes them is the same bug facing the other way —
  // `run: "true"` plus a `# node scripts/release/…` decoy would satisfy it.
  const preflight = jobBlock(withoutComments(release), 'preflight');
  const scriptLines = preflight === undefined ? [] : runScripts(preflight.join('\n')).join('\n').split('\n').map((line) => line.trim());
  for (const [needle, what, exact] of PREFLIGHT_SAFETY_LINES) {
    const line = scriptLines.find((candidate) => candidate.includes(needle));
    if (line === undefined) {
      findings.push(finding(19, RELEASE_WORKFLOW, `preflight must run ${what} (no \`run:\` step contains \`${needle}\`)`));
      continue;
    }
    // The line must be the check and nothing appended to it: a trailing
    // `|| true` runs the check, discards its answer, and still reads as a call.
    if (exact && line !== needle) {
      findings.push(finding(19, RELEASE_WORKFLOW, `${what} is written as \`${line}\`; it must be exactly \`${needle}\`, with nothing appended that could discard its answer`));
    }
    for (const suffix of NEUTERING_SUFFIXES) {
      if (line.includes(suffix)) {
        findings.push(finding(19, RELEASE_WORKFLOW, `${what} carries \`${suffix}\`, so its answer is thrown away — a step that cannot fail is not a check`));
      }
    }
  }
  // The runner's default shell is `bash -e`; turning that off makes every
  // unchecked command in the job advisory at once.
  // `set +e` only. `set -e` RE-ASSERTS the runner's default rather than changing
  // it, and `set -euo pipefail` is a hardening someone should be free to add.
  const clean = withoutComments(release);
  for (const toggle of ['set +e', 'set +o errexit', 'set +o pipefail']) {
    if (clean.includes(toggle)) {
      findings.push(finding(19, RELEASE_WORKFLOW, `\`${toggle}\` appears in this workflow — the runner's shell stops on the first failure and nothing here may turn that off`));
    }
  }
}

/**
 * The exact job set. Effective permission policy is checked from the parsed
 * workflow/job mappings before the file-specific pins run.
 *
 * The lesson that workflow FILES must be discovered rather than listed applies
 * one level down: without this, a fourth job appended to the release workflow is
 * governed only by whole-file counts and can run without any job-specific pin.
 */
function checkJobSet(file: string, text: string, findings: Finding[]): void {
  const jobs = topLevelBlock(text, 'jobs');
  if (jobs === undefined) {
    findings.push(finding(20, file, 'no `jobs:` block'));
    return;
  }
  const actual = sortedUnique(childKeys(jobs));
  const expected = [...(EXPECTED_JOBS[file] ?? [])].sort();
  if (actual.join(',') !== expected.join(',')) {
    findings.push(finding(20, file, `the job set is [${actual.join(', ')}]; it must be exactly [${expected.join(', ')}] — a job nobody declared is a job nobody checks`));
  }
}

/** The one checkout must not leave the workflow token behind for later steps. */
function checkCheckoutCredentials(release: string, findings: Finding[]): void {
  if (!release.includes('persist-credentials: false')) {
    findings.push(finding(20, RELEASE_WORKFLOW, 'the checkout must set `persist-credentials: false` — otherwise every later step in the job can push with the workflow token'));
  }
  if (release.includes('persist-credentials: true')) {
    findings.push(finding(20, RELEASE_WORKFLOW, 'the checkout sets `persist-credentials: true`, leaving a usable push credential in the working tree'));
  }
}

function checkReleaseJob(text: string, permissionsByJob: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const release = jobBlock(text, 'release');
  if (release === undefined) {
    findings.push(finding(8, RELEASE_WORKFLOW, 'no `release:` job'));
    return;
  }
  if (!childEntries(release).includes('needs: [preflight, publish]')) {
    findings.push(finding(8, RELEASE_WORKFLOW, 'the release job must declare `needs: [preflight, publish]`'));
  }
  if (!childEntries(release).includes(PUBLISH_IF)) {
    findings.push(finding(8, RELEASE_WORKFLOW, `the release job condition must be exactly \`${PUBLISH_IF}\``));
  }
  const permissions = permissionsByJob.jobs.get('release');
  if (!permissionMapsEqual(permissions, expectedPermissions({ contents: 'write' }))) {
    findings.push(finding(8, RELEASE_WORKFLOW, `the release job's permissions are [${permissionEntries(permissions).join(', ')}]; they must be exactly \`contents: write\``));
  }
  const decision = namedStepScript(release, 'Decide and create the release');
  if (decision?.trim() !== RELEASE_COMMAND) {
    findings.push(finding(8, RELEASE_WORKFLOW, `the release decision step must run exactly \`${RELEASE_COMMAND}\``));
  }
}

function checkPublishCommand(text: string, findings: Finding[]): void {
  const publishLines = fileLines(text).filter((line) => line.includes('npm publish'));
  if (publishLines.length !== 1) {
    findings.push(finding(9, RELEASE_WORKFLOW, `found ${publishLines.length} \`npm publish\` lines; exactly one is expected`));
    return;
  }
  const command = (publishLines[0] ?? '').trim();
  if (command !== PUBLISH_COMMAND) {
    findings.push(finding(9, RELEASE_WORKFLOW, `the publish command is \`${command}\`; it must be exactly \`${PUBLISH_COMMAND}\` — anything else may publish nothing, publish off \`latest\`, or publish somewhere else`));
  }
}

// eslint-disable-next-line complexity -- One ordered audit ties each safety step to its exact bytes and position.
function checkReleaseSafetySteps(text: string, findings: Finding[]): void {
  const exactScripts: readonly (readonly [string, string, string])[] = [
    ['preflight', 'This commit is a release point on main', 'node scripts/release/release-plan.mts release-point'],
    ['preflight', 'The version and npm tag are valid', 'node scripts/release/release-plan.mts version'],
    ['preflight', "The runner's gh can create the release", 'node scripts/release/release-plan.mts capabilities'],
    ['preflight', 'Release notes from CHANGELOG.md', 'node scripts/release/release-plan.mts notes'],
    ['preflight', 'Write the release summary', 'node scripts/release/release-plan.mts summary'],
    ['publish', 'The package manifest and npm tag are valid', 'node release-candidate/release-plan.mts manifest'],
    ['release', 'Decide and create the release', RELEASE_COMMAND],
  ];
  for (const [jobName, stepName, expected] of exactScripts) {
    const job = jobBlock(text, jobName);
    const actual = job === undefined ? undefined : namedStepScript(job, stepName)?.trim();
    if (actual !== expected) findings.push(finding(19, RELEASE_WORKFLOW, `${jobName}/${stepName} must run exactly ${JSON.stringify(expected)}`));
  }
  const order: Readonly<Record<string, readonly string[]>> = {
    preflight: ['Runtime floor — npm must be at least 11.5.1 for trusted publishing', 'This commit is a release point on main', 'The version and npm tag are valid', "The runner's gh can create the release", 'Pack and hash the tested package', 'Release notes from CHANGELOG.md', 'Write the release summary', 'Assemble the release-candidate artifact'],
    publish: ['The tested package and module match their hashes', 'The package manifest and npm tag are valid', 'Attest the package file', 'Save the attestation bundle and its hash', 'Check the registry, then publish'],
    release: ['The release files match what was tested', 'Check the attestation', 'Decide and create the release'],
  };
  for (const [jobName, names] of Object.entries(order)) {
    const job = jobBlock(text, jobName);
    const blocks = job === undefined ? [] : stepBlocks(job);
    const indices = names.map((name) => blocks.findIndex((block) => block.includes(`- name: ${name}`)));
    if (indices.some((index) => index < 0) || indices.some((index, position) => position > 0 && index <= (indices[position - 1] ?? -1))) {
      findings.push(finding(19, RELEASE_WORKFLOW, `${jobName} safety steps are missing or out of their required order`));
    }
  }
  for (const [jobName, steps] of Object.entries(RELEASE_SCRIPT_SHA256)) {
    for (const [stepName, expectedHash] of Object.entries(steps)) {
      const script = readNamedStepScript(text, jobName, stepName);
      const actualHash = script === undefined ? '' : createHash('sha256').update(script).digest('hex');
      if (script === undefined || expectedHash === '' || actualHash !== expectedHash) {
        findings.push(finding(19, RELEASE_WORKFLOW, `${jobName}/${stepName} safety script differs from its whole-script SHA-256 pin`));
      }
    }
  }
  const publish = jobBlock(text, 'publish') ?? [];
  const handoffIndex = stepBlocks(publish).findIndex((step) => step.includes('- name: The tested package and module match their hashes'));
  const attestIndex = stepBlocks(publish).findIndex((step) => step.includes('- name: Attest the package file'));
  if (handoffIndex < 0 || attestIndex < 0 || handoffIndex >= attestIndex) findings.push(finding(19, RELEASE_WORKFLOW, 'the hand-off hash check must finish before attestation'));
  const attestation = stepBlocks(publish).find((step) => step.includes('- name: Attest the package file')) ?? '';
  if (!attestation.includes('actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8') ||
      JSON.stringify(childEntries(nestedLines(fileLines(attestation), headerIndex(fileLines(attestation), 'with', 8)))) !== JSON.stringify(['subject-path: release-candidate/*.tgz']) ||
      (attestation.match(/subject-path:/g) ?? []).length !== 1 || attestation.includes('${{')) {
    findings.push(finding(19, RELEASE_WORKFLOW, 'the pinned attestation must use exactly subject-path: release-candidate/*.tgz and no expressions in with:'));
  }
  if (text.includes('--generate-notes')) findings.push(finding(19, RELEASE_WORKFLOW, '`--generate-notes` is forbidden; notes must come from the hashed release-notes.md file'));
  const preflight = jobBlock(text, 'preflight');
  const preflightSteps = preflight === undefined ? [] : stepBlocks(preflight);
  const releasePointIndex = preflightSteps.findIndex((step) => step.includes('- name: This commit is a release point on main'));
  const installIndex = preflightSteps.findIndex((step) => runScripts(step).some((script) => script.trim() === 'npm ci --ignore-scripts'));
  if (releasePointIndex < 0 || installIndex < 0 || releasePointIndex >= installIndex) {
    findings.push(finding(19, RELEASE_WORKFLOW, 'the release-point check must run before npm ci'));
  }
}

function checkPreflightManifestStep(release: string, findings: Finding[]): void {
  const preflight = jobBlock(release, 'preflight');
  const preflightBody = preflight === undefined ? '' : preflight.join('\n');
  const preflightScript = preflight === undefined ? undefined : namedStepScript(preflight, PREFLIGHT_MANIFEST_STEP);
  if (preflightScript === undefined) {
    findings.push(finding(21, RELEASE_WORKFLOW, `preflight must have a step named "${PREFLIGHT_MANIFEST_STEP}" with a script of its own`));
  } else {
    for (const [needle, what] of [
      [PREFLIGHT_MANIFEST_TEST, 'the refusal when the checked-out manifest is marked private'],
      [PREFLIGHT_MANIFEST_GATE, 'the gate that spares a rehearsal from the check, since it publishes nothing'],
    ] as [string, string][]) {
      if (!preflightScript.includes(needle)) {
        findings.push(finding(21, RELEASE_WORKFLOW, `preflight's manifest step is missing ${what} (\`${needle.slice(0, 60)}\`)`));
      }
    }
    if (preflightScript.trimEnd() !== PREFLIGHT_MANIFEST_SCRIPT) {
      findings.push(finding(21, RELEASE_WORKFLOW, "preflight's manifest step must run exactly its manifest check — nothing added, nothing removed, and nothing merely printed"));
    }
  }
  // POSITION, not merely presence. The step exists to answer in the first minute;
  // moved below the install and the battery it still refuses, just after the work
  // it was meant to save has already been done.
  const earlyAt = preflightBody.indexOf(PREFLIGHT_MANIFEST_STEP);
  const installAt = preflightBody.indexOf('npm ci');
  if (earlyAt !== -1 && installAt !== -1 && earlyAt > installAt) {
    findings.push(finding(21, RELEASE_WORKFLOW, 'the early manifest check runs after the install and the battery — it must come before them, or it saves nothing'));
  }
  // The gate reads this variable; without it the check runs on every dispatch.
  const envIndex = preflight === undefined ? -1 : headerIndex(preflight, 'env', 4);
  const preflightEnv = envIndex === -1 || preflight === undefined ? [] : childEntries(nestedLines(preflight, envIndex));
  if (!preflightEnv.some((entry) => entry.startsWith('DRY_RUN:'))) {
    findings.push(finding(21, RELEASE_WORKFLOW, "preflight's `env:` must carry `DRY_RUN`, which the rehearsal gate reads — an unset variable makes the gate always true"));
  }
}


/** Artifact downloads use this run; a previous run must never supply release bytes. */
export function readJobArtifactInputs(text: string, job: string): string[][] {
  return stepBlocks(jobBlock(text, job) ?? []).filter((block) => block.includes('uses: actions/download-artifact@')).map((block) => {
    const lines = fileLines(block);
    return childEntries(nestedLines(lines, headerIndex(lines, 'with', 8)));
  });
}

function checkUploadRules(text: string, findings: Finding[]): void {
  for (const [job, names] of [['publish', ['release-candidate']], ['release', ['release-candidate', 'release-attestation']]] as const) {
    const expected = names.map((name) => [`name: ${name}`, `path: ${name}`]);
    if (JSON.stringify(readJobArtifactInputs(text, job)) !== JSON.stringify(expected)) {
      findings.push(finding(19, RELEASE_WORKFLOW, `${job} artifact downloads must use this run's named artifacts and exact paths, without a run or attempt override`));
    }
  }

  const uploads = occurrences(text, 'actions/upload-artifact@');
  const blocks = ['preflight', 'publish', 'release'].flatMap((name) => {
    const body = jobBlock(text, name);
    return body === undefined ? [] : stepBlocks(body);
  }).filter((block) => block.includes('uses: actions/upload-artifact@'));
  if (uploads !== 2 || blocks.length !== 2) findings.push(finding(3, RELEASE_WORKFLOW, `exactly two artifact upload steps are required; found ${blocks.length}`));
  for (const block of blocks) {
    if (!block.includes('retention-days: 30')) findings.push(finding(3, RELEASE_WORKFLOW, 'every artifact upload must set retention-days: 30'));
    const attestationUpload = block.includes('name: release-attestation');
    if (attestationUpload ? !block.includes('overwrite: true') : block.includes('overwrite:')) {
      findings.push(finding(3, RELEASE_WORKFLOW, 'overwrite: true is permitted only on the release-attestation upload'));
    }
  }
}

/** Both test workflows keep their triggers limited to the default branch. */
function checkBranchFilters(file: string, text: string, findings: Finding[]): void {
  const on = topLevelBlock(text, 'on');
  if (on === undefined) return;
  for (const key of ['push', 'pull_request']) {
    const index = headerIndex(on, key, 2);
    // A missing key is the trigger-SET pin's business, not this one's.
    if (index === -1) continue;
    if (!childEntries(nestedLines(on, index)).includes('branches: [main]')) {
      findings.push(finding(11, file, `\`${key}:\` must be limited to \`branches: [main]\`; an unfiltered trigger runs on every branch`));
    }
  }
}

function checkGuardsPresent(text: string, findings: Finding[]): void {
  for (const needle of ['github.actor', 'github.triggering_actor', 'github.repository_owner', 'refs/heads/main']) {
    if (!text.includes(needle)) {
      findings.push(finding(10, RELEASE_WORKFLOW, `\`${needle}\` appears nowhere — the owner/branch guard is incomplete`));
    }
  }
}

function checkAbsent(file: string, text: string, pin: number, needles: readonly string[], why: string, findings: Finding[]): void {
  for (const needle of needles) {
    if (text.includes(needle)) {
      findings.push(finding(pin, file, `\`${needle}\` appears in this workflow — ${why}`));
    }
  }
}

/** The remaining text-counted pins on the release workflow: checkout and Node 24. */
function checkReleaseCounts(release: string, clean: string, permissions: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const checkoutCount = occurrences(clean, 'actions/checkout@');
  if (checkoutCount !== 1) {
    findings.push(finding(13, RELEASE_WORKFLOW, `\`actions/checkout\` appears ${checkoutCount} times; only preflight may check the source out`));
  }
  const setupNodeCount = occurrences(clean, 'actions/setup-node@');
  const nodeTwentyFourCount = occurrences(clean, 'node-version: 24');
  if (setupNodeCount !== 3 || nodeTwentyFourCount !== setupNodeCount) {
    findings.push(finding(12, RELEASE_WORKFLOW, `${setupNodeCount} \`setup-node\` steps and ${nodeTwentyFourCount} on \`node-version: 24\`; all three release jobs must pin Node 24`));
  }
  const checkout = jobBlock(clean, 'preflight') ?? [];
  if (occurrences(clean, 'actions/checkout@') !== 1 || !checkout.join('\n').includes('fetch-depth: 0')) {
    findings.push(finding(13, RELEASE_WORKFLOW, 'the sole checkout must be in preflight with fetch-depth: 0'));
  }
  // Deliberately the RAW text: Actions expands `${{ }}` before the shell ever
  // sees the script, so an expression inside what looks like a shell comment is
  // still interpolated. This is the one must-not-appear pin comments cannot excuse.
  if (runScripts(release).some((script) => script.includes('${{'))) {
    findings.push(finding(15, RELEASE_WORKFLOW, 'an expression is interpolated into a `run:` script — operator-typed values must reach the shell through `env:` only'));
  }
  if (!permissions.workflow.present || !permissionMapsEqual(permissions.workflow.permissions, emptyPermissions())) {
    findings.push(finding(18, RELEASE_WORKFLOW, `workflow-level permissions are \`${permissions.workflow.raw}\`; they must grant nothing (\`permissions: {}\` or only explicit \`none\` levels), with every job declaring its own`));
  }
}

/** Every pin that applies only to the release workflow. */
function checkReleaseWorkflow(release: string, permissions: WorkflowPermissionAnalysis, findings: Finding[]): void {
  const clean = withoutComments(release);
  checkTriggers(RELEASE_WORKFLOW, release, 1, findings);
  // Pin 4: no build cache on the release path — a release installs clean.
  checkAbsent(RELEASE_WORKFLOW, clean, 4, ['cache:', 'actions/cache', 'restore-keys'], 'a release must install from the lockfile into a clean runner', findings);
  checkReleaseTriggerInputs(release, findings);
  checkPublishJob(release, permissions, findings);
  if (!permissionMapsEqual(permissions.jobs.get('preflight'), expectedPermissions({ contents: 'read' }))) {
    findings.push(finding(20, RELEASE_WORKFLOW, `the preflight job's permissions are [${permissionEntries(permissions.jobs.get('preflight')).join(', ')}]; they must be exactly \`contents: read\` only`));
  }
  checkReleaseMappingKeys(clean, findings);
  checkReleaseStepAttributes(release, findings);
  checkLoudGuards(release, findings);
  checkPreflightSafetySteps(release, findings);
  checkReleaseJob(release, permissions, findings);
  checkJobSet(RELEASE_WORKFLOW, release, findings);
  // Comment-stripped: both are must-appear pins, and a must-appear pin that
  // believes a comment fails OPEN — commenting a step out is the most innocuous
  // -looking edit there is.
  checkCheckoutCredentials(clean, findings);
  checkPublishCommand(clean, findings);
  checkReleaseSafetySteps(clean, findings);
  checkUploadRules(clean, findings);
  checkGuardsPresent(clean, findings);
  checkAbsent(RELEASE_WORKFLOW, clean, 16, ['NODE_AUTH_TOKEN'], 'npm trusted publishing uses the job\'s OIDC identity and a token only competes with it', findings);
  checkAbsent(RELEASE_WORKFLOW, clean, 17, ['github.event.inputs'], 'that context makes every input a STRING, so a boolean condition silently stops working', findings);
  checkReleaseCounts(release, clean, permissions, findings);
}

/** Every pin that applies to the two test-and-audit workflows. */
function checkTestWorkflow(workflowPath: string, text: string, permissions: WorkflowPermissionAnalysis, findings: Finding[]): void {
  checkTriggers(workflowPath, text, 11, findings);
  checkBranchFilters(workflowPath, text, findings);
  checkJobSet(workflowPath, text, findings);
  checkTopLevelReadPermissions(workflowPath, permissions, findings);
}

function checkWorkflowEncoding(file: string, text: string, findings: Finding[]): void {
  if (text.includes('\uFEFF')) findings.push(finding(20, file, 'a byte-order mark anywhere in a workflow is malformed; remove it before checking workflow permissions'));
  if (fileLines(text).some((line) => /^ *[^\S ]/u.test(line.replace(/\r$/, '')))) {
    findings.push(finding(20, file, 'workflow indentation must contain only ASCII spaces'));
  }
}

/**
 * Checks every workflow-shape pin against an in-memory map of path -> file text.
 * Returns one finding per violated pin; an empty array means every pin holds.
 *
 * `declared` defaults to the module's own list; it is a parameter so a test can
 * prove what DECLARING a new path does — the cost of a declaration is the point
 * of the pin-0 table checks, and that cannot be shown from outside otherwise.
 */
export function checkReleaseWorkflows(files: ReadonlyMap<string, string>, declared: readonly string[] = WORKFLOW_PATHS): Finding[] {
  const findings: Finding[] = [];

  for (const workflowPath of declared) {
    if (!files.has(workflowPath)) {
      findings.push(finding(0, workflowPath, 'workflow file missing from the set under check'));
    }
    // Declaring a path must COST something, or the remediation for the finding
    // below is a one-line edit that buys silence and no checking: the trigger
    // set and the action count are per-path table rows, and the cross-file pins
    // (fork-privileged trigger, unpinned action, exec ban) are the only ones a
    // path gets for free.
    if (EXPECTED_TRIGGERS[workflowPath] === undefined) {
      findings.push(finding(0, workflowPath, 'declared in WORKFLOW_PATHS with no EXPECTED_TRIGGERS row — its trigger set is unchecked; add the exact set it is allowed to carry'));
    }
    if (EXPECTED_USES_COUNT[workflowPath] === undefined) {
      findings.push(finding(0, workflowPath, 'declared in WORKFLOW_PATHS with no EXPECTED_USES_COUNT row — the number of actions it runs is unchecked; add the exact count'));
    }
  }
  // A workflow nobody declared is a workflow nobody governs. The reader
  // enumerates the directory, so a new file lands here and must be declared in
  // WORKFLOW_PATHS — which in turn costs it the two table rows above — before it
  // can pass. Undeclared, it still gets the three cross-file pins applied
  // (fork-privileged trigger, unpinned or non-GitHub action, out-of-lockfile
  // exec) on top of this finding; the per-file pins reach it only once declared.
  for (const workflowPath of files.keys()) {
    if (!declared.includes(workflowPath)) {
      findings.push(finding(0, workflowPath, 'this workflow is not declared in WORKFLOW_PATHS — every workflow in the repository must be governed by these pins before it may run'));
    }
  }

  // Pin 2 + pin 9's exec ban + pin 3: every file, no exceptions. Whole-line
  // comments are dropped first — a commented-out trigger configures nothing.
  for (const [workflowPath, text] of files) {
    checkWorkflowEncoding(workflowPath, text, findings);
    const clean = withoutComments(text);
    checkAbsent(workflowPath, clean, 2, ['pull_request_target'], 'it runs fork code in the base repository with its secrets', findings);
    checkAbsent(workflowPath, clean, 9, BANNED_EXEC_TOKENS, 'it fetches and runs code from outside the lockfile', findings);
    checkUses(workflowPath, clean, findings);
    checkJobRunners(workflowPath, clean, findings);
  }

  const permissionAnalyses = new Map<string, WorkflowPermissionAnalysis>();
  for (const [workflowPath, text] of files) {
    const analysis = analyzeWorkflowPermissions(workflowPath, text, findings);
    permissionAnalyses.set(workflowPath, analysis);
    checkPrivilegedPermissions(workflowPath, analysis, findings);
    checkOidcPermissionCount(workflowPath, analysis, findings);
    checkPermissionBackstop(workflowPath, text, analysis, findings);
  }

  const release = files.get(RELEASE_WORKFLOW);
  if (release !== undefined) {
    checkPreflightManifestStep(withoutComments(release), findings);
    const permissions = permissionAnalyses.get(RELEASE_WORKFLOW);
    if (permissions !== undefined) checkReleaseWorkflow(release, permissions, findings);
  }

  for (const workflowPath of [CI_WORKFLOW, AUDIT_WORKFLOW]) {
    const text = files.get(workflowPath);
    const permissions = permissionAnalyses.get(workflowPath);
    if (text !== undefined && permissions !== undefined) checkTestWorkflow(workflowPath, text, permissions, findings);
  }

  return findings;
}

/**
 * True when `actual` is at or above `floor`, compared segment by segment as
 * NUMBERS. A string compare gets this backwards ("11.19.0" sorts below "11.5.1")
 * and would fail the very runner that satisfies the floor.
 */
export function meetsVersionFloor(actual: string, floor: string): boolean {
  const parse = (value: string): number[] => value.trim().split('-')[0]?.split('.').map((segment) => Number.parseInt(segment, 10)) ?? [];
  const actualSegments = parse(actual);
  const floorSegments = parse(floor);
  if (actualSegments.length === 0 || actualSegments.some((segment) => !Number.isInteger(segment))) return false;
  const width = Math.max(actualSegments.length, floorSegments.length);
  for (let index = 0; index < width; index += 1) {
    const left = actualSegments[index] ?? 0;
    const right = floorSegments[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

const WORKFLOW_DIRECTORY = '.github/workflows';

/**
 * Reads every workflow file in `.github/workflows/` into a map — DISCOVERED from
 * the directory, not taken from the declared list. That is the difference between
 * "these three files are clean" and "every workflow in this repository is clean":
 * an undeclared fourth file is read, checked like the rest, and additionally
 * reported as ungoverned until someone declares it.
 */
export function readWorkflowFiles(repoRoot: string): Map<string, string> {
  const directory = path.join(repoRoot, WORKFLOW_DIRECTORY);
  const discovered = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')))
    .map((entry) => `${WORKFLOW_DIRECTORY}/${entry.name}`);

  const files = new Map<string, string>();
  for (const workflowPath of [...new Set([...WORKFLOW_PATHS, ...discovered])].sort()) {
    const absolute = path.join(repoRoot, workflowPath);
    // A declared file that is missing stays out of the map on purpose: the
    // checker reports it as missing rather than throwing here.
    if (fs.existsSync(absolute)) files.set(workflowPath, fs.readFileSync(absolute, 'utf8'));
  }
  return files;
}

function runGuard(repoRoot: string): number {
  const findings = checkReleaseWorkflows(readWorkflowFiles(repoRoot));
  if (findings.length > 0) {
    console.error(`[release-workflow-guard] FAIL: ${findings.length} workflow-shape ${findings.length === 1 ? 'finding' : 'findings'}:`);
    for (const item of findings) console.error(`- pin ${item.pin} · ${item.file}: ${item.message}`);
    return 1;
  }
  console.log(`[release-workflow-guard] PASS: ${WORKFLOW_PATHS.length} workflow files satisfy every shape pin.`);
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) {
  process.exitCode = runGuard(path.resolve(path.dirname(thisFile), '..', '..'));
}
