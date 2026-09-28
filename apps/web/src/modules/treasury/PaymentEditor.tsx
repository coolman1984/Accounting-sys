import { useCallback, useEffect, useMemo, useState } from 'react';
import { CurrencyRateFields, RATE_ONE, toBase, useCurrencies } from '../../ui/Currency';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, Wand2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { Switch } from '../../ui/Switch';
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
  currency: string;
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
  currency: string | null;
  exchange_rate: number;
  wht_type: WhtType | null;
  wht_base: number;
  wht_amount: number;
  method: string | null;
  reference: string | null;
  memo: string | null;
  allocations: { document_id: number; amount: number }[];
}

const METHODS = ['cash', 'bank_transfer', 'cheque', 'card', 'other'];
type WhtType = 'supplies' | 'contracting' | 'services' | 'commissions';
const WHT_TYPES: WhtType[] = ['supplies', 'contracting', 'services', 'commissions'];
interface WhtSuggestion {
  type: WhtType;
  rateBp: number;
  base: number;
  amount: number;
  belowMinimum: boolean;
  minBase: number;
}

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
  const { base: baseCur } = useCurrencies();
  const [fx, setFx] = useState<{ currency: string; rate: number }>({ currency: '', rate: RATE_ONE });
  const currency = fx.currency || baseCur;
  const foreign = !!currency && currency !== baseCur;
  const preDoc = params.get('doc') ? Number(params.get('doc')) : null;
  // Egypt withholding (خصم وإضافة): suggested from the party's type and the invoices' value before VAT.
  const { hasApp } = useSession();
  const whtOn = hasApp('tax') && mode === 'party' && !foreign;
  const { data: whtSettings } = useApi<{ agent: boolean; minBase: number; rates: Record<WhtType, number> }>(hasApp('tax') ? '/tax/withholding' : null);
  const [wht, setWht] = useState<{ on: boolean; type: WhtType; base: number | null; touched: boolean }>({ on: false, type: 'supplies', base: null, touched: false });
  const [suggestion, setSuggestion] = useState<WhtSuggestion | null>(null);
  const whtAmount = whtOn && wht.on && wht.base && whtSettings ? Math.round((wht.base * whtSettings.rates[wht.type]) / 10000) : 0;

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
    setFx({ currency: existing.currency ?? '', rate: existing.exchange_rate });
    if (existing.wht_amount > 0) setWht({ on: true, type: existing.wht_type ?? 'supplies', base: existing.wht_base, touched: true });
  }, [existing]);

  const { data: cashAccounts } = useApi<{ id: number; subtype: string; currency: string | null }[]>('/payments/accounts');
  // A foreign-currency account decides the currency.
  const accountCurrency = cashAccounts?.find((a) => a.id === accountId)?.currency ?? null;
  useEffect(() => {
    if (accountCurrency && accountCurrency !== currency) setFx({ currency: accountCurrency, rate: fx.rate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountCurrency]);
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
  // Only documents in the payment's currency can be settled by it.
  const docs = (openDocs ?? []).filter((d) => d.currency === currency);
  const otherCurrencies = [...new Set((openDocs ?? []).filter((d) => d.currency !== currency).map((d) => d.currency))];

  // Arriving from a document's "Record payment": apply its full outstanding amount.
  useEffect(() => {
    if (!preDoc || editing || !openDocs) return;
    const d = openDocs.find((x) => x.id === preDoc);
    if (d && alloc[d.id] === undefined) {
      if (d.currency !== currency) setFx({ currency: d.currency, rate: fx.rate });
      setAlloc({ [d.id]: d.outstanding });
      setAmount((a) => a ?? d.outstanding);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDocs, preDoc, editing]);

  const allocated = useMemo(() => Object.values(alloc).reduce<number>((s, v) => s + (v ?? 0), 0), [alloc]);
  // The party is settled by the cash plus the tax withheld.
  const unallocated = (amount ?? 0) + whtAmount - allocated;
  const allocList = useMemo(
    () =>
      Object.entries(alloc)
        .filter(([, v]) => v && v > 0)
        .map(([documentId, v]) => ({ documentId: Number(documentId), amount: v as number })),
    [alloc],
  );
  const allocKey = JSON.stringify(allocList);
  useEffect(() => {
    if (!whtOn || !partyId) return setSuggestion(null);
    let live = true;
    api
      .post<WhtSuggestion | null>('/payments/withholding', { partyId, direction, allocations: allocList })
      .then((s) => live && setSuggestion(s))
      .catch(() => live && setSuggestion(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whtOn, partyId, direction, allocKey]);
  // Until the user changes it, the withholding follows the suggestion, and the cash is what is left to pay.
  useEffect(() => {
    if (!suggestion || wht.touched) return;
    setWht({ on: suggestion.amount > 0, type: suggestion.type, base: suggestion.base, touched: false });
    if (suggestion.amount > 0 && allocated > 0 && (amount == null || amount === allocated)) setAmount(allocated - suggestion.amount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion]);

  const autoAllocate = () => {
    let left = amount != null ? amount + whtAmount : docs.reduce((s, d) => s + d.outstanding, 0);
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
      currency,
      exchangeRate: foreign ? fx.rate : null,
      withholding: whtAmount > 0 ? { type: wht.type, base: wht.base } : null,
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
              <Field label={foreign ? `${t('common.amount')} (${currency})` : t('common.amount')} hint={foreign && amount ? `${t('fx.inBase', { base: baseCur })}: ${fmt(toBase(amount, fx.rate))}` : undefined}>
                <DecimalInput scale={scale} value={amount} onChange={setAmount} />
              </Field>
              <CurrencyRateFields currency={currency} rate={fx.rate} date={payDate} onChange={setFx} locked={!!accountCurrency} />
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
            {otherCurrencies.length > 0 && (
              <div className="card-body faint" style={{ fontSize: 12.5, paddingBottom: 0 }}>
                {t('fx.otherCurrencies', { list: otherCurrencies.join(', ') })}
              </div>
            )}
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

        {whtOn && partyId && (
          <Card>
            <CardHeader
              title={direction === 'in' ? t('wht.byCustomerTitle') : t('wht.fromSupplierTitle')}
              sub={direction === 'in' ? t('wht.byCustomerHint') : t('wht.fromSupplierHint')}
              actions={<Switch checked={wht.on} onChange={(v) => setWht({ ...wht, on: v, touched: true })} label={t('wht.apply')} />}
            />
            <div className="card-body stack">
              {suggestion && !suggestion.belowMinimum && suggestion.amount > 0 && (
                <div className="faint" style={{ fontSize: 13 }}>
                  {t('wht.suggested', { type: t('wht.types.' + suggestion.type), rate: suggestion.rateBp / 100, base: fmt(suggestion.base), amount: fmt(suggestion.amount) })}
                </div>
              )}
              {suggestion?.belowMinimum && <div className="faint" style={{ fontSize: 13 }}>{t('wht.belowMinimum', { min: fmt(suggestion.minBase) })}</div>}
              {!suggestion && partyId && <div className="faint" style={{ fontSize: 13 }}>{t('wht.noType')}</div>}
              {wht.on && (
                <div className="grid-3">
                  <Field label={t('wht.type')}>
                    <Select value={wht.type} onChange={(e) => setWht({ ...wht, type: e.target.value as WhtType, touched: true })}>
                      {WHT_TYPES.map((k) => (
                        <option key={k} value={k}>
                          {t('wht.types.' + k)} — {(whtSettings?.rates[k] ?? 0) / 100}%
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('wht.base')} hint={t('wht.baseHint')}>
                    <DecimalInput scale={scale} value={wht.base} onChange={(v) => setWht({ ...wht, base: v, touched: true })} />
                  </Field>
                  <Field label={t('wht.amount')} hint={allocated > 0 ? t('wht.cashHint', { cash: fmt(Math.max(0, allocated - whtAmount)) }) : undefined}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong className="num" style={{ fontSize: 16 }}>{fmt(whtAmount)}</strong>
                      {allocated > 0 && amount !== allocated - whtAmount && (
                        <Button size="sm" onClick={() => setAmount(allocated - whtAmount)}>
                          {t('wht.payRest')}
                        </Button>
                      )}
                    </div>
                  </Field>
                </div>
              )}
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
