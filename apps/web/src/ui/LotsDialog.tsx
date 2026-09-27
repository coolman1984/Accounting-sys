import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import { useApi } from '../core/hooks';
import { useI18n } from '../core/i18n';
import { formatQty, todayIso } from '../core/format';
import type { Item, LotEntry } from '../core/types';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { DecimalInput, Input, Textarea } from './Field';
import { Badge } from './Badge';

interface StockLot {
  id: number;
  lot_no: string;
  expiry_date: string | null;
  warehouse_id: number;
  qty: number; // base x1000
}

const QTY = 3;

/**
 * Lots & serial numbers for one line. Incoming goods: type lot numbers (with
 * expiry) or paste serials. Outgoing goods: pick from what is in the warehouse,
 * or leave it automatic (first to expire goes first).
 */
export function LotsDialog({
  open,
  onClose,
  item,
  direction,
  warehouseId,
  factor,
  qty,
  value,
  onChange,
  freeTotal,
}: {
  /** The lots decide the quantity (physical counts): any total is accepted. */
  freeTotal?: boolean;
  open: boolean;
  onClose(): void;
  item: Item;
  direction: 'in' | 'out';
  warehouseId: number | null;
  factor: number;
  qty: number;
  value: LotEntry[] | null;
  onChange(lots: LotEntry[] | null): void;
}) {
  const { t, locale } = useI18n();
  const serial = item.tracking === 'serial';
  const [rows, setRows] = useState<{ lotNo: string; expiry: string; qty: number | null }[]>([]);
  const [serialText, setSerialText] = useState('');
  const [take, setTake] = useState<Record<string, number | null>>({});
  const [filter, setFilter] = useState('');
  const { data: stock } = useApi<StockLot[]>(open && direction === 'out' && warehouseId ? '/inventory/lots' : null, { itemId: item.id, warehouseId: warehouseId ?? undefined });

  useEffect(() => {
    if (!open) return;
    const v = value ?? [];
    setRows(v.length ? v.map((l) => ({ lotNo: l.lotNo, expiry: l.expiry ?? '', qty: l.qty })) : [{ lotNo: '', expiry: '', qty: qty || null }]);
    setSerialText(v.map((l) => l.lotNo).join('\n'));
    setTake(Object.fromEntries(v.map((l) => [l.lotNo, l.qty])));
    setFilter('');
  }, [open, value, qty]);

  const toLine = (base: number) => Math.floor((base * 1000) / factor); // base → line unit (x1000)
  const serials = useMemo(() => [...new Set(serialText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))], [serialText]);

  let entries: LotEntry[] = [];
  if (direction === 'in') {
    entries = serial
      ? serials.map((s) => ({ lotNo: s, qty: 1000 }))
      : rows.filter((r) => r.lotNo.trim() && r.qty).map((r) => ({ lotNo: r.lotNo.trim(), expiry: r.expiry || null, qty: r.qty! }));
  } else {
    entries = Object.entries(take)
      .filter(([, q]) => q && q > 0)
      .map(([lotNo, q]) => ({ lotNo, qty: q! }));
  }
  const total = entries.reduce((s, e) => s + e.qty, 0);
  const matches = freeTotal ? total >= 0 : total === qty;
  const missingExpiry: boolean = !!(direction === 'in' && !serial && item.requires_expiry && rows.some((r) => r.lotNo.trim() && !r.expiry));
  const today = todayIso();

  const expiryBadge = (d: string | null) => {
    if (!d) return null;
    const days = Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
    if (days < 0) return <Badge tone="red">{t('adv.expired')}</Badge>;
    if (days <= 60) return <Badge tone="amber">{t('adv.expiresIn', { n: days })}</Badge>;
    return null;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={`${serial ? t('adv.serials') : t('adv.lots')} · ${item.sku}`}
      footer={
        <>
          <span className={matches ? 'success-text' : 'danger-text'} style={{ marginInlineEnd: 'auto', fontSize: 13, fontWeight: 600 }}>
            {t('adv.lotsTotal', { n: formatQty(total, locale), total: formatQty(qty, locale) })}
          </span>
          {direction === 'out' && (
            <Button
              icon={<Wand2 />}
              onClick={() => {
                onChange(null);
                onClose();
              }}
            >
              {t('adv.autoFefo')}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!matches || !!missingExpiry}
            onClick={() => {
              onChange(entries.length ? entries : null);
              onClose();
            }}
          >
            {t('common.apply')}
          </Button>
        </>
      }
    >
      {direction === 'in' && serial && (
        <div className="stack">
          <p className="muted" style={{ fontSize: 13 }}>
            {t('adv.pasteSerials')}
          </p>
          <Textarea rows={10} value={serialText} onChange={(e) => setSerialText(e.target.value)} dir="ltr" className="mono" autoFocus />
        </div>
      )}

      {direction === 'in' && !serial && (
        <div className="stack">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('adv.lotNo')}</th>
                <th>{t('adv.expiry')}</th>
                <th className="end">{t('docs.qty')}</th>
                <th className="shrink" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <Input sm value={r.lotNo} dir="ltr" autoFocus={i === 0} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, lotNo: e.target.value } : x)))} />
                  </td>
                  <td>
                    <Input sm type="date" value={r.expiry} aria-invalid={!!item.requires_expiry && !!r.lotNo && !r.expiry} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, expiry: e.target.value } : x)))} />
                  </td>
                  <td style={{ width: 130 }}>
                    <DecimalInput sm trim scale={QTY} value={r.qty} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setRows([...rows, { lotNo: '', expiry: '', qty: Math.max(0, qty - total) || null }])}>
              {t('adv.addLot')}
            </Button>
          </div>
        </div>
      )}

      {direction === 'out' && (
        <div className="stack">
          {serial && <Input sm placeholder={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} dir="ltr" />}
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{serial ? t('adv.serialNo') : t('adv.lotNo')}</th>
                  <th>{t('adv.expiry')}</th>
                  <th className="end">{t('adv.available')}</th>
                  <th className="end">{t('adv.take')}</th>
                </tr>
              </thead>
              <tbody>
                {(stock ?? [])
                  .filter((l) => !filter || l.lot_no.toLowerCase().includes(filter.toLowerCase()))
                  .map((l) => {
                    const avail = toLine(l.qty);
                    const expired = !!l.expiry_date && l.expiry_date < today;
                    return (
                      <tr key={l.id} style={{ opacity: expired ? 0.55 : 1 }}>
                        <td className="mono">{l.lot_no}</td>
                        <td className="nowrap">
                          {l.expiry_date ?? '—'} {expiryBadge(l.expiry_date)}
                        </td>
                        <td className="end num">{formatQty(avail, locale)}</td>
                        <td style={{ width: 130 }}>
                          {serial ? (
                            <input
                              type="checkbox"
                              checked={!!take[l.lot_no]}
                              disabled={expired}
                              onChange={(e) => setTake({ ...take, [l.lot_no]: e.target.checked ? 1000 : null })}
                              style={{ accentColor: 'var(--primary)', width: 16, height: 16 }}
                            />
                          ) : (
                            <DecimalInput sm trim scale={QTY} disabled={expired} value={take[l.lot_no] ?? null} onChange={(v) => setTake({ ...take, [l.lot_no]: v == null ? null : Math.min(v, avail) })} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** The small "lots" chip under a line's item. */
export function LotChip({ lots, required, direction, onClick }: { lots: LotEntry[] | null | undefined; required: boolean; direction: 'in' | 'out'; onClick(): void }) {
  const { t, locale } = useI18n();
  const text = lots?.length
    ? lots.length > 3
      ? `${lots.length} × ${lots[0].lotNo}…`
      : lots.map((l) => `${l.lotNo}${l.qty !== 1000 ? ' ×' + formatQty(l.qty, locale) : ''}`).join(' · ')
    : direction === 'out'
      ? t('adv.autoFefo')
      : t('adv.lotsNeeded');
  return (
    <button
      type="button"
      onClick={onClick}
      className={`badge plain ${!lots?.length && required ? 'badge-red' : 'badge-blue'}`}
      style={{ border: 0, cursor: 'pointer', marginTop: 4, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
      title={t('adv.chooseLots')}
    >
      {text}
    </button>
  );
}
