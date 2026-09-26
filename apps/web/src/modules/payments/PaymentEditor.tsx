import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, Wand2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { api } from '../../core/api';
import { todayIso } from '../../core/format';
import type { Direction } from '../../core/types';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { DecimalInput, Field, Input, Select } from '../../ui/Field';
import { AccountPicker, PartyPicker } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';

interface OpenDoc {
  id: number;
  kind: string;
  number: string;
  date: string;
  due_date: string;
  total: number;
  amount_settled: number;
  outstanding: number;
}

interface PaymentFull {
  id: number;
  direction: Direction;
  date: string;
  party_id: number | null;
  party_role: 'customer' | 'supplier' | null;
  account_id: number;
  counter_account_id: number | null;
  amount: number;
  method: string | null;
  reference: string | null;
  memo: string | null;
  allocations: { document_id: number; amount: number }[];
}

const METHODS = ['cash', 'bank_transfer', 'cheque', 'card', 'other'];

export function PaymentEditor({ direction }: { direction: Direction }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const editing = id != null;
  const base = direction === 'in' ? '/receipts' : '/payments';
  const { t } = useI18n();
  const date = useDate();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { data: existing, isLoading } = useApi<PaymentFull>(editing ? `/payments/${id}` : null);

  const [mode, setMode] = useState<'party' | 'direct'>('party');
  const [role, setRole] = useState<'customer' | 'supplier'>(
    (params.get('role') as 'customer' | 'supplier') ?? (direction === 'in' ? 'customer' : 'supplier'),
  );
  const [partyId, setPartyId] = useState<number | null>(params.get('party') ? Number(params.get('party')) : null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [counterId, setCounterId] = useState<number | null>(null);
  const [payDate, setPayDate] = useState(todayIso());
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [alloc, setAlloc] = useState<Record<number, number | null>>({});
  const [err, setErr] = useState('');
  const preDoc = params.get('doc') ? Number(params.get('doc')) : null;

  useEffect(() => {
    if (!existing) return;
    setMode(existing.party_id ? 'party' : 'direct');
    if (existing.party_role) setRole(existing.party_role);
    setPartyId(existing.party_id);
    setAccountId(existing.account_id);
    setCounterId(existing.counter_account_id);
    setPayDate(existing.date);
    setAmount(existing.amount);
    setMethod(existing.method ?? 'other');
    setReference(existing.reference ?? '');
    setMemo(existing.memo ?? '');
    setAlloc(Object.fromEntries(existing.allocations.map((a) => [a.document_id, a.amount])));
  }, [existing]);

  const { data: cashAccounts } = useApi<{ id: number; subtype: string }[]>('/payments/accounts');
  useEffect(() => {
    if (!editing && accountId == null && cashAccounts?.length) {
      const pref = cashAccounts.find((a) => a.subtype === (method === 'cash' ? 'cash' : 'bank')) ?? cashAccounts[0];
      setAccountId(pref.id);
    }
  }, [cashAccounts, editing, accountId, method]);

  const { data: openDocs } = useApi<OpenDoc[]>(mode === 'party' && partyId ? '/payments/open-documents' : null, {
    partyId: partyId ?? undefined,
    direction,
    role,
  });

  // Documents this (draft) payment already holds allocations for stay visible when editing.
  const docs = openDocs ?? [];

  // Arriving from a document's "Record payment": apply its full outstanding amount.
  useEffect(() => {
    if (!preDoc || editing || !openDocs) return;
    const d = openDocs.find((x) => x.id === preDoc);
    if (d && alloc[d.id] === undefined) {
      setAlloc({ [d.id]: d.outstanding });
      setAmount((a) => a ?? d.outstanding);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDocs, preDoc, editing]);

  const allocated = useMemo(() => Object.values(alloc).reduce<number>((s, v) => s + (v ?? 0), 0), [alloc]);
  const unallocated = (amount ?? 0) - allocated;

  const autoAllocate = () => {
    let left = amount ?? docs.reduce((s, d) => s + d.outstanding, 0);
    if (amount == null) setAmount(left);
    const next: Record<number, number | null> = {};
    for (const d of [...docs].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
      const take = Math.min(left, d.outstanding);
      next[d.id] = take > 0 ? take : null;
      left -= Math.max(take, 0);
    }
    setAlloc(next);
  };

  const save = useApiMutation((post: boolean) => {
    const body = {
      direction,
      date: payDate,
      partyId: mode === 'party' ? partyId : null,
      partyRole: mode === 'party' ? role : null,
      accountId,
      counterAccountId: mode === 'direct' ? counterId : null,
      amount: amount ?? 0,
      method,
      reference: reference || null,
      memo: memo || null,
      allocations:
        mode === 'party'
          ? Object.entries(alloc)
              .filter(([, v]) => v && v > 0)
              .map(([documentId, v]) => ({ documentId: Number(documentId), amount: v }))
          : [],
      post,
    };
    return editing ? api.put<{ id: number }>(`/payments/${id}`, body) : api.post<{ id: number }>('/payments', body);
  });

  const submit = useCallback(
    (post: boolean) => {
      setErr('');
      save.mutate(post, {
        onSuccess: (r) => {
          toast.success(post ? t('common.posted') : t('common.saved'));
          navigate(`${base}/${r.id}`);
        },
        onError: (e) => setErr(errText(e)),
      });
    },
    [save, toast, t, navigate, base, errText],
  );

  if (editing && isLoading) return <Loading />;

  const ready = !!accountId && (amount ?? 0) > 0 && (mode === 'party' ? !!partyId : !!counterId);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: base, label: t(`payments.${direction}.title`) }]}
        title={editing ? `${t('common.edit')} · ${t(`payments.${direction}.one`)}` : t(`payments.${direction}.new`)}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!ready}>
              {t('common.saveDraft')}
            </Button>
            <Button variant="primary" onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!ready || unallocated < 0}>
              {t('common.saveAndPost')}
            </Button>
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="stack">
            <div className="row wrap" style={{ gap: 16 }}>
              <div className="field">
                <label>{t('payments.mode')}</label>
                <div className="segmented">
                  <button aria-pressed={mode === 'party'} onClick={() => setMode('party')}>
                    {t('payments.modeParty')}
                  </button>
                  <button aria-pressed={mode === 'direct'} onClick={() => setMode('direct')}>
                    {t('payments.modeDirect')}
                  </button>
                </div>
              </div>
              {mode === 'party' && (
                <div className="field">
                  <label>{t('payments.role')}</label>
                  <div className="segmented">
                    {(['customer', 'supplier'] as const).map((r) => (
                      <button
                        key={r}
                        aria-pressed={role === r}
                        onClick={() => {
                          setRole(r);
                          setPartyId(null);
                          setAlloc({});
                        }}
                      >
                        {t(r === 'customer' ? 'payments.roleCustomer' : 'payments.roleSupplier')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="grid-3">
              {mode === 'party' ? (
                <Field label={direction === 'in' ? t('payments.receivedFrom') : t('payments.paidTo')}>
                  <PartyPicker
                    kind={role}
                    value={partyId}
                    onChange={(pid) => {
                      setPartyId(pid);
                      setAlloc({});
                    }}
                  />
                </Field>
              ) : (
                <Field label={t('payments.counterAccount')}>
                  <AccountPicker
                    value={counterId}
                    onChange={setCounterId}
                    filter={(a) => !['receivable', 'payable', 'cash', 'bank'].includes(a.subtype)}
                  />
                </Field>
              )}
              <Field label={t('payments.cashAccount')}>
                <AccountPicker value={accountId} onChange={setAccountId} filter={(a) => a.subtype === 'cash' || a.subtype === 'bank'} />
              </Field>
              <Field label={t('common.amount')}>
                <DecimalInput scale={scale} value={amount} onChange={setAmount} />
              </Field>
              <Field label={t('common.date')}>
                <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </Field>
              <Field label={t('payments.method')}>
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t('payments.methods.' + m)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('common.reference')}>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
            </div>
            <Field label={t('common.memo')}>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
        </Card>

        {mode === 'party' && partyId && (
          <Card>
            <CardHeader
              title={t('payments.allocate')}
              sub={t('payments.allocateHint')}
              actions={
                docs.length > 0 && (
                  <Button size="sm" icon={<Wand2 />} onClick={autoAllocate}>
                    {t('payments.autoAllocate')}
                  </Button>
                )
              }
            />
            {docs.length === 0 ? (
              <div className="card-body muted">{t('payments.noOpen')}</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.number')}</th>
                      <th>{t('common.date')}</th>
                      <th>{t('common.dueDate')}</th>
                      <th className="end">{t('common.total')}</th>
                      <th className="end">{t('payments.outstanding')}</th>
                      <th className="end" style={{ width: 160 }}>
                        {t('payments.applyAmount')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d) => (
                      <tr key={d.id}>
                        <td style={{ fontWeight: 550 }}>{d.number}</td>
                        <td>{date(d.date)}</td>
                        <td className={d.due_date < todayIso() ? 'danger-text' : ''}>{date(d.due_date)}</td>
                        <td className="end num">{fmt(d.total)}</td>
                        <td className="end num">{fmt(d.outstanding)}</td>
                        <td>
                          <DecimalInput
                            sm
                            scale={scale}
                            value={alloc[d.id] ?? null}
                            onChange={(v) => setAlloc((a) => ({ ...a, [d.id]: v == null ? null : Math.min(v, d.outstanding) }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="balance-bar">
              <span className="muted">
                {t('payments.allocated')} <span className="amount">{fmt(allocated)}</span>
              </span>
              <span className="spacer" />
              <span className={unallocated < 0 ? 'danger-text' : 'muted'}>
                {t('payments.unallocated')} <span className="amount">{fmt(unallocated)}</span>
              </span>
            </div>
          </Card>
        )}

        {err && (
          <div className="notice danger">
            <AlertTriangle />
            <div>{err}</div>
          </div>
        )}
      </div>
    </div>
  );
}
