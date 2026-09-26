import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Download, Package, SlidersHorizontal } from 'lucide-react';
import { useApi, useDate, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { Item } from '../../core/types';
import { downloadCsv, csvMoney } from '../../lib/csv';
import { PageHeader, Loading, ErrorBlock, EmptyState } from '../../ui/Page';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Money } from '../../ui/Money';
import { Kpi } from './StockPage';
import { moveSourceLink, Qty, WarehouseSelect } from './common';

interface ItemStock {
  item: Item;
  qty: number;
  value: number;
  avg_cost: number;
  levels: { warehouse_id: number; code: string; name_en: string; name_ar: string; qty: number; value: number }[];
}

interface CardRow {
  id: number;
  date: string;
  qty: number;
  value: number;
  unit_cost: number;
  source_type: string;
  source_id: number;
  source_number: string | null;
  party_name: string | null;
  warehouse_code: string;
  is_reversal: number;
  journal_entry_id: number | null;
  journal_number: string | null;
  balance_qty: number;
  balance_value: number;
}

export function ItemCardPage() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { scale } = useMoney();
  const { can } = useSession();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [wh, setWh] = useState<number | null>(null);
  const { data: s, isLoading, error } = useApi<ItemStock>(`/inventory/items/${id}`);
  const { data: card } = useApi<{ opening: { qty: number; value: number }; rows: CardRow[]; closing: { qty: number; value: number }; totals: Record<string, number> }>(
    `/inventory/items/${id}/card`,
    { from, to, warehouseId: wh ?? undefined },
  );

  if (isLoading) return <Loading />;
  if (error || !s) return <ErrorBlock message={String(error ?? '')} />;
  const it = s.item;
  const low = it.reorder_level > 0 && s.qty <= it.reorder_level;
  const sourceLabel = (r: CardRow) => {
    const k = ['adjustment', 'opening', 'count', 'transfer'].includes(r.source_type) ? `inventory.kinds.${r.source_type}` : `journal.sources.${r.source_type}`;
    return t(k);
  };

  const exportCsv = () =>
    card &&
    downloadCsv(
      `item-card-${it.sku}-${from}-${to}`,
      [t('common.date'), t('common.number'), t('common.type'), t('inventory.warehouse'), t('inventory.in'), t('inventory.out_'), t('inventory.unitCost'), t('common.amount'), t('inventory.balance'), t('inventory.value')],
      [
        [from, '', t('inventory.opening'), '', '', '', '', '', card.opening.qty / 1000, wh ? '' : csvMoney(card.opening.value, scale)],
        ...card.rows.map((r) => [
          r.date,
          r.source_number ?? '',
          sourceLabel(r),
          r.warehouse_code,
          r.qty > 0 ? r.qty / 1000 : '',
          r.qty < 0 ? -r.qty / 1000 : '',
          csvMoney(r.unit_cost, scale),
          csvMoney(r.value, scale),
          r.balance_qty / 1000,
          wh ? '' : csvMoney(r.balance_value, scale),
        ]),
      ],
    );

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory', label: t('nav.stock') }]}
        title={pick(it.name_en, it.name_ar)}
        badge={
          <>
            <Badge tone="blue" plain>
              {it.sku}
            </Badge>
            {!it.is_active && <Badge>{t('common.inactive')}</Badge>}
          </>
        }
        subtitle={[t('inventory.card'), it.barcode].filter(Boolean).join(' · ')}
        actions={
          <>
            <Link to="/items" className="btn">
              <Package /> {t('nav.items')}
            </Link>
            {can('inventory.write') && (
              <Link to={`/inventory/operations/new?kind=adjustment&item=${it.id}`} className="btn btn-primary">
                <SlidersHorizontal /> {t('inventory.kinds.adjustment')}
              </Link>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <div className="grid-4">
          <Kpi icon={<Package />} label={t('inventory.onHand')} value={<Qty v={s.qty} unit={it.unit} />} tone={low ? 'var(--line-amber)' : undefined} />
          <Kpi icon={<span>ø</span>} label={t('inventory.avgCost')} value={<Money v={s.avg_cost} />} />
          <Kpi icon={<span>Σ</span>} label={t('inventory.value')} value={<Money v={s.value} />} />
          <Kpi icon={<span>↺</span>} label={t('inventory.reorderLevel')} value={it.reorder_level ? <Qty v={it.reorder_level} /> : '—'} tone={low ? 'var(--danger)' : undefined} />
        </div>

        <Card className="table-card">
          <CardHeader title={t('inventory.byWarehouse')} />
          <table className="table">
            <tbody>
              {s.levels.map((l) => (
                <tr key={l.warehouse_id}>
                  <td>
                    <span className="num faint" style={{ marginInlineEnd: 8 }}>
                      {l.code}
                    </span>
                    {pick(l.name_en, l.name_ar)}
                  </td>
                  <td className="end" style={{ fontWeight: 600 }}>
                    <Qty v={l.qty} unit={it.unit} />
                  </td>
                  <td className="end muted">
                    <Money v={l.value} dashZero />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card className="table-card">
          <CardHeader
            title={t('inventory.movements')}
            sub={t('inventory.cardSubtitle')}
            actions={
              <div className="row wrap no-print">
                <WarehouseSelect all value={wh} onChange={setWh} />
                <Input type="date" sm value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
                <Input type="date" sm value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
                <Button size="sm" icon={<Download />} onClick={exportCsv}>
                  CSV
                </Button>
              </div>
            }
          />
          {!card ? (
            <Loading />
          ) : card.rows.length === 0 && card.opening.qty === 0 ? (
            <EmptyState title={t('common.noResults')} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.number')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('inventory.warehouse')}</th>
                    <th className="end">{t('inventory.in')}</th>
                    <th className="end">{t('inventory.out_')}</th>
                    <th className="end">{t('inventory.unitCost')}</th>
                    <th className="end">{t('inventory.balance')}</th>
                    {!wh && <th className="end">{t('inventory.value')}</th>}
                  </tr>
                </thead>
                <tbody>
                  <tr className="group-row">
                    <td colSpan={7}>{t('inventory.opening')}</td>
                    <td className="end">
                      <Qty v={card.opening.qty} />
                    </td>
                    {!wh && (
                      <td className="end">
                        <Money v={card.opening.value} />
                      </td>
                    )}
                  </tr>
                  {card.rows.map((r) => (
                    <tr key={r.id} style={{ opacity: r.is_reversal ? 0.7 : 1 }}>
                      <td className="nowrap">{date(r.date)}</td>
                      <td className="nowrap">
                        <Link to={moveSourceLink(r.source_type, r.source_id)} style={{ fontWeight: 550 }}>
                          {r.source_number ?? '—'}
                        </Link>
                        {r.party_name && <div className="faint" style={{ fontSize: 12 }}>{r.party_name}</div>}
                      </td>
                      <td className="muted">
                        {sourceLabel(r)}
                        {!!r.is_reversal && (
                          <Badge tone="amber" plain>
                            {t('status.void')}
                          </Badge>
                        )}
                      </td>
                      <td className="muted">{r.warehouse_code}</td>
                      <td className="end success-text">{r.qty > 0 ? <Qty v={r.qty} /> : ''}</td>
                      <td className="end danger-text">{r.qty < 0 ? <Qty v={-r.qty} /> : ''}</td>
                      <td className="end muted">
                        <Money v={r.unit_cost} />
                      </td>
                      <td className="end" style={{ fontWeight: 600 }}>
                        <Qty v={r.balance_qty} />
                      </td>
                      {!wh && (
                        <td className="end">
                          <Money v={r.balance_value} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{t('inventory.closing')}</td>
                    <td className="end">
                      <Qty v={card.totals.in_qty} />
                    </td>
                    <td className="end">
                      <Qty v={card.totals.out_qty} />
                    </td>
                    <td />
                    <td className="end">
                      <Qty v={card.closing.qty} />
                    </td>
                    {!wh && (
                      <td className="end">
                        <Money v={card.closing.value} />
                      </td>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
