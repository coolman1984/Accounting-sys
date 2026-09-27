import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowDownLeft, ArrowUpRight, BadgeCheck, CalendarRange, Landmark, Plus, Save, Undo2, XCircle } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate, todayIso } from '../../core/format';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker, PartyPicker } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';

type Direction = 'received' | 'issued';
type Status = 'in_hand' | 'deposited' | 'cleared' | 'bounced' | 'returned' | 'issued' | 'cancelled';
interface Cheque {
  id: number;
  direction: Direction;
  number: string;
  cheque_no: string;
  bank_name: string | null;
  party_id: number;
  party_name: string;
  amount: number;
  date: string;
  due_date: string;
  status: Status;
  bank_account_id: number | null;
  memo: string | null;
  reason: string | null;
  deposited_date: string | null;
  cleared_date: string | null;
  cancelled_date: string | null;
}
interface ChequeFull extends Cheque {
  allocations: { document_id: number; amount: number; number: string; date: string; total: number }[];
  bank_code: string | null;
  bank_name_en: string | null;
  bank_name_ar: string | null;
  entry_id: number | null;
  clear_entry_id: number | null;
  cancel_entry_id: number | null;
  entry_number: string | null;
  clear_number: string | null;
  cancel_number: string | null;
}

const TONE: Record<Status, Tone> = { in_hand: 'blue', deposited: 'cyan', cleared: 'green', bounced: 'red', returned: 'neutral', issued: 'amber', cancelled: 'neutral' };
const OPEN: Status[] = ['in_hand', 'deposited', 'issued'];

// ------------------------------------------------------------------ lists

function ChequesPage({ direction }: { direction: Direction }) {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const { data, isLoading } = useApi<Cheque[]>('/cheques', { direction, status: open ? 'open' : undefined });
  const today = todayIso();
  const columns = useMemo<Column<Cheque>[]>(
    () => [
      { id: 'due', header: t('chq.dueDate'), pinned: true, type: 'date', value: (c) => c.due_date, render: (c) => <span className={OPEN.includes(c.status) && c.due_date < today ? 'danger-text' : undefined}>{formatDate(c.due_date, locale)}</span> },
      { id: 'no', header: t('chq.chequeNo'), value: (c) => c.cheque_no, render: (c) => <strong className="num">{c.cheque_no}</strong> },
      { id: 'party', header: direction === 'received' ? t('chq.customer') : t('chq.supplier'), value: (c) => c.party_name },
      { id: 'bank', header: t('chq.bank'), value: (c) => c.bank_name },
      { id: 'amount', header: t('common.amount'), type: 'number', value: (c) => c.amount, render: (c) => <strong className="num">{fmt(c.amount)}</strong> },
      { id: 'date', header: t('chq.received_' + direction), type: 'date', value: (c) => c.date, render: (c) => formatDate(c.date, locale) },
      { id: 'number', header: t('common.number'), value: (c) => c.number, render: (c) => <span className="num faint">{c.number}</span> },
      { id: 'status', header: t('common.status'), type: 'enum', value: (c) => c.status, format: (v) => t('chq.status.' + v), render: (c) => <Badge tone={TONE[c.status]}>{t('chq.status.' + c.status)}</Badge> },
    ],
    [t, fmt, locale, direction, today],
  );
  const total = (data ?? []).filter((c) => OPEN.includes(c.status)).reduce((s, c) => s + c.amount, 0);
  return (
    <div className="page">
      <PageHeader
        title={t('chq.title_' + direction)}
        subtitle={t('chq.sub_' + direction)}
        actions={
          <>
            <Link to="/cheques/portfolio" className="btn">
              <CalendarRange /> {t('chq.portfolio')}
            </Link>
            {can(`cheques.${direction}.write`) && (
              <Link to={`/cheques/new?direction=${direction}`} className="btn btn-primary">
                <Plus /> {t('chq.new_' + direction)}
              </Link>
            )}
          </>
        }
      />
      <div className="row" style={{ gap: 12, marginBottom: 12 }}>
        <div className="segmented">
          <button aria-pressed={open} onClick={() => setOpen(true)}>
            {t('chq.openOnly')}
          </button>
          <button aria-pressed={!open} onClick={() => setOpen(false)}>
            {t('common.all')}
          </button>
        </div>
        {total > 0 && (
          <span className="faint">
            {t('chq.openTotal')}: <strong className="num">{fmt(total)}</strong>
          </span>
        )}
      </div>
      <DataGrid
        id={`cheques-${direction}`}
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(c) => c.id}
        onRowClick={(c) => navigate(`/cheques/${c.id}`)}
        exportName={t('chq.title_' + direction)}
        empty={<EmptyState icon={direction === 'received' ? <ArrowDownLeft size={22} /> : <ArrowUpRight size={22} />} title={t('chq.none')} text={t('chq.noneText_' + direction)} />}
      />
    </div>
  );
}

// ------------------------------------------------------------------ editor

function ChequeEditor() {
  const [params] = useSearchParams();
  const direction: Direction = params.get('direction') === 'issued' ? 'issued' : 'received';
  const { t, locale } = useI18n();
  const { fmt, scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const navigate = useNavigate();
  const [f, setF] = useState({ partyId: null as number | null, chequeNo: '', bankName: '', amount: null as number | null, date: todayIso(), dueDate: todayIso(), bankAccountId: null as number | null, memo: '' });
  const [alloc, setAlloc] = useState<Record<number, number | null>>({});
  const { data: docs } = useApi<{ id: number; number: string; date: string; due_date: string; total: number; outstanding: number }[]>(f.partyId ? '/cheques/open-documents' : null, { partyId: f.partyId ?? undefined, direction });
  useEffect(() => setAlloc({}), [f.partyId]);
  const allocated = Object.values(alloc).reduce<number>((s, v) => s + (v ?? 0), 0);
  const autoAllocate = () => {
    let left = f.amount ?? 0;
    const next: Record<number, number | null> = {};
    for (const d of docs ?? []) {
      if (left <= 0) break;
      const take = Math.min(left, d.outstanding);
      next[d.id] = take;
      left -= take;
    }
    setAlloc(next);
  };
  const save = useApiMutation(() =>
    api.post<{ id: number }>('/cheques', {
      direction,
      chequeNo: f.chequeNo,
      bankName: f.bankName || null,
      partyId: f.partyId,
      amount: f.amount ?? 0,
      date: f.date,
      dueDate: f.dueDate,
      bankAccountId: f.bankAccountId,
      memo: f.memo || null,
      allocations: Object.entries(alloc)
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([k, v]) => ({ documentId: Number(k), amount: v })),
    }),
  );
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: `/cheques/${direction}`, label: t('chq.title_' + direction) }]}
        title={t('chq.new_' + direction)}
        actions={
          <Button variant="primary" icon={<Save />} loading={save.isPending} disabled={!f.partyId || !f.amount || !f.chequeNo || allocated > (f.amount ?? 0)} onClick={() => save.mutate(undefined, { onSuccess: (r) => (toast.success(t('chq.recorded')), navigate(`/cheques/${r.id}`, { replace: true })), onError: (e) => toast.error(errText(e)) })}>
            {t('common.save')}
          </Button>
        }
      />
      <Card pad>
        <div className="stack">
          <div className="grid-3">
            <Field label={direction === 'received' ? t('chq.customer') : t('chq.supplier')}>
              <PartyPicker kind={direction === 'received' ? 'customer' : 'supplier'} value={f.partyId} autoFocus onChange={(v) => setF({ ...f, partyId: v })} />
            </Field>
            <Field label={t('chq.chequeNo')}>
              <Input value={f.chequeNo} onChange={(e) => setF({ ...f, chequeNo: e.target.value })} />
            </Field>
            <Field label={t('common.amount')}>
              <DecimalInput scale={scale} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
            </Field>
          </div>
          <div className="grid-3">
            <Field label={t('chq.received_' + direction)}>
              <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value, dueDate: f.dueDate < e.target.value ? e.target.value : f.dueDate })} />
            </Field>
            <Field label={t('chq.dueDate')} hint={t('chq.dueDateHint')}>
              <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            </Field>
            {direction === 'received' ? (
              <Field label={t('chq.drawnOnBank')}>
                <Input value={f.bankName} placeholder={t('chq.bankNameHint')} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
              </Field>
            ) : (
              <Field label={t('chq.fromAccount')}>
                <AccountPicker value={f.bankAccountId} filter={(a) => a.subtype === 'bank' && !a.currency} onChange={(v) => setF({ ...f, bankAccountId: v })} />
              </Field>
            )}
          </div>
          <Field label={t('common.memo')}>
            <Textarea rows={2} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
          </Field>
        </div>
      </Card>
      {f.partyId && (
        <Card>
          <CardHeader
            title={t(direction === 'received' ? 'chq.settleInvoices' : 'chq.settleBills')}
            sub={t('chq.allocated', { amount: fmt(allocated), of: fmt(f.amount ?? 0) })}
            actions={
              (docs?.length ?? 0) > 0 && (
                <Button size="sm" onClick={autoAllocate} disabled={!f.amount}>
                  {t('chq.autoAllocate')}
                </Button>
              )
            }
          />
          {!docs?.length ? (
            <EmptyState title={t('chq.noOpenDocs')} text={t('chq.onAccount')} />
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('common.number')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.dueDate')}</th>
                  <th className="end">{t('chq.outstanding')}</th>
                  <th className="end">{t('chq.apply')}</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="num">{d.number}</td>
                    <td>{formatDate(d.date, locale)}</td>
                    <td>{formatDate(d.due_date, locale)}</td>
                    <td className="end num">{fmt(d.outstanding)}</td>
                    <td style={{ width: 160 }}>
                      <DecimalInput sm scale={scale} value={alloc[d.id] ?? null} onChange={(v) => setAlloc({ ...alloc, [d.id]: v != null ? Math.min(v, d.outstanding) : null })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {allocated > (f.amount ?? 0) && <p className="danger-text" style={{ padding: '0 16px 12px' }}>{t('chq.overAllocated')}</p>}
        </Card>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- view

function ActionDialog({ c, action, onClose }: { c: ChequeFull; action: 'deposit' | 'clear' | 'cancel' | null; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState({ date: todayIso(), bankAccountId: c.bank_account_id, outcome: (c.direction === 'issued' ? 'cancelled' : 'bounced') as 'bounced' | 'returned' | 'cancelled', reason: '' });
  useEffect(() => {
    if (action) setF((x) => ({ ...x, date: todayIso(), bankAccountId: c.bank_account_id }));
  }, [action, c.bank_account_id]);
  const save = useApiMutation(() =>
    action === 'deposit'
      ? api.post(`/cheques/${c.id}/deposit`, { date: f.date, bankAccountId: f.bankAccountId })
      : action === 'clear'
        ? api.post(`/cheques/${c.id}/clear`, { date: f.date, bankAccountId: f.bankAccountId })
        : api.post(`/cheques/${c.id}/cancel`, { date: f.date, outcome: f.outcome, reason: f.reason || null }),
  );
  const needsBank = action === 'deposit' || (action === 'clear' && !c.bank_account_id);
  return (
    <Dialog
      open={!!action}
      onClose={onClose}
      title={action ? t('chq.actions.' + (action === 'cancel' ? (c.direction === 'issued' ? 'cancel' : 'bounce') : action)) : ''}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={action === 'cancel' ? 'danger' : 'primary'} disabled={needsBank && !f.bankAccountId} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => toast.error(errText(e)) })}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {action === 'cancel' && <p className="faint" style={{ margin: 0 }}>{t(c.direction === 'issued' ? 'chq.cancelHint' : 'chq.bounceHint')}</p>}
        {action === 'clear' && <p className="faint" style={{ margin: 0 }}>{t(c.direction === 'issued' ? 'chq.clearHintIssued' : 'chq.clearHint')}</p>}
        <div className="grid-2">
          <Field label={t('common.date')}>
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          {(action === 'deposit' || action === 'clear') && (
            <Field label={t('chq.bankAccount')}>
              <AccountPicker value={f.bankAccountId} filter={(a) => a.subtype === 'bank' && !a.currency} onChange={(v) => setF({ ...f, bankAccountId: v })} />
            </Field>
          )}
          {action === 'cancel' && c.direction === 'received' && (
            <Field label={t('chq.outcome')}>
              <Select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value as 'bounced' | 'returned' })}>
                <option value="bounced">{t('chq.status.bounced')}</option>
                <option value="returned">{t('chq.status.returned')}</option>
              </Select>
            </Field>
          )}
        </div>
        {action === 'cancel' && (
          <Field label={t('chq.reason')}>
            <Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function ChequeView() {
  const { id } = useParams();
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const { data: c, isLoading } = useApi<ChequeFull>(`/cheques/${id}`);
  const [action, setAction] = useState<'deposit' | 'clear' | 'cancel' | null>(null);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading || !c) return <Loading />;
  const writable = can(`cheques.${c.direction}.write`);
  const steps: { label: string; date: string | null; entry?: [number | null, string | null] }[] =
    c.direction === 'received'
      ? [
          { label: t('chq.steps.received'), date: c.date, entry: [c.entry_id, c.entry_number] },
          { label: t('chq.steps.deposited'), date: c.deposited_date },
          c.status === 'bounced' || c.status === 'returned'
            ? { label: t('chq.status.' + c.status), date: c.cancelled_date, entry: [c.cancel_entry_id, c.cancel_number] }
            : { label: t('chq.steps.cleared'), date: c.cleared_date, entry: [c.clear_entry_id, c.clear_number] },
        ]
      : [
          { label: t('chq.steps.issued'), date: c.date, entry: [c.entry_id, c.entry_number] },
          c.status === 'cancelled' ? { label: t('chq.status.cancelled'), date: c.cancelled_date, entry: [c.cancel_entry_id, c.cancel_number] } : { label: t('chq.steps.cleared'), date: c.cleared_date, entry: [c.clear_entry_id, c.clear_number] },
        ];
  const overdue = OPEN.includes(c.status) && c.due_date < todayIso();
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: `/cheques/${c.direction}`, label: t('chq.title_' + c.direction) }]}
        title={`${t('chq.cheque')} ${c.cheque_no}`}
        badge={<Badge tone={TONE[c.status]}>{t('chq.status.' + c.status)}</Badge>}
        subtitle={`${c.number} · ${c.party_name}`}
        actions={
          writable && (
            <>
              {c.status === 'in_hand' && (
                <Button icon={<Landmark />} onClick={() => setAction('deposit')}>
                  {t('chq.actions.deposit')}
                </Button>
              )}
              {OPEN.includes(c.status) && (
                <Button variant="ghost" icon={<XCircle />} onClick={() => setAction('cancel')}>
                  {t(c.direction === 'issued' ? 'chq.actions.cancel' : 'chq.actions.bounce')}
                </Button>
              )}
              {OPEN.includes(c.status) && (
                <Button variant="primary" icon={<BadgeCheck />} onClick={() => setAction('clear')}>
                  {t('chq.actions.clear')}
                </Button>
              )}
              {c.status === 'cleared' && (
                <Button icon={<Undo2 />} onClick={() => act.mutate(() => api.post(`/cheques/${c.id}/unclear`), { onSuccess: () => toast.success(t('common.saved')), onError: (e) => toast.error(errText(e)) })}>
                  {t('chq.actions.unclear')}
                </Button>
              )}
            </>
          )
        }
      />
      <div className="kpi-strip">
        <div>
          <span>{t('common.amount')}</span>
          <strong>{fmt(c.amount)}</strong>
        </div>
        <div>
          <span>{t('chq.dueDate')}</span>
          <strong className={overdue ? 'danger-text' : undefined}>{formatDate(c.due_date, locale)}</strong>
          {overdue && <small className="danger-text">{t('chq.pastDue')}</small>}
        </div>
        <div>
          <span>{t('chq.bank')}</span>
          <strong style={{ fontSize: 15 }}>{c.direction === 'received' ? c.bank_name ?? '—' : c.bank_code ? `${c.bank_code} · ${pick(c.bank_name_en ?? '', c.bank_name_ar ?? '')}` : '—'}</strong>
          {c.direction === 'received' && c.bank_code && <small className="faint">{t('chq.depositedIn', { bank: `${c.bank_code} · ${pick(c.bank_name_en ?? '', c.bank_name_ar ?? '')}` })}</small>}
        </div>
      </div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Card>
          <CardHeader title={t('chq.progress')} />
          <ol className="cheque-steps">
            {steps.map((s, i) => (
              <li key={i} className={s.date ? 'done' : ''}>
                <strong>{s.label}</strong>
                <span className="faint">{s.date ? formatDate(s.date, locale) : '—'}</span>
                {s.entry?.[0] && <Link to={`/journal/${s.entry[0]}`}>{s.entry[1]}</Link>}
              </li>
            ))}
          </ol>
          {c.reason && <p className="faint" style={{ padding: '0 16px 12px', margin: 0 }}>{c.reason}</p>}
        </Card>
        <Card>
          <CardHeader title={t(c.direction === 'received' ? 'chq.settleInvoices' : 'chq.settleBills')} />
          {c.allocations.length === 0 ? (
            <EmptyState title={t('chq.onAccountShort')} />
          ) : (
            <table className="table table-compact">
              <tbody>
                {c.allocations.map((a) => (
                  <tr key={a.document_id}>
                    <td>
                      <Link to={`/documents/${a.document_id}`} className="num">
                        {a.number}
                      </Link>
                    </td>
                    <td className="faint">{formatDate(a.date, locale)}</td>
                    <td className="end">
                      <Money v={a.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(c.status === 'bounced' || c.status === 'returned' || c.status === 'cancelled') && c.allocations.length > 0 && <p className="warning-text" style={{ padding: '0 16px 12px', margin: 0, fontSize: 12.5 }}>{t('chq.reopened')}</p>}
        </Card>
      </div>
      {c.memo && <p className="faint">{c.memo}</p>}
      <ActionDialog c={c} action={action} onClose={() => setAction(null)} />
    </div>
  );
}

// --------------------------------------------------------------- portfolio

function PortfolioPage() {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const { data: p } = useApi<{ received: Record<string, number>; issued: Record<string, number>; totals: { received: number; issued: number; bounced: number }; open: (Cheque & { bucket: string })[] }>('/cheques/portfolio');
  const buckets = ['overdue', 'week', 'month', 'quarter', 'later'];
  if (!p) return <Loading />;
  return (
    <div className="page">
      <PageHeader title={t('chq.portfolio')} subtitle={t('chq.portfolioSub')} />
      <div className="kpi-strip">
        <div>
          <span>{t('chq.toCollect')}</span>
          <strong className="success-text">{fmt(p.totals.received)}</strong>
        </div>
        <div>
          <span>{t('chq.toPay')}</span>
          <strong className="danger-text">{fmt(p.totals.issued)}</strong>
        </div>
        <div>
          <span>{t('chq.net')}</span>
          <strong>{fmt(p.totals.received - p.totals.issued)}</strong>
        </div>
        <div>
          <span>{t('chq.bouncedYear')}</span>
          <strong className={p.totals.bounced > 0 ? 'danger-text' : undefined}>{fmt(p.totals.bounced)}</strong>
        </div>
      </div>
      <Card>
        <CardHeader title={t('chq.maturity')} sub={t('chq.maturitySub')} />
        <table className="table">
          <thead>
            <tr>
              <th />
              {buckets.map((b) => (
                <th key={b} className="end">
                  {t('chq.buckets.' + b)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('chq.toCollect')}</td>
              {buckets.map((b) => (
                <td key={b} className={`end num ${b === 'overdue' && p.received[b] ? 'danger-text' : ''}`}>
                  {p.received[b] ? fmt(p.received[b]) : '—'}
                </td>
              ))}
            </tr>
            <tr>
              <td>{t('chq.toPay')}</td>
              {buckets.map((b) => (
                <td key={b} className={`end num ${b === 'overdue' && p.issued[b] ? 'danger-text' : ''}`}>
                  {p.issued[b] ? fmt(p.issued[b]) : '—'}
                </td>
              ))}
            </tr>
            <tr className="grand-row">
              <td>{t('chq.net')}</td>
              {buckets.map((b) => (
                <td key={b} className="end num">
                  {fmt((p.received[b] ?? 0) - (p.issued[b] ?? 0))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Card>
      <Card>
        <CardHeader title={t('chq.openCheques')} />
        {!p.open.length ? (
          <EmptyState icon={<CalendarRange size={22} />} title={t('chq.noneOpen')} />
        ) : (
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('chq.dueDate')}</th>
                <th>{t('chq.chequeNo')}</th>
                <th>{t('chq.party')}</th>
                <th>{t('common.status')}</th>
                <th className="end">{t('chq.in')}</th>
                <th className="end">{t('chq.out')}</th>
              </tr>
            </thead>
            <tbody>
              {p.open.map((c) => (
                <tr key={c.id}>
                  <td className={c.bucket === 'overdue' ? 'danger-text nowrap' : 'nowrap'}>{formatDate(c.due_date, locale)}</td>
                  <td>
                    <Link to={`/cheques/${c.id}`} className="num">
                      {c.cheque_no}
                    </Link>
                  </td>
                  <td>{c.party_name}</td>
                  <td>
                    <Badge plain tone={TONE[c.status]}>
                      {t('chq.status.' + c.status)}
                    </Badge>
                  </td>
                  <td className="end num success-text">{c.direction === 'received' ? fmt(c.amount) : ''}</td>
                  <td className="end num danger-text">{c.direction === 'issued' ? fmt(c.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export const chequesModule: WebModule = {
  id: 'cheques',
  nav: [
    { to: '/cheques/received', label: 'chq.title_received', icon: ArrowDownLeft, section: 'treasury', order: 40, perm: 'cheques.received.read', app: 'cheques' },
    { to: '/cheques/issued', label: 'chq.title_issued', icon: ArrowUpRight, section: 'treasury', order: 41, perm: 'cheques.issued.read', app: 'cheques' },
    { to: '/cheques/portfolio', label: 'chq.portfolio', icon: CalendarRange, section: 'treasury', order: 42, perm: 'cheques.received.read', app: 'cheques' },
  ],
  routes: [
    { path: '/cheques/received', element: <ChequesPage direction="received" /> },
    { path: '/cheques/issued', element: <ChequesPage direction="issued" /> },
    { path: '/cheques/portfolio', element: <PortfolioPage /> },
    { path: '/cheques/new', element: <ChequeEditor />, app: 'cheques' },
    { path: '/cheques/:id', element: <ChequeView />, app: 'cheques' },
  ],
  commands: [
    { id: 'go-cheques-received', label: 'chq.title_received', icon: ArrowDownLeft, group: 'navigate', to: '/cheques/received', perm: 'cheques.received.read', app: 'cheques', keywords: 'cheques received post-dated شيكات أوراق قبض' },
    { id: 'go-cheques-issued', label: 'chq.title_issued', icon: ArrowUpRight, group: 'navigate', to: '/cheques/issued', perm: 'cheques.issued.read', app: 'cheques', keywords: 'cheques issued شيكات أوراق دفع' },
  ],
};
