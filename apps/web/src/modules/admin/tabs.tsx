import { useEffect, useState } from 'react';
import { CalendarPlus, Download, HardDriveDownload, KeyRound, Lock, LockOpen, Network, Pencil, Plus, UserPlus } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { addDaysIso, formatBytes, formatDateTime } from '../../core/format';
import type { Account, Company, FiscalYear } from '../../core/types';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, Field, Input, Select } from '../../ui/Field';
import { AccountPicker } from '../../ui/Pickers';
import { Loading } from '../../ui/Page';
import { useToast } from '../../ui/Toast';

function useAction() {
  const toast = useToast();
  const errText = useErrorText();
  const m = useApiMutation((fn: () => Promise<unknown>) => fn());
  return {
    pending: m.isPending,
    run: (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
      m.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (e) => toast.error(errText(e)) }),
  };
}

// ---------------------------------------------------------------- company

export function CompanyTab() {
  const { t } = useI18n();
  const { company, lockDate, refresh, can } = useSession();
  const act = useAction();
  const [f, setF] = useState<Company | null>(company);
  const [lock, setLock] = useState(lockDate ?? '');
  useEffect(() => setF(company), [company]);
  useEffect(() => setLock(lockDate ?? ''), [lockDate]);
  if (!f) return <Loading />;
  const set = <K extends keyof Company>(k: K, v: Company[K]) => setF({ ...f, [k]: v });
  const editable = can('admin.settings.manage');
  return (
    <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      <Card>
        <CardHeader title={t('settings.company')} />
        <div className="card-body stack">
          <div className="grid-2">
            <Field label={t('setup.companyName')}>
              <Input value={f.name} disabled={!editable} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label={t('setup.legalName')}>
              <Input value={f.legalName ?? ''} disabled={!editable} onChange={(e) => set('legalName', e.target.value)} />
            </Field>
            <Field label={t('common.taxNumber')}>
              <Input value={f.taxNumber ?? ''} disabled={!editable} onChange={(e) => set('taxNumber', e.target.value)} />
            </Field>
            <Field label={t('common.phone')}>
              <Input value={f.phone ?? ''} disabled={!editable} onChange={(e) => set('phone', e.target.value)} dir="ltr" />
            </Field>
            <Field label={t('common.email')}>
              <Input value={f.email ?? ''} disabled={!editable} onChange={(e) => set('email', e.target.value)} dir="ltr" />
            </Field>
            <Field label={t('common.address')}>
              <Input value={f.address ?? ''} disabled={!editable} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label={t('setup.baseCurrency')} hint={t('settings.currencyLocked')}>
              <Input value={`${f.baseCurrency} · ${f.moneyScale}`} disabled />
            </Field>
          </div>
        </div>
        {editable && (
          <div className="card-footer row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="primary"
              loading={act.pending}
              onClick={() =>
                act.run(
                  () =>
                    api.put('/settings/company', {
                      name: f.name,
                      legalName: f.legalName || null,
                      taxNumber: f.taxNumber || null,
                      address: f.address || null,
                      phone: f.phone || null,
                      email: f.email || null,
                    }),
                  t('common.saved'),
                  refresh,
                )
              }
            >
              {t('common.save')}
            </Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title={t('settings.lockDate')} sub={t('settings.lockDateHint')} icon={<Lock size={18} className="muted" />} />
        <div className="card-body row wrap">
          <Input type="date" value={lock} onChange={(e) => setLock(e.target.value)} disabled={!editable} style={{ width: 'auto' }} />
          {editable && (
            <>
              <Button variant="primary" loading={act.pending} onClick={() => act.run(() => api.put('/settings/lock-date', { lockDate: lock || null }), t('common.saved'), refresh)}>
                {t('common.apply')}
              </Button>
              {lockDate && (
                <Button onClick={() => act.run(() => api.put('/settings/lock-date', { lockDate: null }), t('common.saved'), refresh)}>{t('settings.noLock')}</Button>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ users

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'accountant' | 'viewer';
  locale: 'en' | 'ar';
  is_active: number;
  last_login_at: string | null;
}

// ----------------------------------------------------------- fiscal years

export function FiscalTab() {
  const { t } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const confirm = useConfirm();
  const act = useAction();
  const { data, isLoading } = useApi<FiscalYear[]>('/fiscal-years');
  const manage = can('gl.fiscal.manage');

  const createNext = () => {
    const last = data?.[data.length - 1];
    if (!last) return;
    const start = addDaysIso(last.end_date, 1);
    const [y, m, d] = start.split('-').map(Number);
    const end = new Date(Date.UTC(y + 1, m - 1, d - 1)).toISOString().slice(0, 10);
    act.run(() => api.post('/fiscal-years', { startDate: start, endDate: end }), t('common.saved'));
  };

  return (
    <Card className="table-card">
      <CardHeader
        title={t('settings.fiscalYears')}
        actions={
          manage && (
            <Button size="sm" icon={<CalendarPlus />} onClick={createNext} loading={act.pending}>
              {t('settings.newFiscalYear')}
            </Button>
          )
        }
      />
      {isLoading ? (
        <Loading />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('common.from')}</th>
              <th>{t('common.to')}</th>
              <th>{t('common.status')}</th>
              <th className="shrink" />
            </tr>
          </thead>
          <tbody>
            {data?.map((fy) => (
              <tr key={fy.id}>
                <td style={{ fontWeight: 600 }}>{fy.name}</td>
                <td>{date(fy.start_date)}</td>
                <td>{date(fy.end_date)}</td>
                <td>{fy.status === 'open' ? <Badge tone="green">{t('status.open')}</Badge> : <Badge tone="amber">{t('status.closed')}</Badge>}</td>
                <td>
                  {manage &&
                    (fy.status === 'open' ? (
                      <Button
                        size="sm"
                        icon={<Lock />}
                        onClick={async () => {
                          if ((await confirm({ title: t('settings.closeYearTitle', { name: fy.name }), body: t('settings.closeYearText'), confirmLabel: t('settings.closeYear') })).ok)
                            act.run(() => api.post(`/fiscal-years/${fy.id}/close`), t('common.saved'));
                        }}
                      >
                        {t('settings.closeYear')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" icon={<LockOpen />} onClick={() => act.run(() => api.post(`/fiscal-years/${fy.id}/reopen`), t('common.saved'))}>
                        {t('settings.reopenYear')}
                      </Button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ------------------------------------------------------- default accounts

export function DefaultsTab() {
  const { t } = useI18n();
  const { can } = useSession();
  const act = useAction();
  const { data } = useApi<{ defaultKeys: string[]; defaults: Record<string, number | null> }>('/accounts/meta');
  const [map, setMap] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (data) setMap(data.defaults);
  }, [data]);
  if (!data) return <Loading />;
  const filters: Record<string, (a: Account) => boolean> = {
    cash: (a) => a.subtype === 'cash',
    bank: (a) => a.subtype === 'bank',
    receivable: (a) => a.subtype === 'receivable',
    payable: (a) => a.subtype === 'payable',
    sales: (a) => a.type === 'income',
    services: (a) => a.type === 'income',
    purchases: (a) => a.type === 'expense' || a.type === 'asset',
    inventory: (a) => a.subtype === 'inventory',
    cogs: (a) => a.type === 'expense',
    vatOutput: (a) => a.type === 'liability' || a.type === 'asset',
    vatInput: (a) => a.type === 'asset' || a.type === 'liability',
    retainedEarnings: (a) => a.subtype === 'retained_earnings',
    capital: (a) => a.type === 'equity',
    inventoryAdjustment: (a) => a.type === 'expense',
  };
  return (
    <Card>
      <CardHeader title={t('accounts.defaults')} sub={t('accounts.defaultsHint')} />
      <div className="card-body grid-2">
        {data.defaultKeys.map((k) => (
          <Field key={k} label={t('defaultKeys.' + k)}>
            <AccountPicker value={map[k] ?? null} filter={filters[k]} onChange={(id) => setMap((m) => ({ ...m, [k]: id }))} />
          </Field>
        ))}
      </div>
      {can('admin.settings.manage') && (
        <div className="card-footer row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" loading={act.pending} onClick={() => act.run(() => api.put('/accounts-defaults', map), t('common.saved'))}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </Card>
  );
}

// -------------------------------------------------------------- numbering

export function NumberingTab() {
  const { t } = useI18n();
  const { can } = useSession();
  const act = useAction();
  const { data } = useApi<{ key: string; prefix: string; next_value: number; padding: number }[]>('/sequences');
  const [edits, setEdits] = useState<Record<string, { prefix: string; next_value: number; padding: number }>>({});
  useEffect(() => {
    if (data) setEdits(Object.fromEntries(data.map((s) => [s.key, { prefix: s.prefix, next_value: s.next_value, padding: s.padding }])));
  }, [data]);
  if (!data) return <Loading />;
  const manage = can('admin.settings.manage');
  return (
    <Card className="table-card">
      <CardHeader title={t('settings.sequences')} sub={t('settings.sequenceHint')} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.type')}</th>
            <th>{t('settings.prefix')}</th>
            <th>{t('settings.nextNumber')}</th>
            <th>{t('settings.padding')}</th>
            <th>{t('common.view')}</th>
            <th className="shrink" />
          </tr>
        </thead>
        <tbody>
          {data.map((s) => {
            const e = edits[s.key] ?? s;
            const changed = e.prefix !== s.prefix || e.next_value !== s.next_value || e.padding !== s.padding;
            return (
              <tr key={s.key}>
                <td style={{ fontWeight: 550 }}>{t('settings.seqKeys.' + s.key)}</td>
                <td>
                  <Input sm value={e.prefix} disabled={!manage} onChange={(x) => setEdits({ ...edits, [s.key]: { ...e, prefix: x.target.value } })} style={{ width: 90 }} />
                </td>
                <td>
                  <Input
                    sm
                    type="number"
                    min={s.next_value}
                    value={e.next_value}
                    disabled={!manage}
                    onChange={(x) => setEdits({ ...edits, [s.key]: { ...e, next_value: Number(x.target.value) } })}
                    style={{ width: 110 }}
                  />
                </td>
                <td>
                  <Input
                    sm
                    type="number"
                    min={1}
                    max={12}
                    value={e.padding}
                    disabled={!manage}
                    onChange={(x) => setEdits({ ...edits, [s.key]: { ...e, padding: Number(x.target.value) } })}
                    style={{ width: 70 }}
                  />
                </td>
                <td className="num muted">{e.prefix + String(e.next_value).padStart(e.padding, '0')}</td>
                <td>
                  {manage && changed && (
                    <Button size="sm" variant="primary" loading={act.pending} onClick={() => act.run(() => api.put(`/sequences/${s.key}`, e), t('common.saved'))}>
                      {t('common.save')}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------- backups

export function BackupsTab() {
  const { t, locale } = useI18n();
  const act = useAction();
  const { data } = useApi<{ name: string; size: number; createdAt: string }[]>('/system/backups');
  return (
    <Card className="table-card">
      <CardHeader
        title={t('settings.backups')}
        sub={t('settings.backupsHint')}
        icon={<HardDriveDownload size={18} className="muted" />}
        actions={
          <Button size="sm" variant="primary" icon={<Plus />} loading={act.pending} onClick={() => act.run(() => api.post('/system/backups'), t('settings.backupDone'))}>
            {t('settings.backupNow')}
          </Button>
        }
      />
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('common.date')}</th>
            <th className="end">{t('settings.size')}</th>
            <th className="shrink" />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((b) => (
            <tr key={b.name}>
              <td className="mono">{b.name}</td>
              <td className="muted">{formatDateTime(b.createdAt, locale)}</td>
              <td className="end num">{formatBytes(b.size)}</td>
              <td>
                <a className="btn btn-sm btn-ghost" href={`/api/system/backups/${encodeURIComponent(b.name)}`} download>
                  <Download /> {t('common.download')}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------- network

export function NetworkTab() {
  const { t } = useI18n();
  const { info } = useSession();
  return (
    <Card>
      <CardHeader title={t('settings.network')} sub={t('settings.networkHint')} icon={<Network size={18} className="muted" />} />
      <div className="card-body stack" style={{ '--gap': '10px' } as React.CSSProperties}>
        {(info?.lanUrls ?? []).map((u) => (
          <a key={u} href={u} className="mono" style={{ fontSize: 16, color: 'var(--primary)' }} dir="ltr">
            {u}
          </a>
        ))}
        <p className="muted" style={{ fontSize: 13 }}>
          {window.location.origin}
        </p>
      </div>
    </Card>
  );
}
