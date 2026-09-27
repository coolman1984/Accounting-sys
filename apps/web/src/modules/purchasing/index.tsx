import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, ClipboardList, FilePlus, Lock, LockOpen, Pencil, PackageCheck, Plus, Printer, ShoppingCart, Trash2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatBp } from '../../core/format';
import type { Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { Qty } from '../inventory/common';
import { PoEditor } from './PoEditor';

const TONE: Record<string, Tone> = { draft: 'neutral', open: 'blue', closed: 'green', cancelled: 'red' };

export function PoStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={TONE[status] ?? 'neutral'}>{t('adv.poStatus.' + status)}</Badge>;
}

function Progress({ ratio }: { ratio: number | null }) {
  const pct = Math.round(Math.min(1, ratio ?? 0) * 100);
  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      <span style={{ width: 54, height: 6, borderRadius: 3, background: 'var(--bg-muted)', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--success)' : 'var(--primary)' }} />
      </span>
      <span className="num faint" style={{ minWidth: 34, fontSize: 12 }}>
        {pct}%
      </span>
    </span>
  );
}

function PoList() {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Paged<any>>('/purchase-orders', { limit: 20000 });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number ?? <span className="faint">{t('status.draft')}</span>}</span> },
      { id: 'supplier', header: t('docs.supplier'), type: 'enum', value: (r) => r.supplier_name },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      { id: 'expected', header: t('adv.expectedDate'), type: 'date', nowrap: true, value: (r) => r.expected_date },
      { id: 'reference', header: t('common.reference'), hidden: true, value: (r) => r.reference },
      { id: 'received', header: t('adv.received'), type: 'number', value: (r) => Math.round((r.received_ratio ?? 0) * 100), format: (v) => `${v}%`, render: (r) => <Progress ratio={r.received_ratio} /> },
      { id: 'billed', header: t('adv.billed'), type: 'number', value: (r) => Math.round((r.billed_ratio ?? 0) * 100), format: (v) => `${v}%`, render: (r) => <Progress ratio={r.billed_ratio} /> },
      { id: 'total', header: t('common.total'), type: 'money', total: true, value: (r) => (r.status === 'cancelled' ? 0 : r.total), render: (r) => <Money v={r.total} /> },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('adv.poStatus.' + v), render: (r) => <PoStatus status={r.status} /> },
    ],
    [t],
  );
  const presets = useMemo<Preset<any>[]>(
    () => ['draft', 'open', 'closed', 'cancelled'].map((k) => ({ id: k, label: t('adv.poStatus.' + k), test: (r: any) => r.status === k })),
    [t],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('adv.purchaseOrders')}
        subtitle={t('adv.poSubtitle')}
        actions={
          can('purchasing.write') && (
            <Link to="/purchasing/orders/new" className="btn btn-primary">
              <Plus /> {t('adv.newPo')}
            </Link>
          )
        }
      />
      <DataGrid
        id="purchase-orders"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/purchasing/orders/${r.id}`)}
        exportName={t('adv.purchaseOrders')}
        empty={<EmptyState icon={<ShoppingCart size={22} />} title={t('common.noResults')} text={t('adv.poSubtitle')} />}
      />
    </div>
  );
}

function PoView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: o, isLoading, error } = useApi<any>(`/purchase-orders/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !o) return <ErrorBlock message={errText(error)} />;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  const toReceive = o.lines.some((l: any) => l.item_id && l.to_receive > 0);
  const toBill = o.lines.some((l: any) => l.to_bill > 0);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/purchasing/orders', label: t('adv.purchaseOrders') }]}
        title={o.number ?? `${t('adv.purchaseOrder')} · ${t('status.draft')}`}
        badge={<PoStatus status={o.status} />}
        subtitle={`${o.supplier.name} · ${date(o.date, 'long')}`}
        actions={
          <>
            <Button icon={<Printer />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
            {o.status === 'draft' && can('purchasing.write') && (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(() => api.del(`/purchase-orders/${o.id}`), t('common.deleted'), () => navigate('/purchasing/orders'));
                  }}
                >
                  {t('common.delete')}
                </Button>
                <Link to={`/purchasing/orders/${o.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {o.status === 'draft' && can('purchasing.approve') && (
              <Button variant="primary" loading={act.isPending} onClick={() => run(() => api.post(`/purchase-orders/${o.id}/approve`), t('common.saved'))}>
                {t('adv.approve')}
              </Button>
            )}
            {(o.status === 'draft' || o.status === 'open') && can('purchasing.write') && !o.lines.some((l: any) => l.received_base || l.billed_base) && (
              <Button variant="danger" icon={<Ban />} onClick={() => run(() => api.post(`/purchase-orders/${o.id}/cancel`), t('common.saved'))}>
                {t('adv.cancelOrder')}
              </Button>
            )}
            {o.status === 'open' && can('purchasing.write') && (
              <Button icon={<Lock />} onClick={() => run(() => api.post(`/purchase-orders/${o.id}/close`), t('common.saved'))}>
                {t('adv.closeOrder')}
              </Button>
            )}
            {o.status === 'closed' && can('purchasing.write') && (
              <Button icon={<LockOpen />} onClick={() => run(() => api.post(`/purchase-orders/${o.id}/reopen`), t('common.saved'))}>
                {t('adv.reopenOrder')}
              </Button>
            )}
            {o.status === 'open' && toBill && can('purchases.write') && (
              <Link to={`/purchases/bills/new?fromPo=${o.id}`} className="btn">
                <FilePlus /> {t('adv.createBill')}
              </Link>
            )}
            {o.status === 'open' && toReceive && can('inventory.write') && (
              <Link to={`/inventory/receipts/new?po=${o.id}`} className="btn btn-primary">
                <PackageCheck /> {t('adv.receiveGoods')}
              </Link>
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
                  <th className="end">{t('docs.price')}</th>
                  <th className="end">{t('docs.discount')}</th>
                  <th className="end">{t('adv.received')}</th>
                  <th className="end">{t('adv.billed')}</th>
                  <th className="end">{t('docs.lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>
                      {l.description}
                      {l.sku && <span className="faint" style={{ fontSize: 12, marginInline: 8 }}>{l.sku}</span>}
                    </td>
                    <td className="end nowrap">
                      <Qty v={l.quantity} unit={l.unit_id ? pick(l.unit_name_en, l.unit_name_ar) : l.base_unit} />
                    </td>
                    <td className="end">
                      <Money v={l.unit_price} />
                    </td>
                    <td className="end muted">{l.discount_bp ? formatBp(l.discount_bp) : '—'}</td>
                    <td className={`end ${l.received_base >= l.base_quantity ? 'success-text' : ''}`}>
                      <Qty v={l.received_base} />
                    </td>
                    <td className={`end ${l.billed_base >= l.base_quantity ? 'success-text' : ''}`}>
                      <Qty v={l.billed_base} />
                    </td>
                    <td className="end">
                      <Money v={l.total} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={o.total} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
        {(o.receipts.length > 0 || o.bills.length > 0) && (
          <div className="grid-2">
            <Card>
              <CardHeader title={t('adv.receipts')} icon={<PackageCheck size={18} className="muted" />} />
              <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                {o.receipts.map((r: any) => (
                  <Link key={r.id} to={`/inventory/receipts/${r.id}`} className="row">
                    <span style={{ fontWeight: 550 }}>{r.number ?? t('status.draft')}</span>
                    <span className="muted">{date(r.date)}</span>
                    <span className="spacer" />
                    <Badge tone={r.status === 'posted' ? 'green' : r.status === 'void' ? 'red' : 'neutral'}>{t('status.' + r.status)}</Badge>
                  </Link>
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title={t('nav.bills')} icon={<FilePlus size={18} className="muted" />} />
              <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                {o.bills.map((b: any) => (
                  <Link key={b.id} to={`/purchases/bills/${b.id}`} className="row">
                    <span style={{ fontWeight: 550 }}>{b.number ?? t('status.draft')}</span>
                    <span className="muted">{date(b.date)}</span>
                    <span className="spacer" />
                    <Badge tone={b.status === 'posted' ? 'green' : b.status === 'void' ? 'red' : 'neutral'}>{t('status.' + b.status)}</Badge>
                  </Link>
                ))}
              </div>
            </Card>
          </div>
        )}
        {o.notes && (
          <Card pad>
            <div className="label">{t('common.notes')}</div>
            <p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{o.notes}</p>
          </Card>
        )}
      </div>
    </div>
  );
}

export const purchasingModule: WebModule = {
  id: 'purchasing',
  nav: [{ to: '/purchasing/orders', label: 'nav.purchaseOrders', icon: ClipboardList, section: 'purchases', order: 5, perm: 'purchasing.read', app: 'purchasing' }],
  routes: [
    { path: '/purchasing/orders', element: <PoList /> },
    { path: '/purchasing/orders/new', element: <PoEditor key="new" /> },
    { path: '/purchasing/orders/:id', element: <PoView /> },
    { path: '/purchasing/orders/:id/edit', element: <PoEditor key="edit" /> },
  ],
  commands: [
    { id: 'new-po', label: 'adv.newPo', icon: ShoppingCart, group: 'create', to: '/purchasing/orders/new', perm: 'purchasing.write', app: 'purchasing', keywords: 'purchase order po أمر شراء' },
    { id: 'go-po', label: 'nav.purchaseOrders', icon: ClipboardList, group: 'navigate', to: '/purchasing/orders', perm: 'purchasing.read', app: 'purchasing', keywords: 'أوامر شراء' },
  ],
};
