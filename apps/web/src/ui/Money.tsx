import { useMoney } from '../core/hooks';
import type { MoneyOpts } from '../core/format';

/** Formatted amount, tabular digits, red when negative (optional). */
export function Money({ v, tone, ...o }: { v: number | null | undefined; tone?: boolean } & MoneyOpts) {
  const { fmt } = useMoney();
  const neg = (v ?? 0) < 0;
  return <span className={`num ${tone && neg ? 'danger-text' : ''}`}>{fmt(v, o)}</span>;
}
