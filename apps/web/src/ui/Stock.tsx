import { useApi } from '../core/hooks';
import { useI18n } from '../core/i18n';
import { formatQty } from '../core/format';
import type { Warehouse } from '../core/types';
import { useSession } from '../core/session';
import { Badge } from './Badge';
import { Select } from './Field';

/** Shared stock widgets — used by Inventory and by modules that only *show* stock (Purchasing, documents). */

/** True when warehouses exist for this user: the Inventory app is on and they may see stock. */
export function useStockOn() {
  const { hasApp, can } = useSession();
  return hasApp('inventory') && can('inventory.stock.read');
}

export const useWarehouses = () => useApi<Warehouse[]>(useStockOn() ? '/inventory/warehouses' : null, undefined, { staleTime: 30_000 });

/** Quantity (x1000) rendered with its unit, trailing zeros trimmed. */
export function Qty({ v, unit, signed, tone }: { v: number; unit?: string | null; signed?: boolean; tone?: boolean }) {
  const { locale } = useI18n();
  const s = formatQty(Math.abs(v), locale);
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return (
    <span className={`num ${tone && v < 0 ? 'danger-text' : tone && v > 0 ? 'success-text' : ''}`}>
      {sign}
      {s}
      {unit && (
        <>
          {'\u00a0'}
          <span className="faint" style={{ fontSize: '0.85em' }}>
            {unit}
          </span>
        </>
      )}
    </span>
  );
}

export function StockStatus({ status }: { status: 'ok' | 'low' | 'out' }) {
  const { t } = useI18n();
  if (status === 'out') return <Badge tone="red">{t('inventory.out')}</Badge>;
  if (status === 'low') return <Badge tone="amber">{t('inventory.low')}</Badge>;
  return <Badge tone="green">{t('inventory.ok')}</Badge>;
}

export function WarehouseSelect({
  value,
  onChange,
  all,
  exclude,
}: {
  value: number | null;
  onChange(id: number | null): void;
  all?: boolean;
  exclude?: number | null;
}) {
  const { t, pick } = useI18n();
  const { data } = useWarehouses();
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} style={all ? { width: 'auto' } : undefined}>
      {all ? <option value="">{t('inventory.allWarehouses')}</option> : value == null && <option value="">{t('common.select')}</option>}
      {(data ?? [])
        .filter((w) => (w.is_active || w.id === value) && w.id !== exclude)
        .map((w) => (
          <option key={w.id} value={w.id}>
            {w.code} · {pick(w.name_en, w.name_ar)}
          </option>
        ))}
    </Select>
  );
}

/** Minor units per unit → shown as money by the caller. Link targets for stock move sources. */
export function moveSourceLink(sourceType: string, sourceId: number): string {
  if (['adjustment', 'opening', 'count', 'transfer'].includes(sourceType)) return `/inventory/operations/${sourceId}`;
  if (sourceType === 'production') return `/mfg/orders/${sourceId}`;
  return `/documents/${sourceId}`;
}
