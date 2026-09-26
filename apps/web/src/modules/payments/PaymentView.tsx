import { Link, useNavigate, useParams } from 'react-router';
import { Ban, BookOpen, Pencil, Printer, Send, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { DOC_BASE } from '../../core/links';
import type { Account, DocKind, Direction, Party } from '../../core/types';
import { PageHeader, Loading, ErrorBlock } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';

interface PaymentDetail {
  id: number;
  direction: Direction;
  number: string | null;
  date: string;
  status: 'draft' | 'posted' | 'void';
  amount: number;
  method: string | null;
  reference: string | null;
  memo: string | null;
  party: Party | null;
  party_role: string | null;
  account: Account;
  counter_account: Account | null;
  journal_entry_id: number | null;
  journal_number: string | null;
  void_entry_id: number | null;
  void_journal_number: string | null;
  allocations: { document_id: number; amount: number; number: string; kind: DocKind; date: string; total: number }[];
}

export function PaymentView({ direction }: { direction: Direction }) {
  const { id } = useParams();
  const base = direction === 'in' ? '/receipts' : '/payments';
  const { t, pick } = useI18n();
  const date = useDate();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: p, isLoading, error } = useApi<PaymentDetail>(`/payments/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());

  if (isLoading) return <Loading />;
  if (error || !p) return <ErrorBlock message={errText(error)} />;

  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  const allocated = p.allocations.reduce((s, a) => s + a.amount, 0);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: base, label: t(`payments.${direction}.title`) }]}
        title={p.number ?? `${t(`payments.${direction}.one`)} · ${t('status.draft')}`}
        badge={<SimpleStatus status={p.status} />}
        subtitle={`${p.party?.name ?? pick(p.counter_account?.name_en, p.counter_account?.name_ar)} · ${date(p.date, 'long')}`}
        actions={
          <>
            <Button icon={<Printer />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
            {p.status === 'draft' && can('payments.write') && (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('common.areYouSure'), body: t('common.cannotUndo'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(() => api.del(`/payments/${p.id}`), t('common.deleted'), () => navigate(base));
                  }}
                >
                  {t('common.delete')}
                </Button>
                <Link to={`${base}/${p.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {p.status === 'draft' && can('payments.post') && (
              <Button variant="primary" icon={<Send className="flip-rtl" />} loading={act.isPending} onClick={() => run(() => api.post(`/payments/${p.id}/post`), t('common.posted'))}>
                {t('common.post')}
              </Button>
            )}
            {p.status === 'posted' && can('payments.post') && (
              <Button
                variant="danger"
                icon={<Ban />}
                loading={act.isPending}
                onClick={async () => {
                  const r = await confirm({ title: t('payments.voidTitle'), body: t('payments.voidText'), danger: true, confirmLabel: t('common.void'), withDate: { label: t('common.date'), value: p.date } });
                  if (r.ok) run(() => api.post(`/payments/${p.id}/void`, { date: r.date || null }), t('common.voided'));
                }}
              >
                {t('common.void')}
              </Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <div className="grid-2">
          <Card pad>
            <div className="label">{t('common.amount')}</div>
            <div className="kpi-value num" style={{ fontSize: 30, fontWeight: 700, margin: '4px 0 16px' }}>
              {fmt(p.amount)}
            </div>
            <dl className="dl">
              <dt>{direction === 'in' ? t('payments.receivedFrom') : t('payments.paidTo')}</dt>
              <dd>
                {p.party ? (
                  <Link to={`/${p.party_role === 'customer' ? 'customers' : 'suppliers'}/${p.party.id}`}>{p.party.name}</Link>
                ) : (
                  `${p.counter_account?.code} · ${pick(p.counter_account?.name_en, p.counter_account?.name_ar)}`
                )}
              </dd>
              <dt>{t('payments.cashAccount')}</dt>
              <dd>
                {p.account.code} · {pick(p.account.name_en, p.account.name_ar)}
              </dd>
              <dt>{t('payments.method')}</dt>
              <dd>{p.method ? t('payments.methods.' + p.method) : '—'}</dd>
              <dt>{t('common.reference')}</dt>
              <dd>{p.reference || '—'}</dd>
              <dt>{t('common.memo')}</dt>
              <dd>{p.memo || '—'}</dd>
            </dl>
          </Card>
          <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
            {p.party && (
              <Card>
                <CardHeader title={t('payments.allocate')} />
                <table className="table table-compact">
                  <tbody>
                    {p.allocations.map((a) => (
                      <tr key={a.document_id}>
                        <td>
                          <Link to={`${DOC_BASE[a.kind]}/${a.document_id}`}>{a.number}</Link>
                        </td>
                        <td className="muted">{date(a.date)}</td>
                        <td className="end">
                          <Money v={a.amount} />
                        </td>
                      </tr>
                    ))}
                    <tr className="total-row">
                      <td colSpan={2}>{t('payments.unallocated')}</td>
                      <td className="end">
                        <Money v={p.amount - allocated} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </Card>
            )}
            {p.journal_entry_id && (
              <Card>
                <CardHeader title={t('common.journalEntry')} icon={<BookOpen size={18} className="muted" />} />
                <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                  <Link to={`/journal/${p.journal_entry_id}`} style={{ fontWeight: 550 }}>
                    {p.journal_number}
                  </Link>
                  {p.void_entry_id && (
                    <Link to={`/journal/${p.void_entry_id}`} className="danger-text">
                      {t('status.void')}: {p.void_journal_number}
                    </Link>
                  )}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
