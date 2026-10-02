import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, BarChart3, CheckCircle2, ClipboardList, Hourglass, Lock, PackageCheck, Pencil, Plus, Printer, Target, Trash2, Truck } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { ApiError, api } from '../../core/api';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { todayIso } from '../../core/format';
import type { Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Field, Input, Select } from '../../ui/Field';
import { Money } from '../../ui/Money';
import { Qty } from '../../ui/Stock';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { SoEditor } from './SoEditor';

const SO_TONE: Record<string, Tone> = { draft: 'neutral', confirmed: 'blue', partially_delivered: 'amber', closed: 'green', cancelled: 'red' };
const DL_TONE: Record<string, Tone> = { draft: 'neutral', posted: 'green', void: 'red' };
const pct = (bp: number | null | undefined) => (bp == null ? '—' : `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`);
const tone = (bp: number | null | undefined): Tone => (bp == null ? 'neutral' : bp >= 9000 ? 'green' : bp >= 7000 ? 'amber' : 'red');

export function SoStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={SO_TONE[status] ?? 'neutral'}>{t('sd.status.' + status)}</Badge>;
}

/** A thin progress bar with its percentage (delivered / invoiced share of an order). */
function Progress({ ratio }: { ratio: number | null }) {
  const p = Math.round(Math.min(1, ratio ?? 0) * 100);
  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <span style={{ width: 54, height: 6, borderRadius: 3, background: 'var(--bg-muted)', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', width: `${p}%`, height: '100%', background: p === 100 ? 'var(--success)' : 'var(--primary)' }} />
      </span>
      <span className="num faint" style={{ minWidth: 34, fontSize: 12 }}>{p}%</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- sales orders
function SoList() {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Paged<any>>('/sales/orders', { limit: 20000 });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number}</span> },
      { id: 'customer', header: t('docs.customer'), type: 'enum', value: (r) => r.customer_name },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.order_date },
      { id: 'due', header: t('sd.nextDue'), type: 'date', nowrap: true, value: (r) => r.next_due },
      { id: 'reference', header: t('common.reference'), hidden: true, value: (r) => r.customer_reference },
      { id: 'priority', header: t('sd.priority'), type: 'number', hidden: true, value: (r) => r.priority },
      { id: 'delivered', header: t('sd.delivered'), type: 'number', value: (r) => Math.round((r.delivered_ratio ?? 0) * 100), format: (v) => `${v}%`, render: (r) => <Progress ratio={r.delivered_ratio} /> },
      { id: 'invoiced', header: t('sd.invoiced'), type: 'number', value: (r) => Math.round((r.invoiced_ratio ?? 0) * 100), format: (v) => `${v}%`, render: (r) => <Progress ratio={r.invoiced_ratio} /> },
      { id: 'total', header: t('common.total'), type: 'money', total: true, value: (r) => (r.status === 'cancelled' ? 0 : r.base_total), render: (r) => <Money v={r.base_total} /> },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('sd.status.' + v), render: (r) => <SoStatus status={r.status} /> },
    ],
    [t],
  );
  const presets = useMemo<Preset<any>[]>(() => ['draft', 'confirmed', 'partially_delivered', 'closed', 'cancelled'].map((k) => ({ id: k, label: t('sd.status.' + k), test: (r: any) => r.status === k })), [t]);
  return (
    <div className="page">
      <PageHeader
        title={t('sd.orders')}
        subtitle={t('sd.ordersSub')}
        actions={can('sales.orders.write') && <Link to="/sales/orders/new" className="btn btn-primary"><Plus /> {t('sd.newOrder')}</Link>}
      />
      <DataGrid
        id="sales-orders"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/sales/orders/${r.id}`)}
        exportName={t('sd.orders')}
        empty={<EmptyState icon={<ClipboardList size={22} />} title={t('common.noResults')} text={t('sd.ordersSub')} />}
      />
    </div>
  );
}

function SoView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: o, isLoading, error } = useApi<any>(`/sales/orders/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !o) return <ErrorBlock message={errText(error)} />;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) => act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  /** Confirming can hit the customer's credit limit: someone allowed to override is asked, everybody else is told. */
  const approve = () =>
    act.mutate(() => api.post(`/sales/orders/${o.id}/confirm`, {}), {
      onSuccess: () => toast.success(t('common.saved')),
      onError: async (x) => {
        if (x instanceof ApiError && x.code === 'sales.credit_limit' && can('sales.orders.override')) {
          if ((await confirm({ title: t('sd.creditOver'), body: x.message, confirmLabel: t('sd.approveAnyway') })).ok) run(() => api.post(`/sales/orders/${o.id}/confirm`, { override: true }), t('common.saved'));
        } else toast.error(errText(x));
      },
    });
  const open = o.status === 'confirmed' || o.status === 'partially_delivered';
  const toDeliver = o.lines.some((l: any) => l.open_qty > 0 && l.item_kind !== 'service');
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/sales/orders', label: t('sd.orders') }]}
        title={o.number}
        badge={<SoStatus status={o.status} />}
        subtitle={[o.customer.name, date(o.order_date, 'long'), o.currency, o.customer_reference].filter(Boolean).join(' · ')}
        actions={
          <>
            <Button icon={<Printer />} onClick={() => window.print()}>{t('common.print')}</Button>
            {o.status === 'draft' && can('sales.orders.write') && (
              <>
                <Button variant="danger" icon={<Trash2 />} onClick={async () => { if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok) run(() => api.del(`/sales/orders/${o.id}`), t('common.deleted'), () => navigate('/sales/orders')); }}>
                  {t('common.delete')}
                </Button>
                <Link to={`/sales/orders/${o.id}/edit`} className="btn"><Pencil /> {t('common.edit')}</Link>
              </>
            )}
            {o.status === 'draft' && can('sales.orders.approve') && <Button variant="primary" loading={act.isPending} onClick={approve}>{t('sd.confirmOrder')}</Button>}
            {(o.status === 'draft' || o.status === 'confirmed') && can('sales.orders.write') && !o.deliveries.length && (
              <Button variant="danger" icon={<Ban />} onClick={() => run(() => api.post(`/sales/orders/${o.id}/cancel`), t('common.saved'))}>{t('sd.cancelOrder')}</Button>
            )}
            {open && can('sales.orders.write') && <Button icon={<Lock />} onClick={() => run(() => api.post(`/sales/orders/${o.id}/close`), t('common.saved'))}>{t('sd.closeOrder')}</Button>}
            {open && toDeliver && can('sales.deliveries.write') && (
              <Button variant="primary" icon={<Truck />} loading={act.isPending} onClick={() => act.mutate(() => api.post<{ id: number }>('/sales/deliveries', { soId: o.id, date: todayIso(), post: can('sales.deliveries.post') }), { onSuccess: (r) => { toast.success(t('sd.deliveredAll')); navigate('/sales/deliveries/' + (r as { id: number }).id); }, onError: (x) => toast.error(errText(x)) })}>{t('sd.deliverAll')}</Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {o.credit && (
          <Card pad>
            <div className="grid-4">
              <div><div className="label">{t('sd.creditLimit')}</div><Money v={o.credit.limit} /></div>
              <div><div className="label">{t('sd.creditBalance')}</div><Money v={o.credit.balance} /></div>
              <div><div className="label">{t('sd.creditOpen')}</div><Money v={o.credit.open} /></div>
              <div><div className="label">{t('sd.creditThis')}</div><Money v={o.credit.order} tone /></div>
            </div>
          </Card>
        )}
        <Card className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink">#</th>
                  <th>{t('common.description')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('sd.reserved')}</th>
                  <th className="end">{t('sd.delivered')}</th>
                  <th className="end">{t('sd.invoiced')}</th>
                  <th className="end">{t('sd.open')}</th>
                  <th className="end">{t('docs.price')}</th>
                  <th>{t('sd.requested')}</th>
                  <th className="end">{t('docs.lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>{pick(l.name_en, l.name_ar)} <span className="faint" style={{ fontSize: 12, marginInline: 8 }}>{l.sku}</span></td>
                    <td className="end nowrap"><Qty v={l.quantity} unit={l.base_unit} /></td>
                    <td className="end"><Qty v={l.reserved_qty} /></td>
                    <td className={`end ${l.delivered_qty >= l.quantity ? 'success-text' : ''}`}><Qty v={l.delivered_qty} /></td>
                    <td className={`end ${l.invoiced_qty >= l.quantity ? 'success-text' : ''}`}><Qty v={l.invoiced_qty} /></td>
                    <td className="end"><Qty v={l.open_qty} /></td>
                    <td className="end"><Money v={l.unit_price} /></td>
                    <td className="nowrap muted">{l.promised_date ? `${date(l.promised_date)} ✓` : l.requested_date ? date(l.requested_date) : '—'}</td>
                    <td className="end"><Money v={l.total} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={9}>{t('common.total')}{o.currency ? ` (${o.currency})` : ''}</td><td className="end"><Money v={o.total} /></td></tr>
              </tfoot>
            </table>
          </div>
        </Card>
        {(o.deliveries.length > 0 || o.invoices.length > 0) && (
          <div className="grid-2">
            <Card>
              <CardHeader title={t('sd.deliveries')} icon={<PackageCheck size={18} className="muted" />} />
              <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                {o.deliveries.map((d: any) => (
                  <Link key={d.id} to={`/sales/deliveries/${d.id}`} className="row">
                    <span style={{ fontWeight: 550 }}>{d.number ?? t('status.draft')}</span>
                    <span className="muted">{date(d.date)}</span>
                    <span className="spacer" />
                    <Badge tone={DL_TONE[d.status] ?? 'neutral'}>{t('status.' + d.status)}</Badge>
                  </Link>
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title={t('nav.invoices')} icon={<ClipboardList size={18} className="muted" />} />
              <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                {o.invoices.map((d: any) => (
                  <Link key={d.id} to={`/sales/invoices/${d.id}`} className="row">
                    <span style={{ fontWeight: 550 }}>{d.number ?? t('status.draft')}</span>
                    <span className="muted">{date(d.date)}</span>
                    <span className="spacer" />
                    <Money v={d.total} />
                    <Badge tone={d.status === 'posted' ? 'green' : d.status === 'void' ? 'red' : 'neutral'}>{t('status.' + d.status)}</Badge>
                  </Link>
                ))}
              </div>
            </Card>
          </div>
        )}
        {o.notes && <Card pad><div className="label">{t('common.notes')}</div><p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{o.notes}</p></Card>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- deliveries
function DeliveryList() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Paged<any>>('/sales/deliveries', { limit: 20000 });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number ?? t('status.draft')}</span> },
      { id: 'order', header: t('sd.order'), nowrap: true, value: (r) => r.so_number, render: (r) => <Link to={`/sales/orders/${r.so_id}`} onClick={(e) => e.stopPropagation()}>{r.so_number}</Link> },
      { id: 'customer', header: t('docs.customer'), type: 'enum', value: (r) => r.customer_name },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      { id: 'qty', header: t('docs.qty'), type: 'qty', total: true, value: (r) => r.qty, render: (r) => <Qty v={r.qty} /> },
      { id: 'billed', header: t('sd.invoiced'), type: 'number', value: (r) => (r.qty ? Math.round((r.invoiced_qty / r.qty) * 100) : 0), format: (v) => `${v}%`, render: (r) => <Progress ratio={r.qty ? r.invoiced_qty / r.qty : 0} /> },
      { id: 'cost', header: t('sd.cost'), type: 'money', total: true, hidden: true, value: (r) => r.cost, render: (r) => <Money v={r.cost} /> },
      { id: 'reference', header: t('common.reference'), hidden: true, value: (r) => r.reference },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('status.' + v), render: (r) => <Badge tone={DL_TONE[r.status] ?? 'neutral'}>{t('status.' + r.status)}</Badge> },
    ],
    [t],
  );
  const presets = useMemo<Preset<any>[]>(
    () => [
      { id: 'toInvoice', label: t('sd.toInvoice'), test: (r: any) => r.status === 'posted' && r.invoiced_qty < r.qty },
      ...['draft', 'posted', 'void'].map((k) => ({ id: k, label: t('status.' + k), test: (r: any) => r.status === k })),
    ],
    [t],
  );
  return (
    <div className="page">
      <PageHeader title={t('sd.deliveries')} subtitle={t('sd.deliveriesSub')} />
      <DataGrid
        id="sales-deliveries"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/sales/deliveries/${r.id}`)}
        exportName={t('sd.deliveries')}
        empty={<EmptyState icon={<Truck size={22} />} title={t('common.noResults')} text={t('sd.deliveriesSub')} />}
      />
    </div>
  );
}

function DeliveryView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const errText = useErrorText();
  const { data: d, isLoading, error } = useApi<any>(`/sales/deliveries/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !d) return <ErrorBlock message={errText(error)} />;
  const run = (fn: () => Promise<unknown>, msg: string) => act.mutate(fn, { onSuccess: () => toast.success(msg), onError: (x) => toast.error(errText(x)) });
  const unbilled = d.status === 'posted' && d.lines.some((l: any) => l.invoiced_qty < l.qty);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/sales/deliveries', label: t('sd.deliveries') }]}
        title={d.number ?? `${t('sd.delivery')} · ${t('status.draft')}`}
        badge={<Badge tone={DL_TONE[d.status] ?? 'neutral'}>{t('status.' + d.status)}</Badge>}
        subtitle={[d.customer.name, date(d.date, 'long'), d.reference].filter(Boolean).join(' · ')}
        actions={
          <>
            <Link to={`/sales/orders/${d.so_id}`} className="btn"><ClipboardList /> {d.so_number}</Link>
            {d.status === 'draft' && can('sales.deliveries.post') && <Button variant="primary" loading={act.isPending} onClick={() => run(() => api.post(`/sales/deliveries/${d.id}/post`), t('common.saved'))}>{t('sd.postDelivery')}</Button>}
            {d.status === 'posted' && can('sales.deliveries.post') && (
              <Button variant="danger" icon={<Ban />} onClick={async () => { if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('sd.voidDelivery') })).ok) run(() => api.post(`/sales/deliveries/${d.id}/void`, {}), t('common.saved')); }}>{t('sd.voidDelivery')}</Button>
            )}
            {unbilled && can('ar.invoices.write') && (
              <Button variant="primary" loading={act.isPending} onClick={() => run(() => api.post('/sales/invoices/from-deliveries', { deliveryIds: [d.id], date: todayIso() }), t('sd.invoiceMade'))}>{t('sd.makeInvoice')}</Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink">#</th>
                  <th>{t('common.description')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('sd.ordered')}</th>
                  <th>{t('sd.lots')}</th>
                  <th>{t('inventory.warehouse')}</th>
                  <th className="end">{t('sd.invoiced')}</th>
                  <th className="end">{t('sd.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>{pick(l.name_en, l.name_ar)} <span className="faint" style={{ fontSize: 12, marginInline: 8 }}>{l.sku}</span></td>
                    <td className="end nowrap"><Qty v={l.qty} unit={l.base_unit} /></td>
                    <td className="end"><Qty v={l.ordered_qty} /></td>
                    <td>{(l.lots ?? []).map((x: any) => <Badge key={x.lotNo} tone="cyan">{x.lotNo}</Badge>)}</td>
                    <td className="muted">{l.warehouse_code ?? '—'}</td>
                    <td className={`end ${l.invoiced_qty >= l.qty ? 'success-text' : ''}`}><Qty v={l.invoiced_qty} /></td>
                    <td className="end"><Money v={l.cost} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="grid-2">
          <Card>
            <CardHeader title={t('nav.invoices')} icon={<ClipboardList size={18} className="muted" />} />
            <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
              {d.invoices.length === 0 && <span className="faint">{t('sd.noInvoices')}</span>}
              {d.invoices.map((x: any) => (
                <Link key={x.id} to={`/sales/invoices/${x.id}`} className="row">
                  <span style={{ fontWeight: 550 }}>{x.number ?? t('status.draft')}</span>
                  <span className="muted">{date(x.date)}</span>
                  <span className="spacer" />
                  <Badge tone={x.status === 'posted' ? 'green' : 'neutral'}>{t('status.' + x.status)}</Badge>
                </Link>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title={t('sd.books')} icon={<CheckCircle2 size={18} className="muted" />} />
            <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
              {d.journal_entry_id ? <Link to={`/journal/${d.journal_entry_id}`}>{d.journal_number}</Link> : <span className="faint">{t('sd.notBooked')}</span>}
              {d.void_entry_id && <Link to={`/journal/${d.void_entry_id}`}>{d.void_journal_number}</Link>}
              {d.external_ref && <span className="faint">{d.external_ref}</span>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- reports
function RangeFields({ from, to, setFrom, setTo }: { from: string; to: string; setFrom(v: string): void; setTo(v: string): void }) {
  const { t } = useI18n();
  return (
    <div className="row" style={{ gap: 8 }}>
      <Field label={t('common.from')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label={t('common.to')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
    </div>
  );
}

/** Delivery performance per order line: on time (OTD), on time and in full (OTIF) and fill rate, against the promised and the requested date. */
function OtifPage() {
  const { t } = useI18n();
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [groupBy, setGroupBy] = useState('customer');
  const { data, isLoading } = useApi<any>('/sales/reports/otif', { from, to, groupBy });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'label', header: t('sd.group.' + groupBy), pinned: true, value: (r) => r.label },
      { id: 'lines', header: t('sd.lines'), type: 'number', total: true, value: (r) => r.lines },
      { id: 'otd', header: t('sd.otdPromised'), type: 'number', value: (r) => (r.otd_promised_bp ?? 0) / 100, render: (r) => <Badge tone={tone(r.otd_promised_bp)}>{pct(r.otd_promised_bp)}</Badge> },
      { id: 'otdReq', header: t('sd.otdRequested'), type: 'number', hidden: true, value: (r) => (r.otd_requested_bp ?? 0) / 100, render: (r) => <Badge tone={tone(r.otd_requested_bp)}>{pct(r.otd_requested_bp)}</Badge> },
      { id: 'otif', header: t('sd.otifPromised'), type: 'number', value: (r) => (r.otif_promised_bp ?? 0) / 100, render: (r) => <Badge tone={tone(r.otif_promised_bp)}>{pct(r.otif_promised_bp)}</Badge> },
      { id: 'fill', header: t('sd.fillRate'), type: 'number', value: (r) => (r.fill_rate_bp ?? 0) / 100, render: (r) => <Badge tone={tone(r.fill_rate_bp)}>{pct(r.fill_rate_bp)}</Badge> },
      { id: 'ordered', header: t('sd.ordered'), type: 'qty', total: true, value: (r) => r.ordered, render: (r) => <Qty v={r.ordered} /> },
      { id: 'delivered', header: t('sd.delivered'), type: 'qty', total: true, value: (r) => r.delivered, render: (r) => <Qty v={r.delivered} /> },
    ],
    [t, groupBy],
  );
  const t0 = data?.totals;
  return (
    <div className="page">
      <PageHeader
        title={t('sd.rep.otifTitle')}
        subtitle={t('sd.rep.otifSub')}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Field label={t('sd.groupBy')}>
              <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {['customer', 'item', 'month'].map((g) => <option key={g} value={g}>{t('sd.group.' + g)}</option>)}
              </Select>
            </Field>
            <RangeFields from={from} to={to} setFrom={setFrom} setTo={setTo} />
          </div>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {t0 && (
          <Card pad>
            <div className="grid-4">
              <div><div className="label">{t('sd.otdPromised')}</div><Badge tone={tone(t0.otd_promised_bp)}>{pct(t0.otd_promised_bp)}</Badge></div>
              <div><div className="label">{t('sd.otifPromised')}</div><Badge tone={tone(t0.otif_promised_bp)}>{pct(t0.otif_promised_bp)}</Badge></div>
              <div><div className="label">{t('sd.fillRate')}</div><Badge tone={tone(t0.fill_rate_bp)}>{pct(t0.fill_rate_bp)}</Badge></div>
              <div><div className="label">{t('sd.lines')}</div><span className="num">{t0.lines}</span></div>
            </div>
          </Card>
        )}
        <DataGrid id="rep-otif" rows={data?.rows} loading={isLoading} columns={columns} rowKey={(r) => String(r.key)} exportName={t('sd.rep.otifTitle')} />
      </div>
    </div>
  );
}

/** What customers have ordered and not yet received: open quantity and value, and how much of it is already late. */
function BacklogPage() {
  const { t } = useI18n();
  const [groupBy, setGroupBy] = useState('customer');
  const { data, isLoading } = useApi<any>('/sales/reports/backlog', { groupBy });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'label', header: t('sd.group.' + groupBy), pinned: true, value: (r) => r.label },
      { id: 'lines', header: t('sd.lines'), type: 'number', total: true, value: (r) => r.lines },
      { id: 'open', header: t('sd.open'), type: 'qty', total: true, value: (r) => r.open_qty, render: (r) => <Qty v={r.open_qty} /> },
      { id: 'reserved', header: t('sd.reserved'), type: 'qty', total: true, value: (r) => r.reserved_qty, render: (r) => <Qty v={r.reserved_qty} /> },
      { id: 'value', header: t('sd.openValue'), type: 'money', total: true, value: (r) => r.open_value, render: (r) => <Money v={r.open_value} /> },
      { id: 'late', header: t('sd.lateQty'), type: 'qty', total: true, value: (r) => r.late_qty, render: (r) => <span className={r.late_qty ? 'danger-text' : 'faint'}><Qty v={r.late_qty} /></span> },
      { id: 'lateValue', header: t('sd.lateValue'), type: 'money', total: true, value: (r) => r.late_value, render: (r) => <Money v={r.late_value} /> },
    ],
    [t, groupBy],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('sd.rep.backlogTitle')}
        subtitle={t('sd.rep.backlogSub')}
        actions={<Field label={t('sd.groupBy')}><Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{['customer', 'item'].map((g) => <option key={g} value={g}>{t('sd.group.' + g)}</option>)}</Select></Field>}
      />
      <DataGrid id="rep-backlog" rows={data?.rows} loading={isLoading} columns={columns} rowKey={(r) => String(r.key)} exportName={t('sd.rep.backlogTitle')} />
    </div>
  );
}

/** Revenue, cost and margin from posted invoices, by customer, item or month. */
function SalesAnalysisPage() {
  const { t } = useI18n();
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [groupBy, setGroupBy] = useState('customer');
  const { data, isLoading } = useApi<any>('/sales/reports/sales', { from, to, groupBy });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'label', header: t('sd.group.' + groupBy), pinned: true, value: (r) => r.label },
      { id: 'qty', header: t('docs.qty'), type: 'qty', total: true, value: (r) => r.qty, render: (r) => <Qty v={r.qty} /> },
      { id: 'revenue', header: t('sd.revenue'), type: 'money', total: true, value: (r) => r.revenue, render: (r) => <Money v={r.revenue} /> },
      { id: 'cost', header: t('sd.cost'), type: 'money', total: true, value: (r) => r.cost, render: (r) => <Money v={r.cost} /> },
      { id: 'margin', header: t('sd.margin'), type: 'money', total: true, value: (r) => r.margin, render: (r) => <Money v={r.margin} tone /> },
      { id: 'marginPct', header: t('sd.marginPct'), type: 'number', value: (r) => (r.margin_bp ?? 0) / 100, render: (r) => <span className="num">{pct(r.margin_bp)}</span> },
    ],
    [t, groupBy],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('sd.rep.salesTitle')}
        subtitle={t('sd.rep.salesSub')}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Field label={t('sd.groupBy')}><Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{['customer', 'item', 'month'].map((g) => <option key={g} value={g}>{t('sd.group.' + g)}</option>)}</Select></Field>
            <RangeFields from={from} to={to} setFrom={setFrom} setTo={setTo} />
          </div>
        }
      />
      <DataGrid id="rep-sales" rows={data?.rows} loading={isLoading} columns={columns} rowKey={(r) => String(r.key)} exportName={t('sd.rep.salesTitle')} />
    </div>
  );
}

export const salesModule: WebModule = {
  id: 'sales',
  nav: [
    { to: '/sales/orders', label: 'sd.orders', icon: ClipboardList, section: 'ar', order: 5, perm: 'sales.orders.read', app: 'sd' },
    { to: '/sales/deliveries', label: 'sd.deliveries', icon: Truck, section: 'ar', order: 7, perm: 'sales.deliveries.read', app: 'sd' },
  ],
  reports: [
    { to: '/reports/sales/otif', group: 'sd.reportsGroup', title: 'sd.rep.otifTitle', desc: 'sd.rep.otifSub', icon: Target, color: 'var(--line-teal)', perm: 'sales.reports.read', app: 'sd' },
    { to: '/reports/sales/backlog', group: 'sd.reportsGroup', title: 'sd.rep.backlogTitle', desc: 'sd.rep.backlogSub', icon: Hourglass, color: 'var(--line-amber)', perm: 'sales.reports.read', app: 'sd' },
    { to: '/reports/sales/analysis', group: 'sd.reportsGroup', title: 'sd.rep.salesTitle', desc: 'sd.rep.salesSub', icon: BarChart3, color: 'var(--line-pink)', perm: 'sales.reports.read', app: 'sd' },
  ],
  routes: [
    { path: '/sales/orders', element: <SoList />, perm: 'sales.orders.read', app: 'sd' },
    { path: '/sales/orders/new', element: <SoEditor key="new" />, perm: 'sales.orders.write', app: 'sd' },
    { path: '/sales/orders/:id', element: <SoView />, perm: 'sales.orders.read', app: 'sd' },
    { path: '/sales/orders/:id/edit', element: <SoEditor key="edit" />, perm: 'sales.orders.write', app: 'sd' },
    { path: '/sales/deliveries', element: <DeliveryList />, perm: 'sales.deliveries.read', app: 'sd' },
    { path: '/sales/deliveries/:id', element: <DeliveryView />, perm: 'sales.deliveries.read', app: 'sd' },
    { path: '/reports/sales/otif', element: <OtifPage />, perm: 'sales.reports.read', app: 'sd' },
    { path: '/reports/sales/backlog', element: <BacklogPage />, perm: 'sales.reports.read', app: 'sd' },
    { path: '/reports/sales/analysis', element: <SalesAnalysisPage />, perm: 'sales.reports.read', app: 'sd' },
  ],
  commands: [
    { id: 'new-so', label: 'sd.newOrder', icon: Plus, group: 'create', to: '/sales/orders/new', perm: 'sales.orders.write', app: 'sd', keywords: 'sales order أمر بيع' },
    { id: 'go-so', label: 'sd.orders', icon: ClipboardList, group: 'navigate', to: '/sales/orders', perm: 'sales.orders.read', app: 'sd', keywords: 'sales orders أوامر بيع طلبات عملاء' },
    { id: 'go-dlv', label: 'sd.deliveries', icon: Truck, group: 'navigate', to: '/sales/deliveries', perm: 'sales.deliveries.read', app: 'sd', keywords: 'deliveries shipments تسليمات شحن' },
  ],
};
