import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The ecosystem contracts are VENDORED from their owner (coolman1984/GMES, packages/eco-contracts/src):
 * a byte-identical copy pinned by SHA-256. Editing a vendored file here would silently fork the contract
 * every other app validates against, so this test fails on any difference from the pin.
 * To update: copy the files again from GMES and refresh PIN.json (never edit them in Mizan).
 */
const DIR = resolve(import.meta.dirname, '../eco-contracts');
const pin = JSON.parse(readFileSync(join(DIR, 'PIN.json'), 'utf8')) as { source: { repo: string; path: string }; files: Record<string, string> };
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('every vendored contract file matches its pin byte for byte', () => {
  assert.equal(pin.source.repo, 'coolman1984/GMES');
  const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(onDisk, Object.keys(pin.files).sort(), 'files in eco-contracts/ and PIN.json differ');
  for (const [name, hash] of Object.entries(pin.files)) assert.equal(sha(join(DIR, name)), hash, `${name} differs from its pin`);
});

// When the owner's checkout sits next to this repository (the "Complete Company" layout), also say whether
// the pin is behind the source — informative only, the pin is what Mizan runs.
const SOURCE = process.env.ECO_CONTRACTS_SRC ?? resolve(import.meta.dirname, '../../../../../GMES/packages/eco-contracts/src');
test('the pin is up to date with the owner checkout (when present)', { skip: !existsSync(SOURCE) || !process.env.ECO_CONTRACTS_STRICT }, () => {
  for (const name of Object.keys(pin.files)) assert.equal(sha(join(SOURCE, name)), pin.files[name], `${name}: GMES has a newer version — copy it and update PIN.json`);
});
