import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Building2, CalendarCheck, FolderCog, LineChart, LogOut, Pencil, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate, todayIso } from '../../core/format';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker, PartyPicker } from '../../ui/Pickers';
import { CostCenterSelect, useCostCenters } from '../../ui/CostCenter';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { PeriodControls, usePeriod } from '../../ui/Report';

interface Category {
  id: number;
  name_en: string;
  name_ar: string;
  asset_account_id: number;
  accum_account_id: number;
  expense_account_id: number;
  method: 'straight_line' | 'declining';
  life_months: number;
  residual_bp: number;
  is_active: number;
}
interface AssetRow {
  id: number;
  code: string;
  name: string;
  category_id: number;
  category_en: string;
  category_ar: string;
  acquisition_date: string;
  cost: number;
  accumulated: number;
  book_value: number;
  status: 'active' | 'disposed';
  fully_depreciated: boolean;
  location: string | null;
}
interface AssetFull extends Omit<AssetRow, 'category_en' | 'category_ar'> {
  category: Category;
  start_month: string;
  residual: number;
  life_months: number;
  method: 'straight_line' | 'declining';
  rate_bp: number | null;
  opening_accumulated: number;
  opening_months: number;
  cost_center_id: number | null;
  serial_no: string | null;
  notes: string | null;
  acquisition_entry_id: number | null;
  disposal_date: string | null;
  proceeds: number | null;
  gain: number | null;
  disposal_entry_id: number | null;
  monthly: number;
  schedule: { month: string; amount: number; accumulated: number; bookValue: number; posted: boolean; disposal: boolean }[];
}

const monthLabel = (m: string, locale: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { month: 'short', year: 'numeric' });
const lifeText = (months: number, t: (k: string, v?: Record<string, number>) => string) => (months % 12 === 0 ? t('fa.years', { n: months / 12 }) : t('fa.months', { n: months }));

// ------------------------------------------------------------- register

function RegisterPage() {
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<AssetRow[]>('/assets');
  const columns = useMemo<Column<AssetRow>[]>(
    () => [
      { id: 'code', header: t('common.code'), pinned: true, value: (a) => a.code, render: (a) => <span className="num">{a.code}</span> },
      { id: 'name', header: t('common.name'), value: (a) => a.name, render: (a) => <strong>{a.name}</strong> },
      { id: 'category', header: t('fa.category'), type: 'enum', value: (a) => pick(a.category_en, a.category_ar) },
      { id: 'date', header: t('fa.acquired'), type: 'date', value: (a) => a.acquisition_date, render: (a) => formatDate(a.acquisition_date, locale) },
      { id: 'cost', header: t('fa.cost'), type: 'number', value: (a) => a.cost, render: (a) => <span className="num">{fmt(a.cost)}</span> },
      { id: 'acc', header: t('fa.accumulated'), type: 'number', value: (a) => a.accumulated, render: (a) => <span className="num">{fmt(a.accumulated)}</span> },
      { id: 'nbv', header: t('fa.bookValue'), type: 'number', value: (a) => a.book_value, render: (a) => <strong className="num">{fmt(a.book_value)}</strong> },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (a) => (a.status === 'disposed' ? 'disposed' : a.fully_depreciated ? 'full' : 'active'),
        format: (v) => t('fa.status.' + v),
        render: (a) => (
          <Badge tone={a.status === 'disposed' ? 'neutral' : a.fully_depreciated ? 'amber' : 'green'}>{t('fa.status.' + (a.status === 'disposed' ? 'disposed' : a.fully_depreciated ? 'full' : 'active'))}</Badge>
        ),
      },
    ],
    [t, pick, fmt, locale],
  );
  const active = (data ?? []).filter((a) => a.status === 'active');
  return (
    <div className="page">
      <PageHeader
        title={t('fa.register')}
        subtitle={t('fa.registerSub')}
        actions={
          can('assets.register.write') && (
            <Link to="/fixed-assets/new" className="btn btn-primary">
              <Plus /> {t('fa.newAsset')}
            </Link>
          )
        }
      />
      {active.length > 0 && (
        <div className="kpi-strip">
          <div>
            <span>{t('fa.assetsInUse')}</span>
            <strong>{active.length}</strong>
          </div>
          <div>
            <span>{t('fa.cost')}</span>
            <strong>{fmt(active.reduce((s, a) => s + a.cost, 0))}</strong>
          </div>
          <div>
            <span>{t('fa.accumulated')}</span>
            <strong>{fmt(active.reduce((s, a) => s + a.accumulated, 0))}</strong>
          </div>
          <div>
            <span>{t('fa.bookValue')}</span>
            <strong>{fmt(active.reduce((s, a) => s + a.book_value, 0))}</strong>
          </div>
        </div>
      )}
      <DataGrid id="fa-register" rows={data} loading={isLoading} columns={columns} rowKey={(a) => a.id} onRowClick={(a) => navigate(`/fixed-assets/${a.id}`)} exportName={t('fa.register')} empty={<EmptyState icon={<Building2 size={22} />} title={t('fa.noAssets')} text={t('fa.noAssetsText')} />} />
    </div>
  );
}

// ----------------------------------------------------------- asset form

type Form = {
  name: string;
  categoryId: number | null;
  acquisitionDate: string;
  startDate: string;
  cost: number | null;
  residual: number | null;
  lifeMonths: number | null;
  method: 'straight_line' | 'declining';
  rateBp: number | null;
  openingAccumulated: number | null;
  openingMonths: number | null;
  costCenterId: number | null;
  location: string;
  serialNo: string;
  notes: string;
  bookPurchase: boolean;
  counterAccountId: number | null;
  partyId: number | null;
  broughtIn: boolean;
};

function DisposeDialog({ asset, open, onClose }: { asset: AssetFull; open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const { scale, fmt } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState({ date: todayIso(), proceeds: 0 as number | null, proceedsAccountId: null as number | null, partyId: null as number | null, notes: '' });
  const [needsParty, setNeedsParty] = useState(false);
  const save = useApiMutation(() => api.post(`/assets/${asset.id}/dispose`, { ...f, proceeds: f.proceeds ?? 0, notes: f.notes || null }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('fa.dispose')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('fa.disposed')), onClose()), onError: (e) => toast.error(errText(e)) })}>
            {t('fa.dispose')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="faint" style={{ margin: 0 }}>{t('fa.disposeHint', { amount: fmt(asset.book_value) })}</p>
        <div className="grid-2">
          <Field label={t('common.date')}>
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={t('fa.proceeds')} hint={t('fa.proceedsHint')}>
            <DecimalInput scale={scale} value={f.proceeds} onChange={(v) => setF({ ...f, proceeds: v })} />
          </Field>
        </div>
        {(f.proceeds ?? 0) > 0 && (
          <div className="grid-2">
            <Field label={t('fa.proceedsAccount')}>
              <AccountPicker
                value={f.proceedsAccountId}
                filter={(a) => a.type === 'asset' && !['fixed_asset', 'accumulated_depreciation'].includes(a.subtype)}
                onChange={(v, a) => {
                  setNeedsParty(a?.subtype === 'receivable');
                  setF({ ...f, proceedsAccountId: v, partyId: null });
                }}
              />
            </Field>
            {needsParty && (
              <Field label={t('fa.buyer')}>
                <PartyPicker kind="customer" value={f.partyId} onChange={(v) => setF({ ...f, partyId: v })} />
              </Field>
            )}
          </div>
        )}
        <Field label={t('common.notes')}>
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function AssetPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const { t, pick, locale } = useI18n();
  const { fmt, scale } = useMoney();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const cc = useCostCenters();
  const { data: a, isLoading } = useApi<AssetFull>(isNew ? null : `/assets/${id}`);
  const { data: cats } = useApi<Category[]>('/assets/categories');
  const [editing, setEditing] = useState(isNew);
  const [disposing, setDisposing] = useState(false);
  const [needsParty, setNeedsParty] = useState(false);
  const blank: Form = { name: '', categoryId: null, acquisitionDate: todayIso(), startDate: '', cost: null, residual: 0, lifeMonths: null, method: 'straight_line', rateBp: null, openingAccumulated: 0, openingMonths: 0, costCenterId: null, location: '', serialNo: '', notes: '', bookPurchase: true, counterAccountId: null, partyId: null, broughtIn: false };
  const [f, setF] = useState<Form>(blank);
  useEffect(() => {
    if (!a) return;
    setF({
      name: a.name,
      categoryId: a.category_id,
      acquisitionDate: a.acquisition_date,
      startDate: a.start_month,
      cost: a.cost,
      residual: a.residual,
      lifeMonths: a.life_months,
      method: a.method,
      rateBp: a.rate_bp,
      openingAccumulated: a.opening_accumulated,
      openingMonths: a.opening_months,
      costCenterId: a.cost_center_id,
      location: a.location ?? '',
      serialNo: a.serial_no ?? '',
      notes: a.notes ?? '',
      bookPurchase: false,
      counterAccountId: null,
      partyId: null,
      broughtIn: a.opening_accumulated > 0,
    });
  }, [a]);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const locked = !!a && (a.acquisition_entry_id != null || a.schedule.some((r) => r.posted));
  const writable = can('assets.register.write');
  const body = () => ({
    name: f.name,
    categoryId: f.categoryId,
    acquisitionDate: f.acquisitionDate,
    startDate: f.startDate || null,
    cost: f.cost ?? 0,
    residual: f.residual ?? 0,
    lifeMonths: f.lifeMonths ?? 0,
    method: f.method,
    rateBp: f.method === 'declining' ? f.rateBp : null,
    openingAccumulated: f.broughtIn ? f.openingAccumulated ?? 0 : 0,
    openingMonths: f.broughtIn ? f.openingMonths ?? 0 : 0,
    costCenterId: f.costCenterId,
    location: f.location || null,
    serialNo: f.serialNo || null,
    notes: f.notes || null,
    acquisition: isNew && f.bookPurchase && f.counterAccountId ? { counterAccountId: f.counterAccountId, partyId: f.partyId } : null,
  });
  const save = () =>
    act.mutate(() => (isNew ? api.post<{ id: number }>('/assets', body()) : api.put(`/assets/${id}`, body())), {
      onSuccess: (r: any) => {
        toast.success(t('common.saved'));
        if (isNew) navigate(`/fixed-assets/${r.id}`, { replace: true });
        else setEditing(false);
      },
      onError: (e) => toast.error(errText(e)),
    });
  const pickCategory = (cid: number | null) => {
    const c = cats?.find((x) => x.id === cid);
    setF({ ...f, categoryId: cid, lifeMonths: f.lifeMonths ?? c?.life_months ?? null, method: c?.method ?? f.method, residual: f.residual || (c && f.cost ? Math.round((f.cost * c.residual_bp) / 10000) : f.residual) });
  };
  if (!isNew && (isLoading || !a)) return <Loading />;

  const form = (
    <Card pad>
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.name')}>
            <Input value={f.name} autoFocus={isNew} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('fa.category')}>
            <Select value={f.categoryId ?? ''} disabled={locked} onChange={(e) => pickCategory(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('common.select')}</option>
              {(cats ?? [])
                .filter((c) => c.is_active || c.id === f.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {pick(c.name_en, c.name_ar)}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="grid-3">
          <Field label={t('fa.acquired')}>
            <Input type="date" value={f.acquisitionDate} disabled={locked} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} />
          </Field>
          <Field label={t('fa.cost')}>
            <DecimalInput scale={scale} value={f.cost} disabled={locked} onChange={(v) => setF({ ...f, cost: v })} />
          </Field>
          <Field label={t('fa.residual')} hint={t('fa.residualHint')}>
            <DecimalInput scale={scale} value={f.residual} disabled={locked} onChange={(v) => setF({ ...f, residual: v })} />
          </Field>
        </div>
        <div className="grid-3">
          <Field label={t('fa.method')}>
            <Select value={f.method} disabled={locked} onChange={(e) => setF({ ...f, method: e.target.value as Form['method'] })}>
              <option value="straight_line">{t('fa.methods.straight_line')}</option>
              <option value="declining">{t('fa.methods.declining')}</option>
            </Select>
          </Field>
          <Field label={t('fa.life')} hint={f.lifeMonths ? lifeText(f.lifeMonths, t) : t('fa.lifeHint')}>
            <DecimalInput scale={0} trim value={f.lifeMonths} disabled={locked} onChange={(v) => setF({ ...f, lifeMonths: v })} />
          </Field>
          {f.method === 'declining' ? (
            <Field label={t('fa.rate')} hint={t('fa.rateHint')}>
              <DecimalInput scale={2} trim value={f.rateBp} disabled={locked} onChange={(v) => setF({ ...f, rateBp: v })} />
            </Field>
          ) : (
            <Field label={t('fa.startMonth')} hint={t('fa.startHint')}>
              <Input type="date" value={f.startDate} disabled={locked} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
            </Field>
          )}
        </div>
        <Checkbox label={t('fa.broughtIn')} checked={f.broughtIn} disabled={locked} onChange={(v) => setF({ ...f, broughtIn: v })} />
        {f.broughtIn && (
          <div className="grid-2">
            <Field label={t('fa.openingAccumulated')}>
              <DecimalInput scale={scale} value={f.openingAccumulated} disabled={locked} onChange={(v) => setF({ ...f, openingAccumulated: v })} />
            </Field>
            <Field label={t('fa.openingMonths')}>
              <DecimalInput scale={0} trim value={f.openingMonths} disabled={locked} onChange={(v) => setF({ ...f, openingMonths: v })} />
            </Field>
          </div>
        )}
        <div className="grid-3">
          <Field label={t('fa.location')}>
            <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          </Field>
          <Field label={t('fa.serial')}>
            <Input value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} />
          </Field>
          {cc.on && (
            <Field label={t('co.costCenter')}>
              <CostCenterSelect value={f.costCenterId} onChange={(v) => setF({ ...f, costCenterId: v })} list={cc.list} />
            </Field>
          )}
        </div>
        <Field label={t('common.notes')}>
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {isNew && (
          <div className="notice">
            <div className="stack" style={{ gap: 8, flex: 1 }}>
              <Checkbox label={t('fa.bookPurchase')} checked={f.bookPurchase} onChange={(v) => setF({ ...f, bookPurchase: v })} />
              {f.bookPurchase ? (
                <div className="grid-2">
                  <Field label={t('fa.paidFrom')} hint={t('fa.paidFromHint')}>
                    <AccountPicker
                      value={f.counterAccountId}
                      filter={(a) => !['fixed_asset', 'accumulated_depreciation', 'receivable'].includes(a.subtype)}
                      onChange={(v, acc) => {
                        setNeedsParty(acc?.subtype === 'payable');
                        setF({ ...f, counterAccountId: v, partyId: null });
                      }}
                    />
                  </Field>
                  {needsParty && (
                    <Field label={t('fa.supplier')}>
                      <PartyPicker kind="supplier" value={f.partyId} onChange={(v) => setF({ ...f, partyId: v })} />
                    </Field>
                  )}
                </div>
              ) : (
                <span className="faint" style={{ fontSize: 12.5 }}>{t('fa.purchaseInBooks')}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/fixed-assets', label: t('fa.register') }]}
        title={isNew ? t('fa.newAsset') : `${a!.code} · ${a!.name}`}
        badge={a && <Badge tone={a.status === 'disposed' ? 'neutral' : 'green'}>{t('fa.status.' + (a.status === 'disposed' ? 'disposed' : 'active'))}</Badge>}
        actions={
          writable && (
            <>
              {a && a.status === 'active' && !locked && !editing && (
                <Button
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('fa.deleteAsset'), danger: true, confirmLabel: t('common.delete') })).ok) act.mutate(() => api.del(`/assets/${id}`), { onSuccess: () => navigate('/fixed-assets'), onError: (e) => toast.error(errText(e)) });
                  }}
                />
              )}
              {a && a.status === 'active' && !editing && (
                <Button icon={<Pencil />} onClick={() => setEditing(true)}>
                  {t('common.edit')}
                </Button>
              )}
              {a && a.status === 'active' && !editing && can('assets.depreciation.post') && (
                <Button icon={<LogOut />} onClick={() => setDisposing(true)}>
                  {t('fa.dispose')}
                </Button>
              )}
              {a && a.status === 'disposed' && can('assets.depreciation.post') && (
                <Button
                  icon={<Undo2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('fa.undoDisposal'), danger: true })).ok) act.mutate(() => api.post(`/assets/${id}/undo-disposal`), { onSuccess: () => toast.success(t('common.saved')), onError: (e) => toast.error(errText(e)) });
                  }}
                >
                  {t('fa.undoDisposal')}
                </Button>
              )}
              {editing && (
                <Button variant="primary" icon={<Save />} loading={act.isPending} onClick={save}>
                  {t('common.save')}
                </Button>
              )}
            </>
          )
        }
      />
      {editing ? (
        <>
          {locked && <p className="faint">{t('fa.lockedHint')}</p>}
          {form}
        </>
      ) : (
        a && (
          <>
            <div className="kpi-strip">
              <div>
                <span>{t('fa.cost')}</span>
                <strong>{fmt(a.cost)}</strong>
                <small className="faint">{formatDate(a.acquisition_date, locale)}</small>
              </div>
              <div>
                <span>{t('fa.accumulated')}</span>
                <strong>{fmt(a.accumulated)}</strong>
              </div>
              <div>
                <span>{t('fa.bookValue')}</span>
                <strong>{fmt(a.book_value)}</strong>
                <small className="faint">{t('fa.residualIs', { amount: fmt(a.residual) })}</small>
              </div>
              <div>
                <span>{a.status === 'disposed' ? (a.gain! >= 0 ? t('fa.gain') : t('fa.loss')) : t('fa.monthly')}</span>
                <strong className={a.status === 'disposed' ? (a.gain! >= 0 ? 'success-text' : 'danger-text') : undefined}>{a.status === 'disposed' ? fmt(Math.abs(a.gain!)) : fmt(a.monthly)}</strong>
                <small className="faint">
                  {a.status === 'disposed' ? formatDate(a.disposal_date!, locale) : `${t('fa.methods.' + a.method)} · ${lifeText(a.life_months, t)}`}
                </small>
              </div>
            </div>
            <div className="stack">
              <Card>
                <CardHeader title={t('fa.details')} />
                <table className="table table-compact">
                  <tbody>
                    <tr>
                      <td className="faint">{t('fa.category')}</td>
                      <td>{pick(a.category.name_en, a.category.name_ar)}</td>
                    </tr>
                    <tr>
                      <td className="faint">{t('fa.startMonth')}</td>
                      <td>{monthLabel(a.start_month.slice(0, 7), locale)}</td>
                    </tr>
                    {a.location && (
                      <tr>
                        <td className="faint">{t('fa.location')}</td>
                        <td>{a.location}</td>
                      </tr>
                    )}
                    {a.serial_no && (
                      <tr>
                        <td className="faint">{t('fa.serial')}</td>
                        <td>{a.serial_no}</td>
                      </tr>
                    )}
                    {a.opening_accumulated > 0 && (
                      <tr>
                        <td className="faint">{t('fa.openingAccumulated')}</td>
                        <td className="num">{fmt(a.opening_accumulated)}</td>
                      </tr>
                    )}
                    {a.acquisition_entry_id && (
                      <tr>
                        <td className="faint">{t('fa.purchaseEntry')}</td>
                        <td>
                          <Link to={`/journal/${a.acquisition_entry_id}`}>{t('common.journalEntry')}</Link>
                        </td>
                      </tr>
                    )}
                    {a.disposal_entry_id && (
                      <tr>
                        <td className="faint">{t('fa.disposalEntry')}</td>
                        <td>
                          <Link to={`/journal/${a.disposal_entry_id}`}>{t('common.journalEntry')}</Link> · {fmt(a.proceeds ?? 0)}
                        </td>
                      </tr>
                    )}
                    {a.notes && (
                      <tr>
                        <td className="faint">{t('common.notes')}</td>
                        <td>{a.notes}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
              <Card>
                <CardHeader title={t('fa.schedule')} sub={t('fa.scheduleSub')} />
                <div className="table-wrap" style={{ maxHeight: 420 }}>
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t('fa.month')}</th>
                        <th className="end">{t('fa.depreciation')}</th>
                        <th className="end">{t('fa.accumulated')}</th>
                        <th className="end">{t('fa.bookValue')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.schedule.map((r) => (
                        <tr key={r.month} className={r.posted ? undefined : 'faint'}>
                          <td className="nowrap">
                            {monthLabel(r.month, locale)} {r.posted && <Badge plain tone={r.disposal ? 'amber' : 'green'}>{r.disposal ? t('fa.atDisposal') : t('fa.booked')}</Badge>}
                          </td>
                          <td className="end num">{fmt(r.amount)}</td>
                          <td className="end num">{fmt(r.accumulated)}</td>
                          <td className="end num">{fmt(r.bookValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </>
        )
      )}
      {a && <DisposeDialog asset={a} open={disposing} onClose={() => setDisposing(false)} />}
    </div>
  );
}

// ---------------------------------------------------------- depreciation

function DepreciationPage() {
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const [m, setM] = useState(todayIso().slice(0, 7));
  const { data: p } = useApi<{ month: string; rows: { id: number; code: string; name: string; category_en: string; category_ar: string; months: { month: string; amount: number }[]; amount: number }[]; total: number; last: string | null }>('/assets/depreciation/preview', { month: m });
  const { data: runs } = useApi<{ id: number; month: string; total: number; assets: number; entry_id: number | null; entry_number: string | null; created_at: string }[]>('/assets/depreciation/runs');
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const booked = !!p?.last && p.last >= m;
  return (
    <div className="page">
      <PageHeader title={t('fa.depreciationRuns')} subtitle={t('fa.depreciationSub')} />
      <Card>
        <CardHeader
          title={t('fa.bookFor')}
          actions={
            <div className="row" style={{ gap: 8 }}>
              <Input type="month" value={m} onChange={(e) => setM(e.target.value)} style={{ width: 'auto' }} />
              {can('assets.depreciation.post') && (
                <Button
                  variant="primary"
                  icon={<CalendarCheck />}
                  disabled={!p || booked || p.total === 0}
                  loading={act.isPending}
                  onClick={async () => {
                    if ((await confirm({ title: t('fa.bookTitle', { month: monthLabel(m, locale) }), body: t('fa.bookText', { amount: fmt(p!.total) }) })).ok)
                      act.mutate(() => api.post('/assets/depreciation/run', { month: m }), { onSuccess: () => toast.success(t('fa.booked')), onError: (e) => toast.error(errText(e)) });
                  }}
                >
                  {t('fa.book')}
                </Button>
              )}
            </div>
          }
        />
        {!p ? (
          <Loading />
        ) : booked ? (
          <EmptyState icon={<CalendarCheck size={22} />} title={t('fa.alreadyBooked', { month: monthLabel(p.last!, locale) })} />
        ) : p.rows.length === 0 ? (
          <EmptyState icon={<CalendarCheck size={22} />} title={t('fa.nothingToBook')} />
        ) : (
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('common.code')}</th>
                <th>{t('common.name')}</th>
                <th>{t('fa.category')}</th>
                <th>{t('fa.months_')}</th>
                <th className="end">{t('fa.depreciation')}</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    <Link to={`/fixed-assets/${r.id}`}>{r.code}</Link>
                  </td>
                  <td>{r.name}</td>
                  <td>{pick(r.category_en, r.category_ar)}</td>
                  <td className="faint">{r.months.map((x) => monthLabel(x.month, locale)).join('، ')}</td>
                  <td className="end num">{fmt(r.amount)}</td>
                </tr>
              ))}
              <tr className="grand-row">
                <td colSpan={4}>{t('common.total')}</td>
                <td className="end num">{fmt(p.total)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>
      <Card>
        <CardHeader title={t('fa.history')} />
        {!runs?.length ? (
          <EmptyState title={t('fa.noRuns')} />
        ) : (
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('fa.month')}</th>
                <th className="end">{t('fa.assetsCount')}</th>
                <th className="end">{t('fa.depreciation')}</th>
                <th>{t('common.journalEntry')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={r.id}>
                  <td>{monthLabel(r.month, locale)}</td>
                  <td className="end num">{r.assets}</td>
                  <td className="end num">{fmt(r.total)}</td>
                  <td>{r.entry_id ? <Link to={`/journal/${r.entry_id}`}>{r.entry_number}</Link> : '—'}</td>
                  <td className="end">
                    {i === 0 && can('assets.depreciation.post') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Undo2 />}
                        onClick={async () => {
                          if ((await confirm({ title: t('fa.undoRun', { month: monthLabel(r.month, locale) }), danger: true })).ok)
                            act.mutate(() => api.post(`/assets/depreciation/runs/${r.id}/undo`), { onSuccess: () => toast.success(t('common.saved')), onError: (e) => toast.error(errText(e)) });
                        }}
                      >
                        {t('fa.undo')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ categories

function CategoryDialog({ open, onClose, cat }: { open: boolean; onClose(): void; cat: Category | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const empty = { nameEn: '', nameAr: '', assetAccountId: null as number | null, accumAccountId: null as number | null, expenseAccountId: null as number | null, method: 'straight_line' as Category['method'], lifeMonths: 60 as number | null, residualBp: 0 as number | null, isActive: true };
  const [f, setF] = useState(empty);
  useEffect(() => {
    if (open)
      setF(
        cat
          ? { nameEn: cat.name_en, nameAr: cat.name_ar, assetAccountId: cat.asset_account_id, accumAccountId: cat.accum_account_id, expenseAccountId: cat.expense_account_id, method: cat.method, lifeMonths: cat.life_months, residualBp: cat.residual_bp, isActive: !!cat.is_active }
          : empty,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cat]);
  const save = useApiMutation(() => (cat ? api.put(`/assets/categories/${cat.id}`, { ...f, lifeMonths: f.lifeMonths ?? 0, residualBp: f.residualBp ?? 0 }) : api.post('/assets/categories', { ...f, lifeMonths: f.lifeMonths ?? 0, residualBp: f.residualBp ?? 0 })));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={cat ? t('fa.editCategory') : t('fa.newCategory')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => toast.error(errText(e)) })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.nameEn')}>
            <Input value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input value={f.nameAr} dir="rtl" onChange={(e) => setF({ ...f, nameAr: e.target.value })} />
          </Field>
        </div>
        <Field label={t('fa.assetAccount')}>
          <AccountPicker value={f.assetAccountId} filter={(a) => a.subtype === 'fixed_asset'} onChange={(v) => setF({ ...f, assetAccountId: v })} />
        </Field>
        <div className="grid-2">
          <Field label={t('fa.accumAccount')}>
            <AccountPicker value={f.accumAccountId} filter={(a) => a.subtype === 'accumulated_depreciation'} onChange={(v) => setF({ ...f, accumAccountId: v })} />
          </Field>
          <Field label={t('fa.expenseAccount')}>
            <AccountPicker value={f.expenseAccountId} filter={(a) => a.subtype === 'depreciation'} onChange={(v) => setF({ ...f, expenseAccountId: v })} />
          </Field>
        </div>
        <div className="grid-3">
          <Field label={t('fa.method')}>
            <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as Category['method'] })}>
              <option value="straight_line">{t('fa.methods.straight_line')}</option>
              <option value="declining">{t('fa.methods.declining')}</option>
            </Select>
          </Field>
          <Field label={t('fa.life')}>
            <DecimalInput scale={0} trim value={f.lifeMonths} onChange={(v) => setF({ ...f, lifeMonths: v })} />
          </Field>
          <Field label={t('fa.residualPct')}>
            <DecimalInput scale={2} trim value={f.residualBp} onChange={(v) => setF({ ...f, residualBp: v })} />
          </Field>
        </div>
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
      </div>
    </Dialog>
  );
}

function CategoriesPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { data, isLoading } = useApi<Category[]>('/assets/categories');
  const [editing, setEditing] = useState<{ cat: Category | null } | null>(null);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/fixed-assets', label: t('fa.register') }]}
        title={t('fa.categories')}
        subtitle={t('fa.categoriesSub')}
        actions={
          can('assets.register.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ cat: null })}>
              {t('fa.newCategory')}
            </Button>
          )
        }
      />
      <Card>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<FolderCog size={22} />} title={t('fa.noCategories')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('fa.method')}</th>
                <th className="end">{t('fa.life')}</th>
                <th className="end">{t('fa.residualPct')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => can('assets.register.write') && setEditing({ cat: c })}>
                  <td>
                    <strong>{pick(c.name_en, c.name_ar)}</strong>
                  </td>
                  <td>{t('fa.methods.' + c.method)}</td>
                  <td className="end">{lifeText(c.life_months, t)}</td>
                  <td className="end num">{(c.residual_bp / 100).toFixed(2)}%</td>
                  <td>
                    <Badge tone={c.is_active ? 'green' : 'neutral'}>{t(c.is_active ? 'common.active' : 'common.inactive')}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <CategoryDialog open={!!editing} cat={editing?.cat ?? null} onClose={() => setEditing(null)} />
    </div>
  );
}

// ---------------------------------------------------------------- report

function ReportPage() {
  const { t, pick } = useI18n();
  const { fmt } = useMoney();
  const { from, to, set } = usePeriod('thisYear');
  const { data: r } = useApi<any>('/assets/report', { from, to });
  const cols: [string, string][] = [
    ['costOpening', 'fa.r.costOpening'],
    ['additions', 'fa.r.additions'],
    ['disposals', 'fa.r.disposals'],
    ['costClosing', 'fa.r.costClosing'],
    ['accOpening', 'fa.r.accOpening'],
    ['charge', 'fa.r.charge'],
    ['accAdditions', 'fa.r.accAdditions'],
    ['accDisposals', 'fa.r.accDisposals'],
    ['accClosing', 'fa.r.accClosing'],
    ['nbvClosing', 'fa.r.nbvClosing'],
  ];
  const shown = r ? cols.filter(([k]) => k !== 'accAdditions' || r.totals.accAdditions !== 0) : cols;
  const minus = new Set(['disposals', 'accDisposals']);
  return (
    <div className="page">
      <PageHeader title={t('fa.report')} subtitle={t('fa.reportSub')} />
      <div style={{ marginBottom: 16 }}>
        <PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />
      </div>
      {!r ? (
        <Loading />
      ) : r.rows.length === 0 ? (
        <Card>
          <EmptyState icon={<LineChart size={22} />} title={t('fa.noMovement')} />
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th />
                  {r.rows.map((x: any) => (
                    <th key={x.id} className="end">
                      {pick(x.name_en, x.name_ar)}
                    </th>
                  ))}
                  <th className="end">{t('common.total')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(([k, label]) => (
                  <tr key={k} className={['costClosing', 'accClosing', 'nbvClosing'].includes(k) ? 'grand-row' : undefined}>
                    <td>{t(label)}</td>
                    {r.rows.map((x: any) => (
                      <td key={x.id} className="end num">
                        {x[k] ? (minus.has(k) ? `(${fmt(x[k])})` : fmt(x[k])) : '—'}
                      </td>
                    ))}
                    <td className="end num">{minus.has(k) && r.totals[k] ? `(${fmt(r.totals[k])})` : fmt(r.totals[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12.5, padding: '0 16px 12px', margin: 0 }}>{t('fa.reportHint')}</p>
        </Card>
      )}
    </div>
  );
}

export const assetsModule: WebModule = {
  id: 'assets',
  nav: [
    { to: '/fixed-assets', label: 'fa.register', icon: Building2, section: 'assets', order: 10, perm: 'assets.register.read', app: 'assets' },
    { to: '/fixed-assets/depreciation', label: 'fa.depreciationRuns', icon: CalendarCheck, section: 'assets', order: 20, perm: 'assets.register.read', app: 'assets' },
    { to: '/fixed-assets/categories', label: 'fa.categories', icon: FolderCog, section: 'assets', order: 30, perm: 'assets.register.read', app: 'assets' },
    { to: '/fixed-assets/report', label: 'fa.report', icon: LineChart, section: 'assets', order: 40, perm: 'assets.reports.read', app: 'assets' },
  ],
  routes: [
    { path: '/fixed-assets', element: <RegisterPage /> },
    { path: '/fixed-assets/depreciation', element: <DepreciationPage /> },
    { path: '/fixed-assets/categories', element: <CategoriesPage /> },
    { path: '/fixed-assets/report', element: <ReportPage /> },
    { path: '/fixed-assets/:id', element: <AssetPage />, perm: 'assets.register.read', app: 'assets' },
  ],
  commands: [{ id: 'go-assets', label: 'fa.register', icon: Building2, group: 'navigate', to: '/fixed-assets', perm: 'assets.register.read', app: 'assets', keywords: 'fixed assets depreciation أصول ثابتة إهلاك' }],
  reports: [{ to: '/fixed-assets/report', group: 'reports.groups.statements', title: 'fa.report', desc: 'fa.reportSub', icon: LineChart, color: 'var(--line-blue)', perm: 'assets.reports.read', app: 'assets' }],
};
