import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, ScanSearch, Search } from 'lucide-react';
import { useApi, useDate } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { todayIso } from '../../core/format';
import { downloadCsv } from '../../lib/csv';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Loading, EmptyState } from '../../ui/Page';
import { Money } from '../../ui/Money';
import { Select } from '../../ui/Field';
import { ReportFrame, usePeriod } from '../reports/shared';
import { Qty, WarehouseSelect, moveSourceLink } from './common';

const itemLink = (id: number) => `/inventory/items/${id}`;

function Stat({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <Card pad>
      <div className="label">{label}</div>
      <div className={`amount ${tone === 'danger' ? 'danger-text' : ''}`} style={{ fontSize: 22, marginTop: 4, color: tone === 'warning' ? 'var(--warning)' : undefined }}>
        {children}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- expiry
export function ExpiryPage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const { params, set } = usePeriod();
  const days = Number(params.get('days') ?? 90);
  const wh = params.get('warehouseId') ? Number(params.get('warehouseId')) : null;
  const { data, isLoading } = useApi<{
    rows: { id: number; lot_no: string; expiry_date: string; item_id: number; sku: string; name_en: string; name_ar: string; unit: string | null; warehouse_code: string; qty: number; value: number; days_left: number; status: 'expired' | 'expiring' }[];
    expiredValue: number;
    expiringValue: number;
  }>('/inventory/reports/expiry', { days, warehouseId: wh ?? undefined });
  return (
    <ReportFrame
      title={t('adv.expiryReport')}
      subtitle={t('adv.expiryDesc')}
      onExport={() =>
        data &&
        downloadCsv(
          'expiry',
          [t('items.sku'), t('common.name'), t('adv.lotNo'), t('adv.expiry'), t('adv.daysLeft'), t('inventory.warehouse'), t('docs.qty'), t('inventory.value')],
          data.rows.map((r) => [r.sku, pick(r.name_en, r.name_ar), r.lot_no, r.expiry_date, r.days_left, r.warehouse_code, r.qty / 1000, r.value]),
        )
      }
      controls={
        <>
          <Select value={days} onChange={(e) => set({ days: e.target.value })} style={{ width: 'auto' }}>
            {[30, 60, 90, 180, 365].map((n) => (
              <option key={n} value={n}>
                {t('adv.withinDays', { n })}
              </option>
            ))}
          </Select>
          <WarehouseSelect all value={wh} onChange={(v) => set({ warehouseId: v ? String(v) : null })} />
        </>
      }
    >
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <Stat label={t('adv.expiredValue')} tone="danger">
          <Money v={data?.expiredValue ?? 0} />
        </Stat>
        <Stat label={t('adv.expiringValue')} tone="warning">
          <Money v={data?.expiringValue ?? 0} />
        </Stat>
      </div>
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <EmptyState icon={<CheckCircle2 size={22} />} title={t('dashboard.allGood')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th>{t('adv.lotNo')}</th>
                  <th>{t('adv.expiry')}</th>
                  <th className="end">{t('adv.daysLeft')}</th>
                  <th>{t('inventory.warehouse')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('inventory.value')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.id}-${r.warehouse_code}`}>
                    <td>
                      <Link to={itemLink(r.item_id)}>
                        <span className="num faint" style={{ marginInlineEnd: 8 }}>
                          {r.sku}
                        </span>
                        {pick(r.name_en, r.name_ar)}
                      </Link>
                    </td>
                    <td className="num">{r.lot_no}</td>
                    <td className="nowrap">{date(r.expiry_date)}</td>
                    <td className="end">
                      {r.status === 'expired' ? <Badge tone="red">{t('adv.expired')}</Badge> : <Badge tone={r.days_left <= 30 ? 'amber' : 'neutral'}>{r.days_left}</Badge>}
                    </td>
                    <td className="muted">{r.warehouse_code}</td>
                    <td className="end">
                      <Qty v={r.qty} unit={r.unit} />
                    </td>
                    <td className="end">
                      <Money v={r.value} />
                    </td>
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

// ----------------------------------------------------------------- trace
interface TraceLot {
  id: number;
  lot_no: string;
  expiry_date: string | null;
  item_id: number;
  sku: string;
  name_en: string;
  name_ar: string;
  tracking: 'batch' | 'serial';
  on_hand: { warehouse_code: string; qty: number }[];
  moves: { id: number; date: string; qty: number; source_type: string; source_id: number; is_reversal: number; warehouse_code: string; source_number: string | null; party_name: string | null }[];
}

export function TracePage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const { params, set } = usePeriod();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const { data, isLoading } = useApi<{ lots: TraceLot[] }>(q ? '/inventory/trace' : null, { q });
  return (
    <ReportFrame
      title={t('adv.trace')}
      subtitle={t('adv.traceDesc')}
      controls={
        <form
          className="input-group"
          style={{ minWidth: 260 }}
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: text.trim() || null });
          }}
        >
          <Search />
          <input className="input" autoFocus placeholder={t('adv.tracePlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
        </form>
      }
    >
      {!q ? (
        <Card>
          <EmptyState icon={<ScanSearch size={22} />} title={t('adv.tracePlaceholder')} text={t('adv.traceDesc')} />
        </Card>
      ) : isLoading || !data ? (
        <Loading />
      ) : !data.lots.length ? (
        <Card>
          <EmptyState icon={<ScanSearch size={22} />} title={t('common.noResults')} />
        </Card>
      ) : (
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          {data.lots.map((l) => (
            <Card key={l.id} className="table-card">
              <CardHeader
                title={
                  <span className="row" style={{ gap: 10 }}>
                    <span className="num">{l.lot_no}</span>
                    <Badge tone={l.tracking === 'serial' ? 'blue' : 'cyan'}>{l.tracking === 'serial' ? t('adv.serialNo') : t('adv.lotNo')}</Badge>
                    {l.expiry_date && (
                      <Badge tone={l.expiry_date < todayIso() ? 'red' : 'neutral'}>
                        {t('adv.expiry')} {date(l.expiry_date)}
                      </Badge>
                    )}
                  </span>
                }
                actions={
                  <Link to={itemLink(l.item_id)} className="muted">
                    {l.sku} · {pick(l.name_en, l.name_ar)}
                  </Link>
                }
              />
              <div className="card-body row" style={{ gap: 8, flexWrap: 'wrap', paddingBlock: 10 }}>
                <span className="label">{t('adv.onHandNow')}</span>
                {l.on_hand.length ? (
                  l.on_hand.map((h) => (
                    <Badge key={h.warehouse_code} tone="green">
                      {h.warehouse_code}: <Qty v={h.qty} />
                    </Badge>
                  ))
                ) : (
                  <span className="faint">—</span>
                )}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('common.source')}</th>
                      <th>{t('reports.party')}</th>
                      <th>{t('inventory.warehouse')}</th>
                      <th className="end">{t('docs.qty')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.moves.map((m) => (
                      <tr key={m.id}>
                        <td className="nowrap">{date(m.date)}</td>
                        <td>
                          <Link to={moveSourceLink(m.source_type, m.source_id)}>
                            {m.source_number ?? t('journal.sources.' + m.source_type)}
                          </Link>
                          <span className="faint" style={{ fontSize: 12, marginInline: 8 }}>
                            {t('journal.sources.' + m.source_type)}
                          </span>
                          {!!m.is_reversal && <Badge tone="red">{t('status.void')}</Badge>}
                        </td>
                        <td>{m.party_name ?? ''}</td>
                        <td className="muted">{m.warehouse_code}</td>
                        <td className="end">
                          <Qty v={m.qty} signed tone />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
    </ReportFrame>
  );
}

// ------------------------------------------------------------------ GRNI
export function GrniPage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const { data, isLoading } = useApi<{
    rows: { id: number; receipt_id: number; number: string; date: string; supplier_name: string; sku: string; name_en: string; name_ar: string; base_quantity: number; billed_base: number; value: number; billed_value: number }[];
    open: number;
    ledger: number;
  }>('/inventory/reports/grni');
  const diff = data ? data.ledger - data.open : 0;
  return (
    <ReportFrame
      title={t('adv.grni')}
      subtitle={t('adv.grniDesc')}
      badge={
        data &&
        (diff === 0 ? (
          <Badge tone="green">
            <CheckCircle2 size={12} /> {t('inventory.reports.reconciled')}
          </Badge>
        ) : (
          <Badge tone="amber">
            <AlertTriangle size={12} /> <Money v={diff} />
          </Badge>
        ))
      }
      onExport={() =>
        data &&
        downloadCsv(
          'grni',
          [t('common.number'), t('common.date'), t('docs.supplier'), t('items.sku'), t('common.name'), t('adv.toBill'), t('inventory.value')],
          data.rows.map((r) => [r.number, r.date, r.supplier_name, r.sku, pick(r.name_en, r.name_ar), (r.base_quantity - r.billed_base) / 1000, r.value - r.billed_value]),
        )
      }
    >
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <Stat label={t('adv.unbilled')}>
          <Money v={data?.open ?? 0} />
        </Stat>
        <Stat label={t('adv.grniLedger')}>
          <Money v={data?.ledger ?? 0} />
        </Stat>
      </div>
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <EmptyState icon={<CheckCircle2 size={22} />} title={t('dashboard.allGood')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('adv.receipt')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('docs.supplier')}</th>
                  <th>{t('docs.item')}</th>
                  <th className="end">{t('adv.toBill')}</th>
                  <th className="end">{t('inventory.value')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/inventory/receipts/${r.receipt_id}`} style={{ fontWeight: 550 }}>
                        {r.number}
                      </Link>
                    </td>
                    <td className="nowrap">{date(r.date)}</td>
                    <td>{r.supplier_name}</td>
                    <td>
                      <span className="num faint" style={{ marginInlineEnd: 8 }}>
                        {r.sku}
                      </span>
                      {pick(r.name_en, r.name_ar)}
                    </td>
                    <td className="end">
                      <Qty v={r.base_quantity - r.billed_base} />
                    </td>
                    <td className="end">
                      <Money v={r.value - r.billed_value} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={data.open} />
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
