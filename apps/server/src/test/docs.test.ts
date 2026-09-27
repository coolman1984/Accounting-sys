import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Documentation is part of the build: the generated map must match the code, and the living docs must exist. */
const ROOT = resolve(import.meta.dirname, '../../../..');

test('docs/MAP.md matches the code (run: npm run docs:map)', () => {
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'scripts/docs-map.mjs', '--check'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  assert.match(out, /up to date/);
});

test('the living docs are present and the changelog has an unreleased section', () => {
  for (const f of ['CLAUDE.md', 'docs/README.md', 'docs/CHANGELOG.md', 'docs/DECISIONS.md', 'docs/LESSONS.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md']) {
    assert.ok(existsSync(resolve(ROOT, f)), `${f} is missing`);
  }
  assert.match(readFileSync(resolve(ROOT, 'docs/CHANGELOG.md'), 'utf8'), /## \[Unreleased\]/);
});
