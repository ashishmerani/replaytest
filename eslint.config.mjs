import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const exemptionPath = process.env.REPLAYTEST_ESLINT_EXEMPTIONS_PATH ?? path.join(repoRoot, 'eslint-exemptions.json');
const typedFiles = ['src/**/*.ts', 'scripts/**/*.{ts,mts,mjs}', 'tests/**/*.ts', 'playwright.config.ts'];
const testFiles = ['src/**/*.test.ts', 'src/cli/verbs/test-support.ts', 'src/retire-test-support.ts', 'src/staged-copy.test-support.ts', 'scripts/**/*.test.{ts,mts,mjs}', 'tests/**/*.ts'];
const nonTestFiles = ['src/**/*.ts', 'scripts/**/*.{ts,mts,mjs}'];
const testIgnores = ['src/**/*.test.ts', 'src/cli/verbs/test-support.ts', 'src/retire-test-support.ts', 'src/staged-copy.test-support.ts', 'scripts/**/*.test.{ts,mts,mjs}'];

const budgetRules = {
  complexity: ['warn', 15],
  'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
  'max-depth': ['warn', 4],
  'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
};

const ratchetRules = {
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-unsafe-argument': 'warn',
  '@typescript-eslint/no-unsafe-call': 'warn',
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  '@typescript-eslint/no-unsafe-return': 'warn',
};

/** @type {{ version: number, rules: Record<string, string[]> }} */
const exemptionBaseline = JSON.parse(fs.readFileSync(exemptionPath, 'utf8'));

function exemptionOverrides(exemptions) {
  return Object.entries(exemptions.rules).map(([rule, files]) => ({
    files,
    rules: { [rule]: 'off' },
  }));
}

export function createConfig(exemptions = exemptionBaseline) {
  return [
    {
      ignores: ['node_modules/**', 'dist/**', 'tmp/**', 'archive/**', 'docs/**', 'tests/generated/**', '.replaytest/**', 'src/retire-durable-op-hook.cjs', 'eslint.config.mjs', 'deleteme/**', 'datasets/**', 'local-reference/**'],
    },
    ...tseslint.configs.recommendedTypeChecked,
    {
      files: typedFiles,
      languageOptions: {
        parserOptions: {
          project: path.join(repoRoot, 'tsconfig.eslint.json'),
          tsconfigRootDir: repoRoot,
        },
      },
    },
    {
      files: nonTestFiles,
      ignores: testIgnores,
      plugins: { 'import-x': importX },
      settings: {
        'import-x/extensions': ['.ts', '.mts', '.mjs', '.js'],
        'import-x/resolver': { typescript: { project: path.join(repoRoot, 'tsconfig.eslint.json') } },
      },
      rules: {
        ...ratchetRules,
        'import-x/no-cycle': ['error', { ignoreExternal: true, allowUnsafeDynamicCyclicDependency: true }],
        'import-x/no-restricted-paths': ['error', {
          basePath: repoRoot,
          zones: [
            {
              target: './src/*.ts',
              from: './src/dashboard',
              message: 'Domain modules must not import dashboard modules.',
            },
            {
              // The shared local-coverage leaf is the sanctioned CLI-to-dashboard importer
              // at this level. All other direct non-verb CLI modules stay restricted.
              target: './src/cli/!(local-coverage).ts',
              from: './src/dashboard',
              message: 'Domain modules must not import dashboard modules.',
            },
            {
              // The dashboard, sessions, sessions-watch, sessions-stored-payload, and gaps verbs may import dashboard modules.
              target: './src/cli/verbs/!(dashboard|sessions|sessions-watch|sessions-stored-payload|gaps).ts',
              from: './src/dashboard',
              message: 'Domain modules must not import dashboard modules.',
            },
            {
              // Future nested CLI directories stay dashboard-restricted unless a
              // narrow, explicit sanction is added above.
              target: './src/cli/!(verbs)/**/*.ts',
              from: './src/dashboard',
              message: 'Domain modules must not import dashboard modules.',
            },
            {
              // Nested verb directories are never dashboard importers.
              target: './src/cli/verbs/*/**/*.ts',
              from: './src/dashboard',
              message: 'Domain modules must not import dashboard modules.',
            },
            {
              target: './src/!(coarse-store|doctor|frames-render|frames|heal|journeys|provider-config|regenerate|repro-builder|selection|suite-status|triage).ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              // watch-check-shape.ts is sanctioned for its CapMetadata TYPE-only
              // import: it is the neutral, compile-checked dashboard/watch seam.
              target: './src/dashboard/!(server|watch-check-shape).ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              target: './src/providers/!(archive-adapter).ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              target: './src/cli/*.ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              // The CLI verb modules below are sanctioned provider-seam importers.
              // All other verb modules remain provider-restricted.
              target: './src/cli/verbs/!(init|repro|doctor|frames|heal|suite-status|plan|sessions|sessions-watch|sessions-stored-payload|gaps|triage|regenerate).ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              // Any FUTURE nested src directory is provider-restricted wholesale until a
              // per-directory zone above sanctions specific files (per-dir zones are the
              // idiom; extending a basename-negation list across ** sweeps in files whose
              // sanctions live elsewhere).
              target: './src/!(cli|dashboard|providers)/**/*.ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              // Nested CLI directories other than the verb directory are restricted
              // wholesale; verbs use the per-directory sanction above.
              target: './src/cli/!(verbs)/**/*.ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
            {
              // Nested verb directories are never provider importers (mirrors the
              // dashboard counterpart above; the per-file sanction covers only
              // src/cli/verbs' own top level).
              target: './src/cli/verbs/*/**/*.ts',
              from: './src/providers',
              message: 'Only the established provider-seam importers may import providers.',
            },
          ],
        }],
      },
    },
    {
      files: nonTestFiles,
      ignores: testIgnores,
      rules: budgetRules,
    },
    {
      files: testFiles,
      rules: {
        ...tseslint.configs.disableTypeChecked.rules,
        complexity: 'off',
        'max-lines-per-function': 'off',
        'max-depth': 'off',
        'max-lines': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'warn',
        '@typescript-eslint/no-unsafe-argument': 'warn',
        '@typescript-eslint/no-unsafe-call': 'warn',
        '@typescript-eslint/no-unsafe-member-access': 'warn',
        '@typescript-eslint/no-unsafe-return': 'warn',
        '@typescript-eslint/require-await': 'off',
        'prefer-const': 'off',
      },
    },
    ...exemptionOverrides(exemptions),
  ];
}

export default createConfig();
