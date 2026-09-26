import { Link, useNavigate, useParams } from 'react-router';
import { ArrowRight, Ban, BookOpen, Pencil, Printer, Send, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import type { Account, Warehouse } from '../../core/types';
import { PageHeader, Loading, ErrorBlock } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { Qty } from './common';
import type { OpKind } from './OperationEditor';

interface OpView {
  id: number;
  kind: OpKind;
  number: string | null;
  date: string;
  status: 'draft' | 'posted' | 'void';
  reference: string | null;
  memo: string | null;
  warehouse: Warehouse;
  to_warehouse: Warehouse | null;
  counter_account: Account | null;
  journal_entry_id: number | null;
  journal_number: string | null;
  void_entry_id: number | null;
  void_journal_number: string | null;
  lines: { id: number; line_no: number; item_id: number; sku: string; name_en: string; name_ar: string; unit: string | null; qty: number; unit_cost: number | null; system_qty: number | null; note: string | null; value: number }[];
}

export function OperationView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: d, isLoading, error } = useApi<OpView>(`/inventory/operations/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !d) return <ErrorBlock message={errText(error)} />;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  const total = d.lines.reduce((s, l) => s + l.value, 0);
  const posted = d.status !== 'draft';

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory/operations', label: t('inventory.operations') }]}
        title={d.number ?? `${t('inventory.kinds.' + d.kind)} · ${t('status.draft')}`}
        badge={<SimpleStatus status={d.status} />}
        subtitle={`${t('inventory.kinds.' + d.kind)} · ${date(d.date, 'long')}`}
        actions={
          <>
            <Button icon={<Printer />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
            {d.status === 'draft' && can('inventory.write') && (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('common.areYouSure'), body: t('common.cannotUndo'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(() => api.del(`/inventory/operations/${d.id}`), t('common.deleted'), () => navigate('/inventory/operations'));
                  }}
                >
                  {t('common.delete')}
                </Button>
                <Link to={`/inventory/operations/${d.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {d.status === 'draft' && can('inventory.post') && (
              <Button variant="primary" icon={<Send className="flip-rtl" />} loading={act.isPending} onClick={() => run(() => api.post(`/inventory/operations/${d.id}/post`), t('common.posted'))}>
                {t('common.post')}
              </Button>
            )}
            {d.status === 'posted' && can('inventory.post') && (
              <Button
                variant="danger"
                icon={<Ban />}
                loading={act.isPending}
                onClick={async () => {
                  const r = await confirm({ title: t('inventory.voidTitle'), body: t('inventory.voidText'), danger: true, confirmLabel: t('common.void'), withDate: { label: t('common.date'), value: d.date } });
                  if (r.ok) run(() => api.post(`/inventory/operations/${d.id}/void`, { date: r.date || null }), t('common.voided'));
                }}
              >
                {t('common.void')}
              </Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <dl className="dl">
            <dt>{d.kind === 'transfer' ? t('inventory.fromWarehouse') : t('inventory.warehouse')}</dt>
            <dd className="row" style={{ gap: 8 }}>
              {d.warehouse.code} · {pick(d.warehouse.name_en, d.warehouse.name_ar)}
              {d.to_warehouse && (
                <>
                  <ArrowRight size={15} className="flip-rtl muted" />
                  {d.to_warehouse.code} · {pick(d.to_warehouse.name_en, d.to_warehouse.name_ar)}
                </>
              )}
            </dd>
            {d.counter_account && (
              <>
                <dt>{t('inventory.counterAccount')}</dt>
                <dd>
                  {d.counter_account.code} · {pick(d.counter_account.name_en, d.counter_account.name_ar)}
                </dd>
              </>
            )}
            <dt>{t('common.reference')}</dt>
            <dd>{d.reference || '—'}</dd>
            <dt>{t('common.memo')}</dt>
            <dd>{d.memo || '—'}</dd>
          </dl>
        </Card>
        <Card className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink">#</th>
                  <th>{t('docs.item')}</th>
                  {d.kind === 'count' && <th className="end">{t('inventory.system')}</th>}
                  <th className="end">{d.kind === 'count' ? t('inventory.counted') : t('docs.qty')}</th>
                  {d.kind === 'count' && <th className="end">{t('inventory.difference')}</th>}
                  {posted && <th className="end">{t('inventory.value')}</th>}
                  <th>{t('common.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>
                      <Link to={`/inventory/items/${l.item_id}`}>
                        <span className="num faint" style={{ marginInlineEnd: 8 }}>
                          {l.sku}
                        </span>
                        {pick(l.name_en, l.name_ar)}
                      </Link>
                    </td>
                    {d.kind === 'count' && <td className="end muted">{l.system_qty != null ? <Qty v={l.system_qty} /> : '—'}</td>}
                    <td className="end" style={{ fontWeight: 600 }}>
                      <Qty v={l.qty} unit={l.unit} signed={d.kind === 'adjustment'} />
                    </td>
                    {d.kind === 'count' && (
                      <td className="end">{l.system_qty != null ? <Qty v={l.qty - l.system_qty} signed tone /> : '—'}</td>
                    )}
                    {posted && (
                      <td className="end">
                        <Money v={l.value} dashZero />
                      </td>
                    )}
                    <td className="muted">{l.note}</td>
                  </tr>
                ))}
              </tbody>
              {posted && d.kind !== 'transfer' && (
                <tfoot>
                  <tr>
                    <td colSpan={d.kind === 'count' ? 5 : 3}>{t('common.total')}</td>
                    <td className="end">
                      <Money v={total} />
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
        {(d.journal_entry_id || d.void_entry_id) && (
          <Card>
            <CardHeader title={t('common.journalEntry')} icon={<BookOpen size={18} className="muted" />} />
            <div className="card-body row" style={{ gap: 16 }}>
              {d.journal_entry_id && <Link to={`/journal/${d.journal_entry_id}`}>{d.journal_number}</Link>}
              {d.void_entry_id && (
                <Link to={`/journal/${d.void_entry_id}`} className="danger-text">
                  {t('status.void')}: {d.void_journal_number}
                </Link>
              )}
              {d.kind === 'transfer' && !d.journal_entry_id && <Badge plain>{t('inventory.kindHints.transfer')}</Badge>}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
