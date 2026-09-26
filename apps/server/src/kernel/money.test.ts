import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRate, divRound, lineAmount, netOfInclusive, sum } from './money.js';

test('divRound rounds half away from zero', () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(4n, 3n), 1n);
  assert.equal(divRound(-4n, 3n), -1n);
  assert.equal(divRound(0n, 7n), 0n);
});

test('line amount: 2.5 units x 10.99 = 27.48 (27.475 rounded up)', () => {
  assert.equal(lineAmount(2500, 1099), 2748);
  assert.equal(lineAmount(1000, 1), 1);
  assert.equal(lineAmount(333, 100), 33); // 0.333 x 1.00
});

test('tax rates in basis points', () => {
  assert.equal(applyRate(10000, 1400), 1400); // 14% of 100.00
  assert.equal(applyRate(1, 1400), 0);
  assert.equal(applyRate(4, 1400), 1); // 0.56 -> 1
  assert.equal(netOfInclusive(11400, 1400), 10000);
  assert.equal(netOfInclusive(100, 1400), 88); // 87.719 -> 88
});

test('sum is exact for large integers', () => {
  assert.equal(sum([Number.MAX_SAFE_INTEGER - 1, 1]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => sum([Number.MAX_SAFE_INTEGER, 1]));
});
