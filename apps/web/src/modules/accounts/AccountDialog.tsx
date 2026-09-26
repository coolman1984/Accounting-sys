import { useEffect, useState } from 'react';
import { useI18n } from '../../core/i18n';
import { useApi, useApiMutation, useErrorText } from '../../core/hooks';
import { api } from '../../core/api';
import type { Account, AccountType } from '../../core/types';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';

interface Meta {
  types: AccountType[];
  subtypes: Record<AccountType, string[]>;
}

export function AccountDialog({
  open,
  onClose,
  account,
  parent,
}: {
  open: boolean;
  onClose(): void;
  account?: Account | null;
  parent?: Account | null;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const { data: meta } = useApi<Meta>('/accounts/meta');
  const blank = {
    code: '',
    nameEn: '',
    nameAr: '',
    type: 'asset' as AccountType,
    subtype: 'current_asset',
    parentId: null as number | null,
    isGroup: false,
    isActive: true,
    description: '',
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    if (account) {
      setF({
        code: account.code,
        nameEn: account.name_en,
        nameAr: account.name_ar,
        type: account.type,
        subtype: account.subtype,
        parentId: account.parent_id,
        isGroup: !!account.is_group,
        isActive: !!account.is_active,
        description: account.description ?? '',
      });
    } else if (parent) {
      setF({ ...blank, type: parent.type, subtype: parent.subtype, parentId: parent.id });
    } else setF(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account, parent]);

  const save = useApiMutation((body: typeof f) => (account ? api.put(`/accounts/${account.id}`, body) : api.post('/accounts', body)));

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const subtypes = meta?.subtypes[f.type] ?? [];

  const submit = () =>
    save.mutate(
      { ...f, description: f.description || null } as typeof f,
      {
        onSuccess: () => {
          toast.success(t('common.saved'));
          onClose();
        },
        onError: (e) => setErr(errText(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={account ? t('accounts.edit') : t('accounts.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit} disabled={!f.code || !f.nameEn || !f.nameAr}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.code')}>
            <Input value={f.code} onChange={(e) => set('code', e.target.value)} className="num" />
          </Field>
          <Field label={t('accounts.parent')}>
            <AccountPicker
              includeGroups
              value={f.parentId}
              filter={(a) => !!a.is_group && a.id !== account?.id}
              placeholder={t('accounts.noParent')}
              onChange={(id, a) => {
                set('parentId', id);
                if (a) setF((x) => ({ ...x, parentId: id, type: a.type, subtype: meta?.subtypes[a.type].includes(x.subtype) ? x.subtype : a.subtype }));
              }}
            />
          </Field>
        </div>
        <Field label={t('common.nameEn')}>
          <Input value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} dir="ltr" />
        </Field>
        <Field label={t('common.nameAr')}>
          <Input value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} dir="rtl" />
        </Field>
        <div className="grid-2">
          <Field label={t('common.type')} hint={account?.has_postings ? t('accounts.hasPostings') : undefined}>
            <Select
              value={f.type}
              disabled={!!f.parentId || !!account?.has_postings}
              onChange={(e) => {
                const type = e.target.value as AccountType;
                setF((x) => ({ ...x, type, subtype: meta?.subtypes[type][0] ?? '' }));
              }}
            >
              {(meta?.types ?? []).map((ty) => (
                <option key={ty} value={ty}>
                  {t('accountTypes.' + ty)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('accounts.subtype')}>
            <Select value={f.subtype} onChange={(e) => set('subtype', e.target.value)}>
              {subtypes.map((s) => (
                <option key={s} value={s}>
                  {t('subtypes.' + s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={`${t('common.description')} (${t('common.optional')})`}>
          <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} rows={2} />
        </Field>
        <div className="row wrap" style={{ gap: 20 }}>
          <Checkbox label={t('accounts.isGroup')} checked={f.isGroup} onChange={(v) => set('isGroup', v)} disabled={!!account?.has_postings && !f.isGroup} />
          <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => set('isActive', v)} />
        </div>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}
