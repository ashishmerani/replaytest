import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

import { SUITE_SCAN_MAX_FILES } from './suite-scan.js';
import { makeTempDir } from './test-support/temp-dir.test-support.js';

export interface GeneratedSpecHeaderFixtureTree {
  root: string;
  generatedTestsDir: string;
  expected: {
    capped: true;
    cappedBy: 'maxFiles';
    duplicateSlugs: string[];
    headers: Array<[string, string]>;
  };
}

/** Builds one exact capped tree shared by both generated-header consumers' parity pins. */
export function buildGeneratedSpecHeaderFixtureTree(t: TestContext): GeneratedSpecHeaderFixtureTree {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-generated-header-parity-'));
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.writeFileSync(path.join(generatedTestsDir, '000-unique.spec.ts'), '// replaytest-slug: unique-relocated\n', 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, '001-duplicate-a.spec.ts'), '// replaytest-slug: duplicate-relocated\n', 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, '002-duplicate-b.spec.ts'), '// replaytest-slug: duplicate-relocated\n', 'utf8');
  for (let index = 3; index < SUITE_SCAN_MAX_FILES; index += 1) {
    fs.writeFileSync(path.join(generatedTestsDir, `${String(index).padStart(3, '0')}-filler.spec.ts`), '// headerless fixture\n', 'utf8');
  }
  return {
    root,
    generatedTestsDir,
    expected: {
      capped: true,
      cappedBy: 'maxFiles',
      duplicateSlugs: ['duplicate-relocated'],
      headers: [['unique-relocated', 'tests/generated/000-unique.spec.ts']],
    },
  };
}
