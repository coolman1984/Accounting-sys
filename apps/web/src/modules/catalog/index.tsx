import { useEffect, useState } from 'react';
import { Package, Pencil, Percent, Plus, Search } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatBp } from '../../core/format';
import type { Item, Tax } from '../../core/types';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker, TaxSelect, useTaxes } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';

// ------------------------------------------------------------------ items

function ItemDialog({ open, onClose, item }: { open: boolean; onClose(): void; item: Item | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const { scale } = useMoney();
  const blank = {
    sku: '',
    nameEn: '',
    nameAr: '',
    kind: 'service' as Item['kind'],
    unit: '',
    salePrice: 0 as number | null,
    purchasePrice: 0 as number | null,
    incomeAccountId: null as number | null,
    expenseAccountId: null as number | null,
    salesTaxId: null as number | null,
    purchaseTaxId: null as number | null,
    description: '',
    isActive: true,
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      item
        ? {
            sku: item.sku,
            nameEn: item.name_en,
            nameAr: item.name_ar,
            kind: item.kind,
            unit: item.unit ?? '',
            salePrice: item.sale_price,
            purchasePrice: item.purchase_price,
            incomeAccountId: item.income_account_id,
            expenseAccountId: item.expense_account_id,
            salesTaxId: item.sales_tax_id,
            purchaseTaxId: item.purchase_tax_id,
            description: item.description ?? '',
            isActive: !!item.is_active,
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);
  const save = useApiMutation((body: object) => (item ? api.put(`/items/${item.id}`, body) : api.post('/items', body)));
  const submit = () =>
    save.mutate(
      { ...f, salePrice: f.salePrice ?? 0, purchasePrice: f.purchasePrice ?? 0 },
      { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) },
    );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={item ? t('items.edit') : t('items.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.sku || !f.nameEn || !f.nameAr} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <Field label={t('items.sku')}>
            <Input value={f.sku} onChange={(e) => set('sku', e.target.value)} />
          </Field>
          <Field label={t('items.kind')}>
            <Select value={f.kind} onChange={(e) => set('kind', e.target.value as Item['kind'])}>
              <option value="service">{t('items.kinds.service')}</option>
              <option value="product">{t('items.kinds.product')}</option>
            </Select>
          </Field>
          <Field label={t('items.unit')}>
            <Input value={f.unit} onChange={(e) => set('unit', e.target.value)} />
          </Field>
        </div>
        <div className="grid-2">
          <Field label={t('common.nameEn')}>
            <Input dir="ltr" value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} />
          </Field>
          <Field label={t('items.salePrice')}>
            <DecimalInput scale={scale} value={f.salePrice} onChange={(v) => set('salePrice', v)} />
          </Field>
          <Field label={t('items.purchasePrice')}>
            <DecimalInput scale={scale} value={f.purchasePrice} onChange={(v) => set('purchasePrice', v)} />
          </Field>
          <Field label={t('items.salesTax')}>
            <TaxSelect side="sales" value={f.salesTaxId} onChange={(v) => set('salesTaxId', v)} />
          </Field>
          <Field label={t('items.purchaseTax')}>
            <TaxSelect side="purchases" value={f.purchaseTaxId} onChange={(v) => set('purchaseTaxId', v)} />
          </Field>
          <Field label={t('items.incomeAccount')}>
            <AccountPicker value={f.incomeAccountId} onChange={(v) => set('incomeAccountId', v)} filter={(a) => a.type === 'income'} placeholder={t('items.useDefault')} />
          </Field>
          <Field label={t('items.expenseAccount')}>
            <AccountPicker
              value={f.expenseAccountId}
              onChange={(v) => set('expenseAccountId', v)}
              filter={(a) => a.type === 'expense' || a.type === 'asset'}
              placeholder={t('items.useDefault')}
            />
          </Field>
        </div>
        <Field label={t('common.description')}>
          <Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => set('isActive', v)} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function ItemsPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<{ item: Item | null } | null>(null);
  const { data, isLoading } = useApi<Item[]>('/items', { q });
  const { data: taxes } = useTaxes();
  const taxName = (id: number | null) => (id ? taxes?.find((x) => x.id === id)?.code ?? '' : '—');
  return (
    <div className="page">
      <PageHeader
        title={t('items.title')}
        subtitle={t('items.subtitle')}
        actions={
          can('catalog.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ item: null })}>
              {t('items.new')}
            </Button>
          )
        }
      />
      <div className="toolbar">
        <div className="input-group">
          <Search />
          <input className="input" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<Package size={22} />} title={t('common.noResults')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('items.sku')}</th>
                  <th>{t('common.name')}</th>
                  <th>{t('items.kind')}</th>
                  <th className="end">{t('items.salePrice')}</th>
                  <th className="end">{t('items.purchasePrice')}</th>
                  <th>{t('docs.tax')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {data.map((i) => (
                  <tr key={i.id} style={{ opacity: i.is_active ? 1 : 0.55 }}>
                    <td className="num faint">{i.sku}</td>
                    <td style={{ fontWeight: 550 }}>{pick(i.name_en, i.name_ar)}</td>
                    <td>
                      <Badge tone={i.kind === 'product' ? 'cyan' : 'blue'} plain>
                        {t('items.kinds.' + i.kind)}
                      </Badge>
                    </td>
                    <td className="end">
                      <Money v={i.sale_price} />
                    </td>
                    <td className="end">
                      <Money v={i.purchase_price} />
                    </td>
                    <td className="muted">{taxName(i.sales_tax_id)}</td>
                    <td>{can('catalog.write') && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setDialog({ item: i })} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ItemDialog open={!!dialog} onClose={() => setDialog(null)} item={dialog?.item ?? null} />
    </div>
  );
}

// ------------------------------------------------------------------ taxes

function TaxDialog({ open, onClose, tax }: { open: boolean; onClose(): void; tax: Tax | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const blank = {
    code: '',
    nameEn: '',
    nameAr: '',
    rateBp: 1400 as number | null,
    scope: 'both' as Tax['scope'],
    salesAccountId: null as number | null,
    purchaseAccountId: null as number | null,
    isActive: true,
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      tax
        ? {
            code: tax.code,
            nameEn: tax.name_en,
            nameAr: tax.name_ar,
            rateBp: tax.rate_bp,
            scope: tax.scope,
            salesAccountId: tax.sales_account_id,
            purchaseAccountId: tax.purchase_account_id,
            isActive: !!tax.is_active,
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tax]);
  const save = useApiMutation((body: object) => (tax ? api.put(`/taxes/${tax.id}`, body) : api.post('/taxes', body)));
  const submit = () =>
    save.mutate({ ...f, rateBp: f.rateBp ?? 0 }, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={tax ? t('taxes.edit') : t('taxes.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.code || !f.nameEn || !f.nameAr} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.code')}>
            <Input value={f.code} onChange={(e) => set('code', e.target.value)} />
          </Field>
          <Field label={t('taxes.rate')}>
            <DecimalInput trim scale={2} value={f.rateBp} onChange={(v) => set('rateBp', v == null ? null : Math.min(v, 10000))} />
          </Field>
          <Field label={t('common.nameEn')}>
            <Input dir="ltr" value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} />
          </Field>
        </div>
        <Field label={t('taxes.scope')}>
          <Select value={f.scope} onChange={(e) => set('scope', e.target.value as Tax['scope'])}>
            {(['both', 'sales', 'purchases'] as const).map((s) => (
              <option key={s} value={s}>
                {t('taxes.scopes.' + s)}
              </option>
            ))}
          </Select>
        </Field>
        {f.scope !== 'purchases' && (
          <Field label={t('taxes.salesAccount')}>
            <AccountPicker value={f.salesAccountId} onChange={(v) => set('salesAccountId', v)} filter={(a) => a.type === 'liability' || a.type === 'asset'} />
          </Field>
        )}
        {f.scope !== 'sales' && (
          <Field label={t('taxes.purchaseAccount')}>
            <AccountPicker value={f.purchaseAccountId} onChange={(v) => set('purchaseAccountId', v)} filter={(a) => a.type === 'asset' || a.type === 'liability'} />
          </Field>
        )}
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => set('isActive', v)} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function TaxesPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const [dialog, setDialog] = useState<{ tax: Tax | null } | null>(null);
  const { data, isLoading } = useTaxes();
  return (
    <div className="page">
      <PageHeader
        title={t('taxes.title')}
        subtitle={t('taxes.subtitle')}
        actions={
          can('catalog.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ tax: null })}>
              {t('taxes.new')}
            </Button>
          )
        }
      />
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<Percent size={22} />} title={t('common.noResults')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.code')}</th>
                <th>{t('common.name')}</th>
                <th className="end">{t('taxes.rate')}</th>
                <th>{t('taxes.scope')}</th>
                <th>{t('common.status')}</th>
                <th className="shrink" />
              </tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.id}>
                  <td style={{ fontWeight: 600 }}>{x.code}</td>
                  <td>{pick(x.name_en, x.name_ar)}</td>
                  <td className="end num">{formatBp(x.rate_bp)}</td>
                  <td className="muted">{t('taxes.scopes.' + x.scope)}</td>
                  <td>{x.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                  <td>{can('catalog.write') && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setDialog({ tax: x })} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <TaxDialog open={!!dialog} onClose={() => setDialog(null)} tax={dialog?.tax ?? null} />
    </div>
  );
}

export const catalogModule: WebModule = {
  id: 'catalog',
  nav: [
    { to: '/items', label: 'nav.items', icon: Package, section: 'accounting', order: 30, perm: 'catalog.read' },
    { to: '/taxes', label: 'nav.taxes', icon: Percent, section: 'accounting', order: 40, perm: 'catalog.read' },
  ],
  routes: [
    { path: '/items', element: <ItemsPage /> },
    { path: '/taxes', element: <TaxesPage /> },
  ],
  commands: [
    { id: 'go-items', label: 'nav.items', icon: Package, group: 'navigate', to: '/items', perm: 'catalog.read', keywords: 'products services أصناف منتجات' },
    { id: 'go-taxes', label: 'nav.taxes', icon: Percent, group: 'navigate', to: '/taxes', perm: 'catalog.read', keywords: 'vat ضريبة' },
  ],
};
