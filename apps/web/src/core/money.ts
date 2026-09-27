/** Mirror of the server's line math (integer, half away from zero) for live previews. */
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return neg ? -q : q;
}

export function computeLine(quantity: number, unitPrice: number, discountBp: number, rateBp: number, inclusive: boolean) {
  const gross = Number(divRound(BigInt(quantity) * BigInt(unitPrice), 1000n));
  const discount = Number(divRound(BigInt(gross) * BigInt(discountBp), 10000n));
  const after = gross - discount;
  const net = inclusive ? Number(divRound(BigInt(after) * 10000n, 10000n + BigInt(rateBp))) : after;
  const tax = inclusive ? after - net : Number(divRound(BigInt(net) * BigInt(rateBp), 10000n));
  return { gross, discount, net, tax, total: net + tax };
}
