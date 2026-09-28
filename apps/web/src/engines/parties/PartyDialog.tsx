import { useEffect, useState } from 'react';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { api } from '../../core/api';
import type { Party } from '../../core/types';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';

export function PartyDialog({
  open,
  onClose,
  party,
  kind,
  onSaved,
}: {
  open: boolean;
  onClose(): void;
  party?: Party | null;
  kind: 'customer' | 'supplier';
  onSaved?(id: number): void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const { scale } = useMoney();
  const { hasApp } = useSession();
  const blank = {
    kind: kind as Party['kind'],
    code: '',
    name: '',
    nameAlt: '',
    taxNumber: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: '',
    receivableAccountId: null as number | null,
    payableAccountId: null as number | null,
    paymentTermsDays: kind === 'customer' ? 30 : 30,
    creditLimit: null as number | null,
    whtType: null as string | null,
    notes: '',
    isActive: true,
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(key: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [key]: v }));

  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      party
        ? {
            kind: party.kind,
            code: party.code,
            name: party.name,
            nameAlt: party.name_alt ?? '',
            taxNumber: party.tax_number ?? '',
            email: party.email ?? '',
            phone: party.phone ?? '',
            address: party.address ?? '',
            city: party.city ?? '',
            country: party.country ?? '',
            receivableAccountId: party.receivable_account_id,
            payableAccountId: party.payable_account_id,
            paymentTermsDays: party.payment_terms_days,
            creditLimit: party.credit_limit,
            whtType: party.wht_type ?? null,
            notes: party.notes ?? '',
            isActive: !!party.is_active,
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, party]);

  const save = useApiMutation((body: typeof f) =>
    party ? api.put<{ id: number }>(`/parties/${party.id}`, body).then(() => ({ id: party.id })) : api.post<{ id: number }>('/parties', body),
  );

  const submit = () =>
    save.mutate(f, {
      onSuccess: (r) => {
        toast.success(t('common.saved'));
        onSaved?.(r.id);
        onClose();
      },
      onError: (e) => setErr(errText(e)),
    });

  const isCustomer = f.kind !== 'supplier';
  const isSupplier = f.kind !== 'customer';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={party ? t('parties.edit') : t(`parties.${kind}s.new`)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <Field label={t('common.name')} className="span-2">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={`${t('common.code')} (${t('common.optional')})`}>
            <Input value={f.code} onChange={(e) => set('code', e.target.value)} />
          </Field>
          <Field label={t('parties.nameAlt')} className="span-2">
            <Input value={f.nameAlt} onChange={(e) => set('nameAlt', e.target.value)} />
          </Field>
          <Field label={t('parties.kind')}>
            <Select value={f.kind} onChange={(e) => set('kind', e.target.value as Party['kind'])}>
              {(['customer', 'supplier', 'both'] as const).map((k) => (
                <option key={k} value={k}>
                  {t('parties.kinds.' + k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('common.phone')}>
            <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} dir="ltr" />
          </Field>
          <Field label={t('common.email')}>
            <Input value={f.email} onChange={(e) => set('email', e.target.value)} dir="ltr" />
          </Field>
          <Field label={t('common.taxNumber')}>
            <Input value={f.taxNumber} onChange={(e) => set('taxNumber', e.target.value)} />
          </Field>
          <Field label={t('common.address')} className="span-2">
            <Input value={f.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label={t('common.city')}>
            <Input value={f.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label={t('parties.terms')}>
            <Input type="number" min={0} value={f.paymentTermsDays} onChange={(e) => set('paymentTermsDays', Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          {isCustomer && (
            <Field label={`${t('parties.creditLimit')} (${t('common.optional')})`}>
              <DecimalInput scale={scale} value={f.creditLimit} onChange={(v) => set('creditLimit', v)} />
            </Field>
          )}
          {hasApp('tax') && (
            <Field label={t('wht.partyType')} hint={t(isSupplier && !isCustomer ? 'wht.partyTypeSupplier' : 'wht.partyTypeCustomer')}>
              <Select value={f.whtType ?? ''} onChange={(e) => set('whtType', e.target.value || null)}>
                <option value="">{t('wht.none')}</option>
                {['supplies', 'contracting', 'services', 'commissions'].map((k) => (
                  <option key={k} value={k}>
                    {t('wht.types.' + k)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <details>
          <summary className="label" style={{ cursor: 'pointer', marginBottom: 10 }}>
            {t('parties.controlAccounts')}
          </summary>
          <p className="faint" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {t('parties.controlHint')}
          </p>
          <div className="grid-2">
            {isCustomer && (
              <Field label={t('parties.receivableAccount')}>
                <AccountPicker value={f.receivableAccountId} onChange={(v) => set('receivableAccountId', v)} filter={(a) => a.subtype === 'receivable'} placeholder={t('items.useDefault')} />
              </Field>
            )}
            {isSupplier && (
              <Field label={t('parties.payableAccount')}>
                <AccountPicker value={f.payableAccountId} onChange={(v) => set('payableAccountId', v)} filter={(a) => a.subtype === 'payable'} placeholder={t('items.useDefault')} />
              </Field>
            )}
          </div>
        </details>
        <Field label={t('common.notes')}>
          <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => set('isActive', v)} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}
