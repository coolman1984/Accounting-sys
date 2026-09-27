import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { todayIso } from '../../core/format';
import type { Paged } from '../../core/types';
import { PageHeader, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { DecimalInput, Field, Input, Select } from '../../ui/Field';
import { AccountPicker } from '../../ui/Pickers';
import { SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';

export interface CashAccount {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  subtype: 'cash' | 'bank';
  is_active: number;
  balance: number;
  currency: string | null;
  balance_fx: number;
}

interface TransferRow {
  id: number;
  number: string | null;
  date: string;
  from_account_id: number;
  to_account_id: number;
  from_code: string;
  from_name_en: string;
  from_name_ar: string;
  to_code: string;
  to_name_en: string;
  to_name_ar: string;
  amount: number;
  to_amount: number | null;
  fee: number;
  fee_account_id: number | null;
  reference: string | null;
  memo: string | null;
  status: 'draft' | 'posted' | 'void';
}

/** Cash and bank accounts — the only places money can be transferred between. */
export function CashAccountSelect({ value, onChange, list, exclude }: { value: number | null; onChange(id: number | null): void; list: CashAccount[]; exclude?: number | null }) {
  const { t, pick } = useI18n();
  const { fmt } = useMoney();
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {value == null && <option value="">{t('common.select')}</option>}
      {list
        .filter((a) => (a.is_active || a.id === value) && a.id !== exclude)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {pick(a.name_en, a.name_ar)} ({a.currency ? `${a.currency} ${fmt(a.balance_fx)}` : fmt(a.balance)})
          </option>
        ))}
    </Select>
  );
}

function TransferDialog({ open, row, onClose }: { open: boolean; row: TransferRow | null; onClose(): void }) {
  const { t } = useI18n();
  const { can, company } = useSession();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const { data: accounts } = useApi<CashAccount[]>('/bank/accounts');
  const empty = { date: todayIso(), fromAccountId: null as number | null, toAccountId: null as number | null, amount: null as number | null, toAmount: null as number | null, fee: null as number | null, feeAccountId: null as number | null, reference: '', memo: '' };
  const [f, setF] = useState(empty);
  const [err, setErr] = useState('');
  const base = company?.baseCurrency ?? '';
  const fromCur = accounts?.find((a) => a.id === f.fromAccountId)?.currency ?? null;
  const toCur = accounts?.find((a) => a.id === f.toAccountId)?.currency ?? null;
  const crossCurrency = !!f.fromAccountId && !!f.toAccountId && fromCur !== toCur;
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      row
        ? { date: row.date, fromAccountId: row.from_account_id, toAccountId: row.to_account_id, amount: row.amount, toAmount: row.to_amount, fee: row.fee || null, feeAccountId: row.fee_account_id, reference: row.reference ?? '', memo: row.memo ?? '' }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);
  const save = useApiMutation((post: boolean) => {
    const body = { ...f, toAmount: crossCurrency ? f.toAmount : null, fee: f.fee ?? 0, reference: f.reference || null, memo: f.memo || null, post };
    return row ? api.put(`/bank/transfers/${row.id}`, body) : api.post('/bank/transfers', body);
  });
  const submit = (post: boolean) =>
    save.mutate(post, { onSuccess: () => (toast.success(post ? t('common.posted') : t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) });
  const ready = f.fromAccountId && f.toAccountId && f.amount && (!f.fee || f.feeAccountId) && (!crossCurrency || f.toAmount);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row ? t('bank.editTransfer') : t('bank.newTransfer')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={save.isPending && !save.variables} disabled={!ready} onClick={() => submit(false)}>
            {t('common.saveDraft')}
          </Button>
          {can('treasury.transfers.post') && (
            <Button variant="primary" loading={save.isPending && !!save.variables} disabled={!ready} onClick={() => submit(true)}>
              {t('common.saveAndPost')}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('bank.from')}>
            <CashAccountSelect value={f.fromAccountId} onChange={(v) => setF({ ...f, fromAccountId: v })} list={accounts ?? []} exclude={f.toAccountId} />
          </Field>
          <Field label={t('bank.to')}>
            <CashAccountSelect value={f.toAccountId} onChange={(v) => setF({ ...f, toAccountId: v })} list={accounts ?? []} exclude={f.fromAccountId} />
          </Field>
          <Field label={fromCur ? `${t('common.amount')} (${fromCur})` : t('common.amount')}>
            <DecimalInput scale={scale} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
          </Field>
          {crossCurrency && (
            <Field label={`${t('bank.received')} (${toCur || base})`} hint={f.amount && f.toAmount ? t('bank.impliedRate', { rate: (f.toAmount / f.amount).toLocaleString('en', { maximumFractionDigits: 6 }) }) : undefined}>
              <DecimalInput scale={scale} value={f.toAmount} onChange={(v) => setF({ ...f, toAmount: v })} />
            </Field>
          )}
          <Field label={t('common.date')}>
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={t('bank.fee')} hint={t('bank.feeHint')}>
            <DecimalInput scale={scale} value={f.fee} onChange={(v) => setF({ ...f, fee: v })} />
          </Field>
          {!!f.fee && (
            <Field label={t('bank.feeAccount')}>
              <AccountPicker value={f.feeAccountId} onChange={(v) => setF({ ...f, feeAccountId: v })} filter={(a) => a.type === 'expense'} invalid={!f.feeAccountId} />
            </Field>
          )}
          <Field label={t('common.reference')}>
            <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
          <Field label={t('common.memo')}>
            <Input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
          </Field>
        </div>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

export function TransfersPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const { data, isLoading } = useApi<Paged<TransferRow>>('/bank/transfers', { limit: 20000 });
  const [dialog, setDialog] = useState<{ row: TransferRow | null } | null>(null);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const run = (fn: () => Promise<unknown>, msg: string) => act.mutate(fn, { onSuccess: () => toast.success(msg), onError: (e) => toast.error(errText(e)) });

  const columns = useMemo<Column<TransferRow>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number ?? <span className="faint">{t('status.draft')}</span>}</span> },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      { id: 'from', header: t('bank.from'), type: 'enum', value: (r) => `${r.from_code} · ${pick(r.from_name_en, r.from_name_ar)}` },
      { id: 'to', header: t('bank.to'), type: 'enum', value: (r) => `${r.to_code} · ${pick(r.to_name_en, r.to_name_ar)}` },
      { id: 'memo', header: t('common.memo'), value: (r) => r.memo },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('status.' + v), render: (r) => <SimpleStatus status={r.status} /> },
      { id: 'fee', header: t('bank.fee'), type: 'money', hidden: true, value: (r) => r.fee, render: (r) => <Money v={r.fee} /> },
      { id: 'amount', header: t('common.amount'), type: 'money', total: true, value: (r) => (r.status === 'void' ? 0 : r.amount), render: (r) => <Money v={r.amount} /> },
      {
        id: 'actions',
        header: '',
        value: () => null,
        render: (r) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
            {r.status === 'draft' && can('treasury.transfers.post') && (
              <Button size="sm" onClick={() => run(() => api.post(`/bank/transfers/${r.id}/post`), t('common.posted'))}>
                {t('common.post')}
              </Button>
            )}
            {r.status === 'posted' && can('treasury.transfers.post') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const c = await confirm({ title: t('bank.voidTransfer'), body: t('bank.voidTransferText'), danger: true, confirmLabel: t('common.void'), withDate: { label: t('common.date'), value: r.date } });
                  if (c.ok) run(() => api.post(`/bank/transfers/${r.id}/void`, { date: c.date ?? null }), t('common.saved'));
                }}
              >
                {t('common.void')}
              </Button>
            )}
            {r.status === 'draft' && can('treasury.transfers.write') && (
              <Button size="sm" variant="ghost" onClick={() => run(() => api.del(`/bank/transfers/${r.id}`), t('common.deleted'))}>
                {t('common.delete')}
              </Button>
            )}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, pick, can],
  );
  const presets = useMemo<Preset<TransferRow>[]>(
    () => [
      { id: 'draft', label: t('status.draft'), test: (r) => r.status === 'draft' },
      { id: 'posted', label: t('status.posted'), test: (r) => r.status === 'posted' },
    ],
    [t],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('bank.transfers')}
        subtitle={t('bank.transfersSub')}
        actions={
          can('treasury.transfers.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ row: null })}>
              {t('bank.newTransfer')}
            </Button>
          )
        }
      />
      <DataGrid
        id="bank.transfers"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => r.status === 'draft' && can('treasury.transfers.write') && setDialog({ row: r })}
        exportName={t('bank.transfers')}
        empty={<EmptyState icon={<ArrowLeftRight size={22} />} title={t('bank.noTransfers')} text={t('bank.noTransfersText')} />}
      />
      <TransferDialog open={!!dialog} row={dialog?.row ?? null} onClose={() => setDialog(null)} />
    </div>
  );
}
