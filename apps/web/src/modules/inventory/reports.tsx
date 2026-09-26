import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useApi, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { formatBp, todayIso } from '../../core/format';
import { downloadCsv } from '../../lib/csv';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Loading, EmptyState } from '../../ui/Page';
import { Money } from '../../ui/Money';
import { PeriodControls, ReportFrame, useCsvMoney, usePeriod } from '../reports/shared';
import { Qty, WarehouseSelect } from './common';

const itemLink = (id: number) => `/inventory/items/${id}`;

// ------------------------------------------------------------------ valuation
export function ValuationPage() {
  const { t, pick } = useI18n();
  const { fmt } = useMoney();
  const csv = useCsvMoney();
  const { params, set } = usePeriod();
  const asOf = params.get('asOf') ?? todayIso();
  const wh = params.get('warehouseId') ? Number(params.get('warehouseId')) : null;
  const { data, isLoading } = useApi<{
    rows: { id: number; sku: string; name_en: string; name_ar: string; unit: string | null; category_name_en: string | null; category_name_ar: string | null; qty: number; value: number; avg_cost: number }[];
    total: number;
    ledger: number | null;
    difference: number | null;
  }>('/inventory/reports/valuation', { asOf, warehouseId: wh ?? undefined });

  return (
    <ReportFrame
      title={t('inventory.reports.valuation')}
      subtitle={`${t('common.asOf')} ${asOf}`}
      badge={
        data?.difference != null &&
        (data.difference === 0 ? (
          <Badge tone="green">
            <CheckCircle2 size={12} /> {t('inventory.reports.reconciled')}
          </Badge>
        ) : (
          <Badge tone="red">
            <AlertTriangle size={12} /> {t('inventory.reports.notReconciled', { amount: fmt(data.difference) })}
          </Badge>
        ))
      }
      onExport={() =>
        data &&
        downloadCsv(
          `stock-valuation-${asOf}`,
          [t('items.sku'), t('common.name'), t('items.category'), t('docs.qty'), t('inventory.avgCost'), t('inventory.value')],
          data.rows.map((r) => [r.sku, pick(r.name_en, r.name_ar), pick(r.category_name_en, r.category_name_ar), r.qty / 1000, csv(r.avg_cost), csv(r.value)]),
        )
      }
      controls={
        <>
          <span className="muted">{t('common.asOf')}</span>
          <input className="input" type="date" style={{ width: 'auto' }} value={asOf} onChange={(e) => set({ asOf: e.target.value })} />
          <WarehouseSelect all value={wh} onChange={(v) => set({ warehouseId: v ? String(v) : null })} />
        </>
      }
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th>{t('items.category')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('inventory.avgCost')}</th>
                  <th className="end">{t('inventory.value')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={itemLink(r.id)}>
                        <span className="num faint" style={{ marginInlineEnd: 8 }}>
                          {r.sku}
                        </span>
                        {pick(r.name_en, r.name_ar)}
                      </Link>
                    </td>
                    <td className="muted">{pick(r.category_name_en, r.category_name_ar) || '—'}</td>
                    <td className="end">
                      <Qty v={r.qty} unit={r.unit} />
                    </td>
                    <td className="end">
                      <Money v={r.avg_cost} />
                    </td>
                    <td className="end">
                      <Money v={r.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={data.total} />
                  </td>
                </tr>
                {data.ledger != null && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {t('inventory.reports.ledgerValue')}
                    </td>
                    <td className="end">
                      <Money v={data.ledger} />
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// ------------------------------------------------------------------- movement
export function MovementPage() {
  const { t, pick } = useI18n();
  const csv = useCsvMoney();
  const { from, to, params, set } = usePeriod();
  const wh = params.get('warehouseId') ? Number(params.get('warehouseId')) : null;
  const { data, isLoading } = useApi<{
    rows: { id: number; sku: string; name_en: string; name_ar: string; unit: string | null; opening_qty: number; opening_value: number | null; in_qty: number; in_value: number; out_qty: number; out_value: number; closing_qty: number; closing_value: number | null }[];
  }>('/inventory/reports/movement', { from, to, warehouseId: wh ?? undefined });
  const showValue = !wh;
  return (
    <ReportFrame
      title={t('inventory.reports.movement')}
      subtitle={t('reports.periodLabel', { from, to })}
      onExport={() =>
        data &&
        downloadCsv(
          `stock-movement-${from}-${to}`,
          [t('items.sku'), t('common.name'), t('inventory.opening'), t('inventory.in'), t('inventory.out_'), t('inventory.closing'), t('inventory.value')],
          data.rows.map((r) => [r.sku, pick(r.name_en, r.name_ar), r.opening_qty / 1000, r.in_qty / 1000, r.out_qty / 1000, r.closing_qty / 1000, r.closing_value != null ? csv(r.closing_value) : '']),
        )
      }
      controls={
        <>
          <PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />
          <WarehouseSelect all value={wh} onChange={(v) => set({ warehouseId: v ? String(v) : null })} />
        </>
      }
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th rowSpan={2}>{t('docs.item')}</th>
                  {[t('inventory.opening'), t('inventory.in'), t('inventory.out_'), t('inventory.closing')].map((h) => (
                    <th key={h} colSpan={showValue ? 2 : 1} className="center">
                      {h}
                    </th>
                  ))}
                </tr>
                <tr>
                  {[0, 1, 2, 3].map((i) => (
                    <SubHeads key={i} showValue={showValue} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={itemLink(r.id)}>
                        <span className="num faint" style={{ marginInlineEnd: 8 }}>
                          {r.sku}
                        </span>
                        {pick(r.name_en, r.name_ar)}
                      </Link>
                    </td>
                    <Pair q={r.opening_qty} v={r.opening_value} showValue={showValue} />
                    <Pair q={r.in_qty} v={r.in_value} showValue={showValue} />
                    <Pair q={r.out_qty} v={r.out_value} showValue={showValue} />
                    <Pair q={r.closing_qty} v={r.closing_value} showValue={showValue} strong />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

function SubHeads({ showValue }: { showValue: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <th className="end">{t('docs.qty')}</th>
      {showValue && <th className="end">{t('inventory.value')}</th>}
    </>
  );
}

function Pair({ q, v, showValue, strong }: { q: number; v: number | null; showValue: boolean; strong?: boolean }) {
  return (
    <>
      <td className="end" style={strong ? { fontWeight: 650 } : undefined}>
        {q ? <Qty v={q} /> : <span className="faint">—</span>}
      </td>
      {showValue && (
        <td className="end muted">
          <Money v={v ?? 0} dashZero />
        </td>
      )}
    </>
  );
}

// -------------------------------------------------------------------- reorder
export function ReorderPage() {
  const { t, pick } = useI18n();
  const { params, set } = usePeriod();
  const wh = params.get('warehouseId') ? Number(params.get('warehouseId')) : null;
  const { data, isLoading } = useApi<
    { id: number; sku: string; name_en: string; name_ar: string; unit: string | null; qty: number; reorder_level: number; suggested: number; sold_90d: number; est_cost: number }[]
  >('/inventory/reports/reorder', { warehouseId: wh ?? undefined });
  const total = (data ?? []).reduce((s, r) => s + r.est_cost, 0);
  return (
    <ReportFrame
      title={t('inventory.reports.reorder')}
      subtitle={t('inventory.reports.reorderDesc')}
      onExport={() =>
        data &&
        downloadCsv(
          'reorder',
          [t('items.sku'), t('common.name'), t('inventory.onHand'), t('inventory.reorderLevel'), t('inventory.reports.sold90'), t('inventory.reports.suggested')],
          data.map((r) => [r.sku, pick(r.name_en, r.name_ar), r.qty / 1000, r.reorder_level / 1000, r.sold_90d / 1000, r.suggested / 1000]),
        )
      }
      controls={<WarehouseSelect all value={wh} onChange={(v) => set({ warehouseId: v ? String(v) : null })} />}
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.length ? (
          <EmptyState icon={<CheckCircle2 size={22} />} title={t('dashboard.allGood')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th className="end">{t('inventory.onHand')}</th>
                  <th className="end">{t('inventory.reorderLevel')}</th>
                  <th className="end">{t('inventory.reports.sold90')}</th>
                  <th className="end">{t('inventory.reports.suggested')}</th>
                  <th className="end">{t('inventory.reports.estCost')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={itemLink(r.id)}>
                        <span className="num faint" style={{ marginInlineEnd: 8 }}>
                          {r.sku}
                        </span>
                        {pick(r.name_en, r.name_ar)}
                      </Link>
                    </td>
                    <td className={`end ${r.qty <= 0 ? 'danger-text' : ''}`} style={{ fontWeight: 600 }}>
                      <Qty v={r.qty} unit={r.unit} />
                    </td>
                    <td className="end muted">
                      <Qty v={r.reorder_level} />
                    </td>
                    <td className="end muted">
                      <Qty v={r.sold_90d} />
                    </td>
                    <td className="end" style={{ fontWeight: 650, color: 'var(--primary)' }}>
                      <Qty v={r.suggested} unit={r.unit} />
                    </td>
                    <td className="end">
                      <Money v={r.est_cost} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={total} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// -------------------------------------------------------------- profitability
export function ProfitabilityPage() {
  const { t, pick } = useI18n();
  const csv = useCsvMoney();
  const { from, to, set } = usePeriod();
  const { data, isLoading } = useApi<{
    rows: { id: number; sku: string; name_en: string; name_ar: string; kind: string; qty: number; revenue: number; cost: number; profit: number; margin_bp: number }[];
    totals: { revenue: number; cost: number; profit: number };
  }>('/inventory/reports/profitability', { from, to });
  return (
    <ReportFrame
      title={t('inventory.reports.profitability')}
      subtitle={t('reports.periodLabel', { from, to })}
      onExport={() =>
        data &&
        downloadCsv(
          `item-profitability-${from}-${to}`,
          [t('items.sku'), t('common.name'), t('inventory.reports.qtySold'), t('inventory.reports.revenue'), t('inventory.reports.cost'), t('inventory.reports.profit'), t('inventory.reports.margin')],
          data.rows.map((r) => [r.sku, pick(r.name_en, r.name_ar), r.qty / 1000, csv(r.revenue), csv(r.cost), csv(r.profit), r.margin_bp / 100]),
        )
      }
      controls={<PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />}
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th className="end">{t('inventory.reports.qtySold')}</th>
                  <th className="end">{t('inventory.reports.revenue')}</th>
                  <th className="end">{t('inventory.reports.cost')}</th>
                  <th className="end">{t('inventory.reports.profit')}</th>
                  <th className="end">{t('inventory.reports.margin')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="num faint" style={{ marginInlineEnd: 8 }}>
                        {r.sku}
                      </span>
                      {pick(r.name_en, r.name_ar)}
                    </td>
                    <td className="end">
                      <Qty v={r.qty} />
                    </td>
                    <td className="end">
                      <Money v={r.revenue} />
                    </td>
                    <td className="end muted">
                      <Money v={r.cost} dashZero />
                    </td>
                    <td className="end" style={{ fontWeight: 650 }}>
                      <Money v={r.profit} tone />
                    </td>
                    <td className="end">
                      <MarginBar bp={r.margin_bp} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={data.totals.revenue} />
                  </td>
                  <td className="end">
                    <Money v={data.totals.cost} />
                  </td>
                  <td className="end">
                    <Money v={data.totals.profit} />
                  </td>
                  <td className="end num">{data.totals.revenue ? formatBp(Math.round((data.totals.profit * 10000) / data.totals.revenue)) : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

function MarginBar({ bp }: { bp: number }) {
  const pct = Math.max(0, Math.min(100, bp / 100));
  const color = bp < 0 ? 'var(--danger)' : bp < 1500 ? 'var(--warning)' : 'var(--success)';
  return (
    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
      <span style={{ width: 60, height: 6, borderRadius: 3, background: 'var(--bg-muted)', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
      </span>
      <span className="num" style={{ minWidth: 48, color }}>
        {formatBp(bp)}
      </span>
    </span>
  );
}
