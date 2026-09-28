import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Banknote, CheckCircle2, Landmark, Layers, Pencil, Plus, Printer, RefreshCw, Save, Trash2, Undo2, UserPlus, Users, Wallet } from 'lucide-react';
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
import { AccountPicker } from '../../ui/Pickers';
import { CostCenterSelect, useCostCenters } from '../../ui/CostCenter';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';

type Kind = 'earning' | 'deduction' | 'employer';
type Calc = 'fixed' | 'percent_basic' | 'percent_gross' | 'percent_insurable' | 'tax';
interface Component {
  id: number;
  name_en: string;
  name_ar: string;
  kind: Kind;
  calc: Calc;
  value: number;
  pre_tax: number;
  prorate: number;
  applies_to_all: number;
  cap: number;
  floor: number;
  tax_rule: 'eg_2024' | null;
  exemption: number;
  brackets: { upTo: number | null; rateBp: number }[];
  expense_account_id: number | null;
  liability_account_id: number | null;
  is_active: number;
  sort: number;
}
interface Employee {
  id: number;
  code: string;
  name: string;
  name_alt: string | null;
  national_id: string | null;
  job_title: string | null;
  department: string | null;
  hire_date: string;
  end_date: string | null;
  basic_salary: number;
  insurable_wage: number | null;
  cost_center_id: number | null;
  bank_account: string | null;
  payment_method: 'bank' | 'cash';
  is_active: number;
  notes: string | null;
}
interface SlipLine {
  componentId: number | null;
  name: string;
  kind: Kind | 'basic' | 'adjustment';
  amount: number;
}
interface RunLine {
  id: number;
  employee_id: number;
  code: string;
  name: string;
  job_title: string | null;
  department: string | null;
  national_id: string | null;
  bank_account: string | null;
  payment_method: string;
  days: number;
  of_days: number;
  basic: number;
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  bonus: number;
  other_deduction: number;
  note: string | null;
  details: SlipLine[];
}
interface Run {
  id: number;
  month: string;
  pay_date: string;
  status: 'draft' | 'posted' | 'paid';
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  entry_id: number | null;
  payment_entry_id: number | null;
  paid_date: string | null;
  employees?: number;
}

const monthLabel = (m: string, locale: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { month: 'long', year: 'numeric' });
const statusTone = (s: string) => (s === 'paid' ? 'green' : s === 'posted' ? 'blue' : 'amber');

/** A payslip line's name: the component's in the user's language, the fixed ones translated. */
function useSlipName(components: { id: number; name_en: string; name_ar: string }[]) {
  const { t, pick } = useI18n();
  return (l: SlipLine) => {
    if (l.kind === 'basic') return t('pay.basic');
    if (l.kind === 'adjustment') return l.amount >= 0 ? t('pay.bonus') : t('pay.otherDeduction');
    const c = components.find((x) => x.id === l.componentId);
    return c ? pick(c.name_en, c.name_ar) : l.name;
  };
}

// -------------------------------------------------------------- employees

function EmployeesPage() {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Employee[]>('/payroll/employees');
  const columns = useMemo<Column<Employee>[]>(
    () => [
      { id: 'code', header: t('common.code'), pinned: true, value: (e) => e.code, render: (e) => <span className="num">{e.code}</span> },
      { id: 'name', header: t('common.name'), value: (e) => e.name, render: (e) => <strong>{e.name}</strong> },
      { id: 'job', header: t('pay.jobTitle'), value: (e) => e.job_title },
      { id: 'dept', header: t('pay.department'), type: 'enum', value: (e) => e.department },
      { id: 'hire', header: t('pay.hireDate'), type: 'date', value: (e) => e.hire_date, render: (e) => formatDate(e.hire_date, locale) },
      { id: 'basic', header: t('pay.basic'), type: 'number', value: (e) => e.basic_salary, render: (e) => <span className="num">{fmt(e.basic_salary)}</span> },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (e) => (e.end_date && e.end_date < todayIso() ? 'left' : e.is_active ? 'active' : 'inactive'),
        format: (v) => t('pay.empStatus.' + v),
        render: (e) => {
          const s = e.end_date && e.end_date < todayIso() ? 'left' : e.is_active ? 'active' : 'inactive';
          return <Badge tone={s === 'active' ? 'green' : 'neutral'}>{t('pay.empStatus.' + s)}</Badge>;
        },
      },
    ],
    [t, fmt, locale],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('pay.employees')}
        subtitle={t('pay.employeesSub')}
        actions={
          can('payroll.employees.write') && (
            <Link to="/payroll/employees/new" className="btn btn-primary">
              <UserPlus /> {t('pay.newEmployee')}
            </Link>
          )
        }
      />
      <DataGrid
        id="pay-employees"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(e) => e.id}
        onRowClick={(e) => navigate(`/payroll/employees/${e.id}`)}
        exportName={t('pay.employees')}
        empty={<EmptyState icon={<Users size={22} />} title={t('pay.noEmployees')} text={t('pay.noEmployeesText')} />}
      />
    </div>
  );
}

function EmployeePage() {
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
  const { data: e, isLoading } = useApi<
    Employee & {
      components: { component_id: number; value: number | null; excluded: number }[];
      preview: { gross: number; deductions: number; net: number; employer: number; lines: SlipLine[] };
      history: { run_id: number; month: string; status: string; gross: number; net: number }[];
    }
  >(isNew ? null : `/payroll/employees/${id}`);
  const { data: comps } = useApi<Component[]>('/payroll/components');
  const slipName = useSlipName(comps ?? []);
  const blank = {
    name: '',
    nameAlt: '',
    nationalId: '',
    jobTitle: '',
    department: '',
    hireDate: todayIso(),
    endDate: '',
    basicSalary: null as number | null,
    insurableWage: null as number | null,
    costCenterId: null as number | null,
    bankAccount: '',
    paymentMethod: 'bank' as 'bank' | 'cash',
    isActive: true,
    notes: '',
  };
  const [f, setF] = useState(blank);
  const [own, setOwn] = useState<Record<number, { value: number | null; excluded: boolean; on: boolean }>>({});
  useEffect(() => {
    if (!e) return;
    setF({
      name: e.name,
      nameAlt: e.name_alt ?? '',
      nationalId: e.national_id ?? '',
      jobTitle: e.job_title ?? '',
      department: e.department ?? '',
      hireDate: e.hire_date,
      endDate: e.end_date ?? '',
      basicSalary: e.basic_salary,
      insurableWage: e.insurable_wage,
      costCenterId: e.cost_center_id,
      bankAccount: e.bank_account ?? '',
      paymentMethod: e.payment_method,
      isActive: !!e.is_active,
      notes: e.notes ?? '',
    });
    setOwn(Object.fromEntries(e.components.map((c) => [c.component_id, { value: c.value, excluded: !!c.excluded, on: true }])));
  }, [e]);
  const writable = can('payroll.employees.write');
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const body = () => ({
    name: f.name,
    nameAlt: f.nameAlt || null,
    nationalId: f.nationalId || null,
    jobTitle: f.jobTitle || null,
    department: f.department || null,
    hireDate: f.hireDate,
    endDate: f.endDate || null,
    basicSalary: f.basicSalary ?? 0,
    insurableWage: f.insurableWage,
    costCenterId: f.costCenterId,
    bankAccount: f.bankAccount || null,
    paymentMethod: f.paymentMethod,
    isActive: f.isActive,
    notes: f.notes || null,
    components: Object.entries(own)
      .filter(([, v]) => v.on)
      .map(([k, v]) => ({ componentId: Number(k), value: v.value, excluded: v.excluded })),
  });
  if (!isNew && (isLoading || !e)) return <Loading />;
  const applies = (c: Component) => {
    const o = own[c.id];
    return o?.on ? !o.excluded : !!c.applies_to_all;
  };
  const valueScale = (c: Component) => (c.calc === 'fixed' ? scale : 2);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/payroll/employees', label: t('pay.employees') }]}
        title={isNew ? t('pay.newEmployee') : `${e!.code} · ${e!.name}`}
        actions={
          writable && (
            <>
              {!isNew && !e!.history.length && (
                <Button
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('pay.deleteEmployee'), danger: true, confirmLabel: t('common.delete') })).ok)
                      act.mutate(() => api.del(`/payroll/employees/${id}`), { onSuccess: () => navigate('/payroll/employees'), onError: (x) => toast.error(errText(x)) });
                  }}
                />
              )}
              <Button
                variant="primary"
                icon={<Save />}
                loading={act.isPending}
                onClick={() =>
                  act.mutate(() => (isNew ? api.post<{ id: number }>('/payroll/employees', body()) : api.put(`/payroll/employees/${id}`, body())), {
                    onSuccess: (r: any) => (toast.success(t('common.saved')), isNew && navigate(`/payroll/employees/${r.id}`, { replace: true })),
                    onError: (x) => toast.error(errText(x)),
                  })
                }
              >
                {t('common.save')}
              </Button>
            </>
          )
        }
      />
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Card pad>
          <div className="stack">
            <div className="grid-2">
              <Field label={t('common.name')}>
                <Input value={f.name} autoFocus={isNew} onChange={(x) => setF({ ...f, name: x.target.value })} />
              </Field>
              <Field label={t('pay.nameAlt')}>
                <Input value={f.nameAlt} onChange={(x) => setF({ ...f, nameAlt: x.target.value })} />
              </Field>
            </div>
            <div className="grid-3">
              <Field label={t('pay.jobTitle')}>
                <Input value={f.jobTitle} onChange={(x) => setF({ ...f, jobTitle: x.target.value })} />
              </Field>
              <Field label={t('pay.department')}>
                <Input value={f.department} onChange={(x) => setF({ ...f, department: x.target.value })} />
              </Field>
              <Field label={t('pay.nationalId')}>
                <Input value={f.nationalId} onChange={(x) => setF({ ...f, nationalId: x.target.value })} />
              </Field>
            </div>
            <div className="grid-3">
              <Field label={t('pay.hireDate')}>
                <Input type="date" value={f.hireDate} onChange={(x) => setF({ ...f, hireDate: x.target.value })} />
              </Field>
              <Field label={t('pay.endDate')} hint={t('pay.endDateHint')}>
                <Input type="date" value={f.endDate} onChange={(x) => setF({ ...f, endDate: x.target.value })} />
              </Field>
              <Field label={t('pay.basicSalary')}>
                <DecimalInput scale={scale} value={f.basicSalary} onChange={(v) => setF({ ...f, basicSalary: v })} />
              </Field>
            </div>
            <div className="grid-3">
              <Field label={t('pay.insurableWage')} hint={t('pay.insurableWageHint')}>
                <DecimalInput scale={scale} value={f.insurableWage} placeholder={t('pay.insurableWageNone')} onChange={(v) => setF({ ...f, insurableWage: v })} />
              </Field>
            </div>
            <div className="grid-3">
              <Field label={t('pay.paymentMethod')}>
                <Select value={f.paymentMethod} onChange={(x) => setF({ ...f, paymentMethod: x.target.value as 'bank' | 'cash' })}>
                  <option value="bank">{t('pay.methods.bank')}</option>
                  <option value="cash">{t('pay.methods.cash')}</option>
                </Select>
              </Field>
              <Field label={t('pay.bankAccount')}>
                <Input value={f.bankAccount} onChange={(x) => setF({ ...f, bankAccount: x.target.value })} />
              </Field>
              {cc.on && (
                <Field label={t('co.costCenter')}>
                  <CostCenterSelect value={f.costCenterId} onChange={(v) => setF({ ...f, costCenterId: v })} list={cc.list} />
                </Field>
              )}
            </div>
            <Field label={t('common.notes')}>
              <Textarea rows={2} value={f.notes} onChange={(x) => setF({ ...f, notes: x.target.value })} />
            </Field>
            <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
          </div>
        </Card>
        <div className="stack">
          <Card>
            <CardHeader title={t('pay.components')} sub={t('pay.componentsForEmployee')} />
            {!comps?.length ? (
              <EmptyState title={t('pay.noComponents')} action={<Link to="/payroll/components">{t('pay.setupComponents')}</Link>} />
            ) : (
              <table className="table table-compact">
                <tbody>
                  {comps
                    .filter((c) => c.is_active)
                    .map((c) => {
                      const o = own[c.id];
                      const on = applies(c);
                      return (
                        <tr key={c.id}>
                          <td>
                            <Checkbox
                              label={pick(c.name_en, c.name_ar)}
                              checked={on}
                              disabled={!writable}
                              onChange={(v) => setOwn({ ...own, [c.id]: { value: o?.value ?? null, excluded: !v, on: v !== !!c.applies_to_all || (o?.value ?? null) != null } })}
                            />
                          </td>
                          <td className="faint">{t('pay.kinds.' + c.kind)}</td>
                          <td style={{ width: 150 }}>
                            {on && c.calc !== 'tax' && (
                              <DecimalInput
                                sm
                                scale={valueScale(c)}
                                trim={c.calc !== 'fixed'}
                                value={o?.value ?? null}
                                placeholder={c.calc === 'fixed' ? fmt(c.value) : `${c.value / 100}%`}
                                onChange={(v) => setOwn({ ...own, [c.id]: { value: v, excluded: false, on: true } })}
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </Card>
          {e && (
            <Card>
              <CardHeader title={t('pay.thisMonth')} sub={t('pay.thisMonthSub')} />
              <table className="table table-compact">
                <tbody>
                  {e.preview.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{slipName(l)}</td>
                      <td className="faint">{l.kind === 'basic' ? '' : t('pay.kinds.' + (l.kind === 'adjustment' ? 'earning' : l.kind))}</td>
                      <td className={`end num ${l.kind === 'deduction' ? 'danger-text' : ''}`}>{l.kind === 'deduction' ? `(${fmt(l.amount)})` : fmt(l.amount)}</td>
                    </tr>
                  ))}
                  <tr className="grand-row">
                    <td colSpan={2}>{t('pay.net')}</td>
                    <td className="end num">{fmt(e.preview.net)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          )}
          {e && e.history.length > 0 && (
            <Card>
              <CardHeader title={t('pay.history')} />
              <table className="table table-compact">
                <tbody>
                  {e.history.map((h) => (
                    <tr key={h.run_id}>
                      <td>
                        <Link to={`/payroll/runs/${h.run_id}`}>{monthLabel(h.month, locale)}</Link>
                      </td>
                      <td>
                        <Badge plain tone={statusTone(h.status)}>
                          {t('pay.status.' + h.status)}
                        </Badge>
                      </td>
                      <td className="end num">{fmt(h.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- components

function ComponentDialog({ open, onClose, comp }: { open: boolean; onClose(): void; comp: Component | null }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const empty = {
    nameEn: '',
    nameAr: '',
    kind: 'earning' as Kind,
    calc: 'fixed' as Calc,
    value: 0 as number | null,
    preTax: false,
    prorate: true,
    appliesToAll: true,
    cap: 0 as number | null,
    floor: 0 as number | null,
    taxRule: null as 'eg_2024' | null,
    exemption: 0 as number | null,
    brackets: [] as { upTo: number | null; rateBp: number | null }[],
    expenseAccountId: null as number | null,
    liabilityAccountId: null as number | null,
    isActive: true,
    sort: 0,
  };
  const [f, setF] = useState(empty);
  useEffect(() => {
    if (!open) return;
    setF(
      comp
        ? {
            nameEn: comp.name_en,
            nameAr: comp.name_ar,
            kind: comp.kind,
            calc: comp.calc,
            value: comp.value,
            preTax: !!comp.pre_tax,
            prorate: !!comp.prorate,
            appliesToAll: !!comp.applies_to_all,
            cap: comp.cap,
            floor: comp.floor,
            taxRule: comp.tax_rule,
            exemption: comp.exemption,
            brackets: comp.brackets,
            expenseAccountId: comp.expense_account_id,
            liabilityAccountId: comp.liability_account_id,
            isActive: !!comp.is_active,
            sort: comp.sort,
          }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, comp]);
  const save = useApiMutation(() => {
    const body = { ...f, value: f.value ?? 0, cap: f.cap ?? 0, floor: f.floor ?? 0, exemption: f.exemption ?? 0, brackets: f.brackets.map((b) => ({ upTo: b.upTo, rateBp: b.rateBp ?? 0 })) };
    return comp ? api.put(`/payroll/components/${comp.id}`, body) : api.post('/payroll/components', body);
  });
  const pct = f.calc === 'percent_basic' || f.calc === 'percent_gross' || f.calc === 'percent_insurable';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={comp ? t('pay.editComponent') : t('pay.newComponent')}
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
        <div className="grid-3">
          <Field label={t('pay.kind')}>
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind, calc: e.target.value !== 'deduction' && f.calc === 'tax' ? 'fixed' : f.calc })}>
              {(['earning', 'deduction', 'employer'] as const).map((k) => (
                <option key={k} value={k}>
                  {t('pay.kinds.' + k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('pay.calc')}>
            <Select value={f.calc} onChange={(e) => setF({ ...f, calc: e.target.value as Calc })}>
              <option value="fixed">{t('pay.calcs.fixed')}</option>
              <option value="percent_basic">{t('pay.calcs.percent_basic')}</option>
              {f.kind !== 'earning' && <option value="percent_gross">{t('pay.calcs.percent_gross')}</option>}
              {f.kind !== 'earning' && <option value="percent_insurable">{t('pay.calcs.percent_insurable')}</option>}
              {f.kind === 'deduction' && <option value="tax">{t('pay.calcs.tax')}</option>}
            </Select>
          </Field>
          {f.calc !== 'tax' && (
            <Field label={pct ? t('pay.rate') : t('common.amount')}>
              <DecimalInput scale={pct ? 2 : scale} trim={pct} value={f.value} onChange={(v) => setF({ ...f, value: v })} />
            </Field>
          )}
        </div>
        {pct && (
          <div className="grid-2">
            <Field label={t('pay.floor')} hint={t('pay.floorHint')}>
              <DecimalInput scale={scale} value={f.floor} onChange={(v) => setF({ ...f, floor: v })} />
            </Field>
            <Field label={t('pay.cap')} hint={t('pay.capHint')}>
              <DecimalInput scale={scale} value={f.cap} onChange={(v) => setF({ ...f, cap: v })} />
            </Field>
          </div>
        )}
        {f.calc === 'tax' && (
          <div className="stack" style={{ gap: 8 }}>
            <Field label={t('pay.taxRule')} hint={f.taxRule ? t('pay.taxRuleEgHint') : undefined}>
              <Select value={f.taxRule ?? ''} onChange={(e) => setF({ ...f, taxRule: (e.target.value || null) as 'eg_2024' | null })}>
                <option value="">{t('pay.taxRuleOwn')}</option>
                <option value="eg_2024">{t('pay.taxRuleEg')}</option>
              </Select>
            </Field>
            <Field label={t('pay.exemption')} hint={t('pay.exemptionHint')}>
              <DecimalInput scale={scale} value={f.exemption} onChange={(v) => setF({ ...f, exemption: v })} />
            </Field>
            {!f.taxRule && (
              <>
                <strong style={{ fontSize: 13 }}>{t('pay.brackets')}</strong>
                <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
                  {t('pay.bracketsHint')}
                </p>
                {f.brackets.map((b, i) => (
                  <div key={i} className="row" style={{ gap: 8 }}>
                    <DecimalInput sm scale={scale} value={b.upTo} placeholder={t('pay.noLimit')} onChange={(v) => setF({ ...f, brackets: f.brackets.map((x, j) => (j === i ? { ...x, upTo: v } : x)) })} />
                    <DecimalInput sm scale={2} trim value={b.rateBp} placeholder="%" onChange={(v) => setF({ ...f, brackets: f.brackets.map((x, j) => (j === i ? { ...x, rateBp: v } : x)) })} />
                    <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setF({ ...f, brackets: f.brackets.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setF({ ...f, brackets: [...f.brackets, { upTo: null, rateBp: null }] })}>
                  {t('pay.addBracket')}
                </Button>
              </>
            )}
          </div>
        )}
        <div className="grid-2">
          {f.kind !== 'deduction' && (
            <Field label={t('pay.expenseAccount')} hint={t('pay.expenseAccountHint')}>
              <AccountPicker value={f.expenseAccountId} filter={(a) => a.type === 'expense'} onChange={(v) => setF({ ...f, expenseAccountId: v })} />
            </Field>
          )}
          {f.kind !== 'earning' && (
            <Field label={t('pay.liabilityAccount')} hint={t('pay.liabilityAccountHint')}>
              <AccountPicker value={f.liabilityAccountId} filter={(a) => (a.type === 'liability' || a.type === 'asset') && a.subtype !== 'payable' && a.subtype !== 'receivable'} onChange={(v) => setF({ ...f, liabilityAccountId: v })} />
            </Field>
          )}
        </div>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <Checkbox label={t('pay.appliesToAll')} checked={f.appliesToAll} onChange={(v) => setF({ ...f, appliesToAll: v })} />
          {f.calc === 'fixed' && <Checkbox label={t('pay.prorate')} checked={f.prorate} onChange={(v) => setF({ ...f, prorate: v })} />}
          {f.kind === 'deduction' && f.calc !== 'tax' && <Checkbox label={t('pay.preTax')} checked={f.preTax} onChange={(v) => setF({ ...f, preTax: v })} />}
          <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
        </div>
      </div>
    </Dialog>
  );
}

function ComponentsPage() {
  const { t, pick } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const { data, isLoading } = useApi<Component[]>('/payroll/components');
  const [editing, setEditing] = useState<{ comp: Component | null } | null>(null);
  const valueText = (c: Component) => (c.calc === 'fixed' ? fmt(c.value) : c.calc === 'tax' ? (c.tax_rule ? t('pay.taxRuleEg') : t('pay.bracketsCount', { n: c.brackets.length })) : `${c.value / 100}%`);
  const toast = useToast();
  const errText = useErrorText();
  const egypt = useApiMutation(() => api.post('/payroll/components/egypt', {}));
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/payroll/runs', label: t('pay.runs') }]}
        title={t('pay.components')}
        subtitle={t('pay.componentsSub')}
        actions={
          can('payroll.settings.manage') && (
            <>
              {!data?.some((c) => c.tax_rule || c.calc === 'percent_insurable') && (
                <Button icon={<Landmark />} loading={egypt.isPending} onClick={() => egypt.mutate(undefined, { onSuccess: () => toast.success(t('pay.egyptDone')), onError: (e) => toast.error(errText(e)) })}>
                  {t('pay.egyptSetup')}
                </Button>
              )}
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ comp: null })}>
                {t('pay.newComponent')}
              </Button>
            </>
          )
        }
      />
      <Card>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<Layers size={22} />} title={t('pay.noComponents')} text={t('pay.noComponentsText')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('pay.kind')}</th>
                <th>{t('pay.calc')}</th>
                <th className="end">{t('pay.value')}</th>
                <th>{t('pay.appliesToAll')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => can('payroll.settings.manage') && setEditing({ comp: c })}>
                  <td>
                    <strong>{pick(c.name_en, c.name_ar)}</strong>
                    {!!c.pre_tax && (
                      <Badge plain tone="cyan">
                        {t('pay.preTaxShort')}
                      </Badge>
                    )}
                  </td>
                  <td>
                    <Badge tone={c.kind === 'earning' ? 'green' : c.kind === 'deduction' ? 'red' : 'blue'}>{t('pay.kinds.' + c.kind)}</Badge>
                  </td>
                  <td>{t('pay.calcs.' + c.calc)}</td>
                  <td className="end num">{valueText(c)}</td>
                  <td>{c.applies_to_all ? t('common.yes') : t('common.no')}</td>
                  <td>
                    <Badge tone={c.is_active ? 'green' : 'neutral'}>{t(c.is_active ? 'common.active' : 'common.inactive')}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <ComponentDialog open={!!editing} comp={editing?.comp ?? null} onClose={() => setEditing(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ runs

function NewRunDialog({ open, onClose, last }: { open: boolean; onClose(): void; last: string | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const errText = useErrorText();
  const next = () => {
    if (!last) return todayIso().slice(0, 7);
    const [y, m] = last.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };
  const [f, setF] = useState({ month: next(), payDate: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setErr('');
      setF({ month: next(), payDate: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, last]);
  const save = useApiMutation(() => api.post<{ id: number }>('/payroll/runs', { month: f.month, payDate: f.payDate || null }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pay.newRun')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (r) => (onClose(), navigate(`/payroll/runs/${r.id}`)), onError: (e) => setErr(errText(e)) })}>
            {t('pay.prepare')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('pay.month')}>
            <Input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
          </Field>
          <Field label={t('pay.payDate')} hint={t('pay.payDateHint')}>
            <Input type="date" value={f.payDate} onChange={(e) => setF({ ...f, payDate: e.target.value })} />
          </Field>
        </div>
        <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
          {t('pay.newRunHint')}
        </p>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function RunsPage() {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Run[]>('/payroll/runs');
  const [creating, setCreating] = useState(false);
  const columns = useMemo<Column<Run>[]>(
    () => [
      { id: 'month', header: t('pay.month'), pinned: true, value: (r) => r.month, render: (r) => <strong>{monthLabel(r.month, locale)}</strong> },
      { id: 'n', header: t('pay.employees'), type: 'number', value: (r) => r.employees ?? 0 },
      { id: 'gross', header: t('pay.gross'), type: 'number', value: (r) => r.gross, render: (r) => <span className="num">{fmt(r.gross)}</span> },
      { id: 'ded', header: t('pay.deductions'), type: 'number', value: (r) => r.deductions, render: (r) => <span className="num">{fmt(r.deductions)}</span> },
      { id: 'net', header: t('pay.net'), type: 'number', value: (r) => r.net, render: (r) => <strong className="num">{fmt(r.net)}</strong> },
      { id: 'employer', header: t('pay.employer'), type: 'number', value: (r) => r.employer, render: (r) => <span className="num">{fmt(r.employer)}</span> },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('pay.status.' + v), render: (r) => <Badge tone={statusTone(r.status)}>{t('pay.status.' + r.status)}</Badge> },
    ],
    [t, fmt, locale],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('pay.runs')}
        subtitle={t('pay.runsSub')}
        actions={
          <>
            <Link to="/payroll/components" className="btn">
              <Layers /> {t('pay.components')}
            </Link>
            {can('payroll.runs.write') && (
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                {t('pay.newRun')}
              </Button>
            )}
          </>
        }
      />
      <DataGrid
        id="pay-runs"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/payroll/runs/${r.id}`)}
        exportName={t('pay.runs')}
        empty={<EmptyState icon={<Wallet size={22} />} title={t('pay.noRuns')} text={t('pay.noRunsText')} />}
      />
      <NewRunDialog open={creating} onClose={() => setCreating(false)} last={data?.[0]?.month ?? null} />
    </div>
  );
}

function Payslip({ run, line, components }: { run: Run; line: RunLine; components: Component[] }) {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const slipName = useSlipName(components);
  const earnings = line.details.filter((l) => l.kind === 'basic' || l.kind === 'earning' || (l.kind === 'adjustment' && l.amount > 0));
  const deductions = line.details.filter((l) => l.kind === 'deduction' || (l.kind === 'adjustment' && l.amount < 0));
  return (
    <div className="payslip">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <strong style={{ fontSize: 16 }}>{line.name}</strong>
          <div className="faint">
            {line.code}
            {line.job_title ? ` · ${line.job_title}` : ''}
            {line.department ? ` · ${line.department}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'end' }}>
          <strong>{t('pay.payslipFor', { month: monthLabel(run.month, locale) })}</strong>
          <div className="faint">{t('pay.daysWorked', { days: line.days, of: line.of_days })}</div>
        </div>
      </div>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t('pay.earnings')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {earnings.map((l, i) => (
              <tr key={i}>
                <td>{slipName(l)}</td>
                <td className="end num">{fmt(l.amount)}</td>
              </tr>
            ))}
            <tr className="grand-row">
              <td>{t('pay.gross')}</td>
              <td className="end num">{fmt(line.gross)}</td>
            </tr>
          </tbody>
        </table>
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t('pay.deductions')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deductions.map((l, i) => (
              <tr key={i}>
                <td>{slipName(l)}</td>
                <td className="end num">{fmt(Math.abs(l.amount))}</td>
              </tr>
            ))}
            <tr className="grand-row">
              <td>{t('pay.deductions')}</td>
              <td className="end num">{fmt(line.deductions)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="kpi-strip" style={{ marginTop: 12 }}>
        <div>
          <span>{t('pay.net')}</span>
          <strong>{fmt(line.net)}</strong>
          <small className="faint">{line.payment_method === 'bank' && line.bank_account ? `${t('pay.methods.bank')} · ${line.bank_account}` : t('pay.methods.' + line.payment_method)}</small>
        </div>
      </div>
      {line.note && <p className="faint">{line.note}</p>}
    </div>
  );
}

function AdjustDialog({ run, line, onClose }: { run: Run; line: RunLine | null; onClose(): void }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState({ bonus: 0 as number | null, otherDeduction: 0 as number | null, note: '' });
  useEffect(() => {
    if (line) setF({ bonus: line.bonus, otherDeduction: line.other_deduction, note: line.note ?? '' });
  }, [line]);
  const save = useApiMutation(() => api.put(`/payroll/runs/${run.id}/lines/${line!.id}`, { bonus: f.bonus ?? 0, otherDeduction: f.otherDeduction ?? 0, note: f.note || null }));
  return (
    <Dialog
      open={!!line}
      onClose={onClose}
      title={line ? t('pay.adjustFor', { name: line.name }) : ''}
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
          <Field label={t('pay.bonus')} hint={t('pay.bonusHint')}>
            <DecimalInput scale={scale} value={f.bonus} onChange={(v) => setF({ ...f, bonus: v })} />
          </Field>
          <Field label={t('pay.otherDeduction')} hint={t('pay.otherDeductionHint')}>
            <DecimalInput scale={scale} value={f.otherDeduction} onChange={(v) => setF({ ...f, otherDeduction: v })} />
          </Field>
        </div>
        <Field label={t('common.notes')}>
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function PayDialog({ run, open, onClose }: { run: Run; open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const { fmt } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState({ date: run.pay_date, accountId: null as number | null });
  const save = useApiMutation(() => api.post(`/payroll/runs/${run.id}/pay`, f));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pay.pay')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!f.accountId} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('pay.paid')), onClose()), onError: (e) => toast.error(errText(e)) })}>
            {t('pay.payAmount', { amount: fmt(run.net) })}
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label={t('common.date')}>
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label={t('pay.fromAccount')}>
          <AccountPicker value={f.accountId} filter={(a) => (a.subtype === 'bank' || a.subtype === 'cash') && !a.currency} onChange={(v) => setF({ ...f, accountId: v })} />
        </Field>
      </div>
    </Dialog>
  );
}

function RunPage() {
  const { id } = useParams();
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: r, isLoading } = useApi<Run & { lines: RunLine[]; components: Component[]; journal: { accountId: number; debit: number; credit: number; description: string }[] | null }>(`/payroll/runs/${id}`);
  const { data: accounts } = useApi<{ id: number; code: string; name_en: string; name_ar: string }[]>('/accounts');
  const [adjusting, setAdjusting] = useState<RunLine | null>(null);
  const [slip, setSlip] = useState<RunLine | null>(null);
  const [paying, setPaying] = useState(false);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading || !r) return <Loading />;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) => act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (e) => toast.error(errText(e)) });
  const draft = r.status === 'draft';
  const accName = (aid: number) => {
    const a = accounts?.find((x) => x.id === aid);
    return a ? `${a.code} · ${pick(a.name_en, a.name_ar)}` : String(aid);
  };
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/payroll/runs', label: t('pay.runs') }]}
        title={t('pay.runTitle', { month: monthLabel(r.month, locale) })}
        badge={<Badge tone={statusTone(r.status)}>{t('pay.status.' + r.status)}</Badge>}
        subtitle={t('pay.payOn', { date: formatDate(r.pay_date, locale) })}
        actions={
          <>
            {r.entry_id && (
              <Link to={`/journal/${r.entry_id}`} className="btn">
                {t('common.journalEntry')}
              </Link>
            )}
            {draft && can('payroll.runs.write') && (
              <>
                <Button
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('pay.deleteRun'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(
                        () => api.del(`/payroll/runs/${r.id}`),
                        t('common.deleted'),
                        () => navigate('/payroll/runs'),
                      );
                  }}
                />
                <Button icon={<RefreshCw />} onClick={() => run(() => api.post(`/payroll/runs/${r.id}/recalculate`), t('pay.recalculated'))}>
                  {t('pay.recalculate')}
                </Button>
              </>
            )}
            {draft && can('payroll.runs.post') && (
              <Button
                variant="primary"
                icon={<CheckCircle2 />}
                onClick={async () => {
                  if ((await confirm({ title: t('pay.postTitle'), body: t('pay.postText') })).ok) run(() => api.post(`/payroll/runs/${r.id}/post`), t('pay.posted'));
                }}
              >
                {t('pay.post')}
              </Button>
            )}
            {r.status === 'posted' && can('payroll.runs.post') && (
              <>
                <Button icon={<Undo2 />} onClick={() => run(() => api.post(`/payroll/runs/${r.id}/unpost`), t('common.saved'))}>
                  {t('pay.unpost')}
                </Button>
                <Button variant="primary" icon={<Banknote />} onClick={() => setPaying(true)}>
                  {t('pay.pay')}
                </Button>
              </>
            )}
            {r.status === 'paid' && can('payroll.runs.post') && (
              <Button
                icon={<Undo2 />}
                onClick={async () => {
                  if ((await confirm({ title: t('pay.unpayTitle'), danger: true })).ok) run(() => api.post(`/payroll/runs/${r.id}/unpay`), t('common.saved'));
                }}
              >
                {t('pay.unpay')}
              </Button>
            )}
          </>
        }
      />
      <div className="kpi-strip">
        <div>
          <span>{t('pay.gross')}</span>
          <strong>{fmt(r.gross)}</strong>
          <small className="faint">{t('pay.employeesCount', { n: r.lines.length })}</small>
        </div>
        <div>
          <span>{t('pay.deductions')}</span>
          <strong>{fmt(r.deductions)}</strong>
        </div>
        <div>
          <span>{t('pay.net')}</span>
          <strong>{fmt(r.net)}</strong>
          {r.paid_date && <small className="faint">{t('pay.paidOn', { date: formatDate(r.paid_date, locale) })}</small>}
        </div>
        <div>
          <span>{t('pay.employer')}</span>
          <strong>{fmt(r.employer)}</strong>
          <small className="faint">{t('pay.totalCost', { amount: fmt(r.gross + r.employer) })}</small>
        </div>
      </div>
      <Card>
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('pay.employee')}</th>
                <th className="end">{t('pay.days')}</th>
                <th className="end">{t('pay.basic')}</th>
                <th className="end">{t('pay.gross')}</th>
                <th className="end">{t('pay.deductions')}</th>
                <th className="end">{t('pay.net')}</th>
                <th className="end">{t('pay.employer')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>{l.name}</strong> <span className="faint num">{l.code}</span>
                    {(l.bonus > 0 || l.other_deduction > 0) && (
                      <Badge plain tone="amber">
                        {t('pay.adjusted')}
                      </Badge>
                    )}
                  </td>
                  <td className="end num">{l.days === l.of_days ? l.days : <span className="warning-text">{`${l.days}/${l.of_days}`}</span>}</td>
                  <td className="end num">{fmt(l.basic)}</td>
                  <td className="end num">{fmt(l.gross)}</td>
                  <td className="end num">{fmt(l.deductions)}</td>
                  <td className="end num">
                    <strong>{fmt(l.net)}</strong>
                  </td>
                  <td className="end num">{fmt(l.employer)}</td>
                  <td className="shrink nowrap">
                    <Button size="sm" variant="ghost" iconOnly icon={<Printer />} title={t('pay.payslip')} onClick={() => setSlip(l)} />
                    {draft && can('payroll.runs.write') && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} title={t('pay.adjust')} onClick={() => setAdjusting(l)} />}
                  </td>
                </tr>
              ))}
              <tr className="grand-row">
                <td>{t('common.total')}</td>
                <td />
                <td className="end num">{fmt(r.lines.reduce((s, l) => s + l.basic, 0))}</td>
                <td className="end num">{fmt(r.gross)}</td>
                <td className="end num">{fmt(r.deductions)}</td>
                <td className="end num">{fmt(r.net)}</td>
                <td className="end num">{fmt(r.employer)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      {r.journal && (
        <Card>
          <CardHeader title={t('pay.entryPreview')} sub={t('pay.entryPreviewSub')} />
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('common.account')}</th>
                <th className="end">{t('common.debit')}</th>
                <th className="end">{t('common.credit')}</th>
              </tr>
            </thead>
            <tbody>
              {r.journal.map((j, i) => (
                <tr key={i}>
                  <td>{accName(j.accountId)}</td>
                  <td className="end num">{j.debit ? fmt(j.debit) : ''}</td>
                  <td className="end num">{j.credit ? fmt(j.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <AdjustDialog run={r} line={adjusting} onClose={() => setAdjusting(null)} />
      <PayDialog run={r} open={paying} onClose={() => setPaying(false)} />
      <Dialog
        open={!!slip}
        onClose={() => setSlip(null)}
        wide
        title={t('pay.payslip')}
        footer={
          <Button icon={<Printer />} onClick={() => window.print()}>
            {t('common.print')}
          </Button>
        }
      >
        {slip && <Payslip run={r} line={slip} components={r.components} />}
      </Dialog>
    </div>
  );
}

export const payrollModule: WebModule = {
  id: 'payroll',
  nav: [
    { to: '/payroll/runs', label: 'pay.runs', icon: Wallet, section: 'hr', order: 10, perm: 'payroll.runs.read', app: 'payroll' },
    { to: '/payroll/employees', label: 'pay.employees', icon: Users, section: 'hr', order: 20, perm: 'payroll.employees.read', app: 'payroll' },
    { to: '/payroll/components', label: 'pay.components', icon: Layers, section: 'hr', order: 30, perm: 'payroll.employees.read', app: 'payroll' },
  ],
  routes: [
    { path: '/payroll/runs', element: <RunsPage /> },
    { path: '/payroll/runs/:id', element: <RunPage />, perm: 'payroll.runs.read', app: 'payroll' },
    { path: '/payroll/employees', element: <EmployeesPage /> },
    { path: '/payroll/employees/:id', element: <EmployeePage />, perm: 'payroll.employees.read', app: 'payroll' },
    { path: '/payroll/components', element: <ComponentsPage /> },
  ],
  commands: [
    { id: 'go-payroll', label: 'pay.runs', icon: Wallet, group: 'navigate', to: '/payroll/runs', perm: 'payroll.runs.read', app: 'payroll', keywords: 'payroll salaries رواتب مرتبات أجور' },
    { id: 'go-employees', label: 'pay.employees', icon: Users, group: 'navigate', to: '/payroll/employees', perm: 'payroll.employees.read', app: 'payroll', keywords: 'employees staff موظفين عاملين' },
  ],
};
