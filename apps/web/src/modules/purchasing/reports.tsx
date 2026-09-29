import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { PageHeader } from '../../ui/Page';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { Badge } from '../../ui/Badge';
import { Field, Input } from '../../ui/Field';
import { Card } from '../../ui/Card';
import { Money } from '../../ui/Money';
import { Qty } from '../../ui/Stock';
import { todayIso } from '../../core/format';

const pct = (bp: number | null) => (bp == null ? '—' : `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`);

/** Supplier on-time delivery: each receipt line of an order against the order line's expected date. */
export function SupplierOnTimePage() {
  const { t } = useI18n();
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const { data, isLoading } = useApi<any>('/purchasing/reports/supplier-on-time', { from, to });
  const suppliers = useMemo<Column<any>[]>(
    () => [
      { id: 'supplier', header: t('docs.supplier'), pinned: true, value: (r) => r.supplier_name },
      { id: 'lines', header: t('pur.rep.lines'), type: 'number', value: (r) => r.lines },
      { id: 'onTime', header: t('pur.rep.onTime'), type: 'number', value: (r) => r.on_time },
      { id: 'late', header: t('pur.rep.late'), type: 'number', value: (r) => r.late },
      { id: 'pct', header: t('pur.rep.onTimePct'), type: 'number', value: (r) => (r.on_time_bp ?? 0) / 100, render: (r) => <Badge tone={r.on_time_bp == null ? 'neutral' : r.on_time_bp >= 9000 ? 'green' : r.on_time_bp >= 7000 ? 'amber' : 'red'}>{pct(r.on_time_bp)}</Badge> },
      { id: 'avg', header: t('pur.rep.avgDaysLate'), type: 'number', value: (r) => r.avg_days_late },
      { id: 'max', header: t('pur.rep.maxDaysLate'), type: 'number', value: (r) => r.max_days_late },
    ],
    [t],
  );
  const lines = useMemo<Column<any>[]>(
    () => [
      { id: 'po', header: t('adv.purchaseOrder'), value: (r) => r.po_number },
      { id: 'supplier', header: t('docs.supplier'), type: 'enum', value: (r) => r.supplier_name },
      { id: 'receipt', header: t('adv.receipt'), value: (r) => r.receipt_number },
      { id: 'item', header: t('docs.item'), value: (r) => `${r.sku ?? ''} ${r.description}` },
      { id: 'expected', header: t('pur.rep.expected'), type: 'date', value: (r) => r.expected },
      { id: 'received', header: t('pur.rep.received'), type: 'date', value: (r) => r.received },
      { id: 'days', header: t('pur.rep.daysLate'), type: 'number', value: (r) => r.days_late, render: (r) => <span className={r.on_time === false ? 'danger-text' : undefined}>{r.days_late ?? '—'}</span> },
    ],
    [t],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('pur.rep.onTimeTitle')}
        subtitle={t('pur.rep.onTimeSubtitle')}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Field label={t('common.from')}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('common.to')}>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <DataGrid id="rep-on-time-suppliers" rows={data?.suppliers} loading={isLoading} columns={suppliers} rowKey={(r) => r.supplier_id} exportName={t('pur.rep.onTimeTitle')} />
        <Card pad>
          <div className="label" style={{ marginBottom: 8 }}>{t('pur.rep.detail')}</div>
          <DataGrid id="rep-on-time-lines" rows={data?.lines} loading={isLoading} columns={lines} rowKey={(r) => `${r.receipt_number}-${r.po_number}-${r.line_no}`} exportName={t('pur.rep.detail')} />
        </Card>
      </div>
    </div>
  );
}

/** Open purchase orders: what is still to arrive, when, and how late it is. */
export function OpenOrdersPage() {
  const { t } = useI18n();
  const { data, isLoading } = useApi<any>('/purchasing/reports/open-orders');
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'po', header: t('adv.purchaseOrder'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <Link to={`/purchasing/orders/${r.po_id}`}>{r.number}</Link> },
      { id: 'supplier', header: t('docs.supplier'), type: 'enum', value: (r) => r.supplier_name },
      { id: 'item', header: t('docs.item'), value: (r) => `${r.sku ?? ''} ${r.description}` },
      { id: 'open', header: t('pur.rep.openQty'), type: 'qty', value: (r) => r.open_base, render: (r) => <Qty v={r.open_base} /> },
      { id: 'expected', header: t('pur.rep.expected'), type: 'date', nowrap: true, value: (r) => r.expected },
      { id: 'overdue', header: t('pur.rep.daysOverdue'), type: 'number', value: (r) => r.days_overdue, render: (r) => <span className={r.days_overdue ? 'danger-text' : 'faint'}>{r.days_overdue || '—'}</span> },
      { id: 'currency', header: t('fx.currency'), type: 'enum', value: (r) => r.currency ?? '' },
      { id: 'value', header: t('pur.rep.openValue'), type: 'money', total: true, value: (r) => r.open_value_base, render: (r) => <Money v={r.open_value_base} /> },
      { id: 'incoterm', header: t('pur.incoterm'), type: 'enum', hidden: true, value: (r) => r.incoterm },
      { id: 'req', header: t('pur.requisition'), hidden: true, value: (r) => r.requisition_number },
    ],
    [t],
  );
  return (
    <div className="page">
      <PageHeader title={t('pur.rep.openTitle')} subtitle={t('pur.rep.openSubtitle')} />
      <DataGrid id="rep-open-orders" rows={data?.rows} loading={isLoading} columns={columns} rowKey={(r) => `${r.po_id}-${r.line_no}`} exportName={t('pur.rep.openTitle')} />
    </div>
  );
}
