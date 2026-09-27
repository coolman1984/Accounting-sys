/**
 * Money is NEVER a floating point number in this system.
 *
 *  - Amounts are integers in the currency's minor unit (e.g. cents / piasters).
 *  - Quantities are integers in thousandths (2.5 units => 2500).
 *  - Rates (tax, discount) are integers in basis points (15% => 1500).
 *
 * All intermediate math uses BigInt and rounds half away from zero, the
 * convention used by most tax authorities.
 */
export const QTY_SCALE = 1000n;
export const BP_SCALE = 10000n;

export function isMinor(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** Integer division rounding half away from zero. */
export function divRound(numer: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error('division by zero');
  const neg = numer < 0n !== denom < 0n;
  const n = numer < 0n ? -numer : numer;
  const d = denom < 0n ? -denom : denom;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/** quantity (x1000) * unit price (minor) => amount (minor). */
export function lineAmount(quantity: number, unitPrice: number): number {
  return toSafe(divRound(BigInt(quantity) * BigInt(unitPrice), QTY_SCALE));
}

/** amount * basisPoints / 10000, rounded. */
export function applyRate(amount: number, bp: number): number {
  return toSafe(divRound(BigInt(amount) * BigInt(bp), BP_SCALE));
}

/** Extract the net part of a tax-inclusive amount: gross * 10000 / (10000 + bp). */
export function netOfInclusive(gross: number, bp: number): number {
  return toSafe(divRound(BigInt(gross) * BP_SCALE, BP_SCALE + BigInt(bp)));
}

export function sum(values: number[]): number {
  let t = 0n;
  for (const v of values) t += BigInt(v);
  return toSafe(t);
}

function toSafe(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('amount out of range');
  }
  return Number(v);
}

/**
 * Line math for any priced line (invoice, bill, purchase order): quantity ×
 * price, less discount, then tax — or tax backed out of an inclusive price.
 */
export function computeLine(l: { quantity: number; unitPrice: number; discountBp: number; rateBp: number }, inclusive: boolean) {
  const gross = lineAmount(l.quantity, l.unitPrice);
  const discount = applyRate(gross, l.discountBp);
  const after = gross - discount;
  const net = inclusive ? netOfInclusive(after, l.rateBp) : after;
  const tax = inclusive ? after - net : applyRate(net, l.rateBp);
  return { gross, discount, net, tax, total: net + tax };
}

/** Exchange rates are base units per one foreign unit × 1,000,000. */
export const FX_RATE_SCALE = 1_000_000n;

/** Foreign minor units → base minor units at `rate` (× 1,000,000), round half away from zero. */
export function fxToBase(amount: number, rate: number): number {
  return toSafe(divRound(BigInt(amount) * BigInt(rate), FX_RATE_SCALE));
}
