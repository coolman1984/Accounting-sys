import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Package, Pencil, Percent, Plus, Search, Tags, Trash2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatBp, formatQty, QTY_SCALE } from '../../core/format';
import { isStockItem, type Item, type ItemCategory, type Tax } from '../../core/types';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker, TaxSelect, useTaxes } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';
import { useConfirm } from '../../ui/Dialog';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';

// ------------------------------------------------------------------ items

interface UnitRow {
  id?: number;
  nameEn: string;
  nameAr: string;
  factor: number | null;
  barcode: string;
  salePrice: number | null;
  purchasePrice: number | null;
}

function ItemDialog({ open, onClose, item }: { open: boolean; onClose(): void; item: Item | null }) {
  const { t, pick } = useI18n();
  const { hasApp } = useSession();
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
    barcode: '',
    categoryId: null as number | null,
    trackStock: true,
    inventoryAccountId: null as number | null,
    cogsAccountId: null as number | null,
    reorderLevel: 0 as number | null,
    reorderQty: 0 as number | null,
    tracking: 'none' as Item['tracking'],
    requiresExpiry: false,
    minSalePrice: 0 as number | null,
    units: [] as UnitRow[],
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const { data: categories } = useApi<ItemCategory[]>('/item-categories');
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
            barcode: item.barcode ?? '',
            categoryId: item.category_id,
            trackStock: !!item.track_stock,
            inventoryAccountId: item.inventory_account_id,
            cogsAccountId: item.cogs_account_id,
            reorderLevel: item.reorder_level,
            reorderQty: item.reorder_qty,
            tracking: item.tracking,
            requiresExpiry: !!item.requires_expiry,
            minSalePrice: item.min_sale_price,
            units: item.units
              .filter((u) => u.is_active)
              .map((u) => ({ id: u.id, nameEn: u.name_en, nameAr: u.name_ar, factor: u.factor, barcode: u.barcode ?? '', salePrice: u.sale_price, purchasePrice: u.purchase_price })),
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);
  const stock = f.kind === 'product' && f.trackStock;
  const save = useApiMutation((body: object) => (item ? api.put(`/items/${item.id}`, body) : api.post('/items', body)));
  const submit = () =>
    save.mutate(
      {
        ...f,
        barcode: f.barcode.trim() || null,
        salePrice: f.salePrice ?? 0,
        purchasePrice: f.purchasePrice ?? 0,
        reorderLevel: f.reorderLevel ?? 0,
        reorderQty: f.reorderQty ?? 0,
        minSalePrice: f.minSalePrice ?? 0,
        units: (f.kind === 'product' && f.tracking !== 'serial' ? f.units : [])
          .filter((u) => u.nameEn.trim() && u.factor)
          .map((u) => ({ ...u, nameAr: u.nameAr.trim() || u.nameEn, barcode: u.barcode.trim() || null })),
      },
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
          <Field label={t('items.barcode')}>
            <Input value={f.barcode} onChange={(e) => set('barcode', e.target.value)} dir="ltr" />
          </Field>
          <Field label={t('items.category')} className="span-2">
            <Select value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('items.noCategory')}</option>
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {pick(c.name_en, c.name_ar)}
                </option>
              ))}
            </Select>
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
          {!stock && (
            <Field label={t('items.expenseAccount')}>
              <AccountPicker
                value={f.expenseAccountId}
                onChange={(v) => set('expenseAccountId', v)}
                filter={(a) => a.type === 'expense' || a.type === 'asset'}
                placeholder={t('items.useDefault')}
              />
            </Field>
          )}
        </div>
        {f.kind === 'product' && hasApp('inventory') && (
          <div className="card" style={{ padding: 16, background: 'var(--bg-subtle)' }}>
            <div className="row" style={{ marginBottom: stock ? 14 : 0 }}>
              <Checkbox label={t('items.trackStock')} checked={f.trackStock} onChange={(v) => set('trackStock', v)} />
            </div>
            {stock && (
              <div className="grid-2">
                <Field label={t('adv.tracking')}>
                  <Select value={f.tracking} onChange={(e) => set('tracking', e.target.value as Item['tracking'])}>
                    {(['none', 'batch', 'serial'] as const).map((x) => (
                      <option key={x} value={x}>
                        {t('adv.trackings.' + x)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="field" style={{ justifyContent: 'flex-end', paddingBottom: 8 }}>
                  {f.tracking === 'batch' && <Checkbox label={t('adv.requiresExpiry')} checked={f.requiresExpiry} onChange={(v) => set('requiresExpiry', v)} />}
                </div>
                <Field label={t('items.reorderLevel')}>
                  <DecimalInput trim scale={QTY_SCALE} value={f.reorderLevel} onChange={(v) => set('reorderLevel', v)} />
                </Field>
                <Field label={t('items.reorderQty')}>
                  <DecimalInput trim scale={QTY_SCALE} value={f.reorderQty} onChange={(v) => set('reorderQty', v)} />
                </Field>
                <Field label={t('items.inventoryAccount')}>
                  <AccountPicker value={f.inventoryAccountId} onChange={(v) => set('inventoryAccountId', v)} filter={(a) => a.subtype === 'inventory'} placeholder={t('items.useDefault')} />
                </Field>
                <Field label={t('items.cogsAccount')}>
                  <AccountPicker value={f.cogsAccountId} onChange={(v) => set('cogsAccountId', v)} filter={(a) => a.type === 'expense'} placeholder={t('items.useDefault')} />
                </Field>
              </div>
            )}
          </div>
        )}
        {f.kind === 'product' && f.tracking !== 'serial' && (
          <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
            <div className="label">{t('adv.units')}</div>
            <p className="faint" style={{ fontSize: 12.5 }}>
              {t('adv.unitsHint')}
            </p>
            {f.units.length > 0 && (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('common.nameEn')}</th>
                    <th>{t('common.nameAr')}</th>
                    <th className="end">{t('adv.contains')}</th>
                    <th>{t('adv.unitBarcode')}</th>
                    <th className="end">{t('items.salePrice')}</th>
                    <th className="end">{t('items.purchasePrice')}</th>
                    <th className="shrink" />
                  </tr>
                </thead>
                <tbody>
                  {f.units.map((u, i) => {
                    const setU = (patch: Partial<UnitRow>) => set('units', f.units.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                      <tr key={i}>
                        <td>
                          <Input sm dir="ltr" value={u.nameEn} onChange={(e) => setU({ nameEn: e.target.value })} placeholder="Box" />
                        </td>
                        <td>
                          <Input sm dir="rtl" value={u.nameAr} onChange={(e) => setU({ nameAr: e.target.value })} placeholder="كرتونة" />
                        </td>
                        <td style={{ width: 90 }}>
                          <DecimalInput sm trim scale={QTY_SCALE} value={u.factor} onChange={(v) => setU({ factor: v })} />
                        </td>
                        <td>
                          <Input sm dir="ltr" value={u.barcode} onChange={(e) => setU({ barcode: e.target.value })} />
                        </td>
                        <td style={{ width: 110 }}>
                          <DecimalInput sm scale={scale} value={u.salePrice} onChange={(v) => setU({ salePrice: v })} placeholder={f.salePrice && u.factor ? String(((f.salePrice * u.factor) / 1000 / 10 ** scale).toFixed(scale)) : ''} />
                        </td>
                        <td style={{ width: 110 }}>
                          <DecimalInput sm scale={scale} value={u.purchasePrice} onChange={(v) => setU({ purchasePrice: v })} />
                        </td>
                        <td>
                          <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => set('units', f.units.filter((_, j) => j !== i))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div>
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => set('units', [...f.units, { nameEn: '', nameAr: '', factor: null, barcode: '', salePrice: null, purchasePrice: null }])}>
                {t('adv.addUnit')}
              </Button>
            </div>
          </div>
        )}
        <Field label={t('adv.minSalePrice')} hint={t('adv.minSalePriceHint')}>
          <DecimalInput scale={scale} value={f.minSalePrice} onChange={(v) => set('minSalePrice', v)} />
        </Field>
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
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ item: Item | null } | null>(null);
  const [cats, setCats] = useState(false);
  const { data, isLoading } = useApi<Item[]>('/items');
  const { data: taxes } = useTaxes();
  const taxName = (id: number | null) => (id ? taxes?.find((x) => x.id === id)?.code ?? '' : '');

  const columns = useMemo<Column<Item>[]>(
    () => [
      { id: 'sku', header: t('items.sku'), pinned: true, width: 110, value: (i) => i.sku, render: (i) => <span className="num faint">{i.sku}</span> },
      {
        id: 'name',
        header: t('common.name'),
        value: (i) => pick(i.name_en, i.name_ar),
        render: (i) => (
          <span style={{ fontWeight: 550 }}>
            {pick(i.name_en, i.name_ar)}
            {i.barcode && <div className="faint mono" style={{ fontSize: 11.5, fontWeight: 400 }}>{i.barcode}</div>}
          </span>
        ),
      },
      {
        id: 'kind',
        header: t('items.kind'),
        type: 'enum',
        value: (i) => i.kind,
        format: (v) => t('items.kinds.' + v),
        render: (i) => (
          <Badge tone={i.kind === 'product' ? 'cyan' : 'blue'} plain>
            {t('items.kinds.' + i.kind)}
          </Badge>
        ),
      },
      { id: 'category', header: t('items.category'), type: 'enum', value: (i) => pick(i.category_name_en ?? '', i.category_name_ar ?? '') || null },
      { id: 'unit', header: t('adv.baseUnit'), type: 'enum', hidden: true, value: (i) => i.unit },
      { id: 'units', header: t('adv.units'), type: 'number', hidden: true, value: (i) => i.units.filter((u) => u.is_active).length },
      { id: 'tracking', header: t('adv.tracking'), type: 'enum', hidden: true, value: (i) => i.tracking, format: (v) => t('adv.trackings.' + v) },
      { id: 'barcode', header: t('adv.unitBarcode'), hidden: true, value: (i) => i.barcode },
      { id: 'sale', header: t('items.salePrice'), type: 'money', value: (i) => i.sale_price },
      { id: 'purchase', header: t('items.purchasePrice'), type: 'money', value: (i) => i.purchase_price },
      { id: 'min', header: t('adv.minSalePrice'), type: 'money', hidden: true, value: (i) => i.min_sale_price || null },
      { id: 'reorder', header: t('inventory.reorderLevel'), type: 'qty', hidden: true, value: (i) => (isStockItem(i) ? i.reorder_level : null) },
      { id: 'tax', header: t('docs.tax'), type: 'enum', value: (i) => taxName(i.sales_tax_id) || null },
      { id: 'active', header: t('common.status'), type: 'enum', hidden: true, value: (i) => (i.is_active ? 'active' : 'inactive'), format: (v) => t('common.' + v) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, pick, taxes],
  );
  const presets = useMemo<Preset<Item>[]>(
    () => [
      { id: 'stock', label: t('items.kinds.product'), test: (i) => isStockItem(i) },
      { id: 'service', label: t('items.kinds.service'), test: (i) => i.kind === 'service' },
      { id: 'inactive', label: t('common.inactive'), test: (i) => !i.is_active },
    ],
    [t],
  );

  return (
    <div className="page">
      <PageHeader
        title={t('items.title')}
        subtitle={t('items.subtitle')}
        actions={
          can('catalog.items.write') && (
            <>
              <Button icon={<Tags />} onClick={() => setCats(true)}>
                {t('inventory.manageCategories')}
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ item: null })}>
                {t('items.new')}
              </Button>
            </>
          )
        }
      />
      <DataGrid
        id="items"
        rows={data}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(i) => i.id}
        onRowClick={(i) => (can('catalog.items.write') ? setDialog({ item: i }) : isStockItem(i) && navigate(`/inventory/items/${i.id}`))}
        exportName={t('items.title')}
        empty={<EmptyState icon={<Package size={22} />} title={t('common.noResults')} />}
      />
      <ItemDialog open={!!dialog} onClose={() => setDialog(null)} item={dialog?.item ?? null} />
      <CategoriesDialog open={cats} onClose={() => setCats(false)} />
    </div>
  );
}

function CategoriesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const { data } = useApi<ItemCategory[]>('/item-categories');
  const [edit, setEdit] = useState<{ id: number | null; nameEn: string; nameAr: string } | null>(null);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(t('common.saved')), after?.()), onError: (e) => toast.error(errText(e)) });
  return (
    <Dialog open={open} onClose={onClose} title={t('inventory.categories')}>
      <div className="stack">
        <table className="table table-compact">
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.id}>
                <td>{c.name_en}</td>
                <td dir="rtl">{c.name_ar}</td>
                <td className="end faint">{c.items}</td>
                <td className="shrink">
                  <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setEdit({ id: c.id, nameEn: c.name_en, nameAr: c.name_ar })} />
                  {c.items === 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Trash2 />}
                      onClick={async () => {
                        if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok) run(() => api.del(`/item-categories/${c.id}`));
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {edit ? (
          <div className="grid-2" style={{ alignItems: 'end' }}>
            <Field label={t('common.nameEn')}>
              <Input autoFocus dir="ltr" value={edit.nameEn} onChange={(e) => setEdit({ ...edit, nameEn: e.target.value })} />
            </Field>
            <Field label={t('common.nameAr')}>
              <Input dir="rtl" value={edit.nameAr} onChange={(e) => setEdit({ ...edit, nameAr: e.target.value })} />
            </Field>
            <div className="row">
              <Button
                variant="primary"
                size="sm"
                disabled={!edit.nameEn || !edit.nameAr}
                loading={act.isPending}
                onClick={() =>
                  run(
                    () => (edit.id ? api.put(`/item-categories/${edit.id}`, edit) : api.post('/item-categories', edit)),
                    () => setEdit(null),
                  )
                }
              >
                {t('common.save')}
              </Button>
              <Button size="sm" onClick={() => setEdit(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" icon={<Plus />} onClick={() => setEdit({ id: null, nameEn: '', nameAr: '' })}>
              {t('inventory.newCategory')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ taxes

export const catalogModule: WebModule = {
  id: 'catalog',
  nav: [
    {
      to: '/items',
      label: 'nav.items',
      icon: Package,
      // Products sit with stock when Inventory is on, otherwise with what the company does.
      section: (has) => (has('inventory') ? 'inventory' : has('ar') ? 'sales' : 'purchases'),
      order: 10,
      perm: 'catalog.items.read',
    },
  ],
  routes: [{ path: '/items', element: <ItemsPage /> }],
  commands: [
    { id: 'go-items', label: 'nav.items', icon: Package, group: 'navigate', to: '/items', perm: 'catalog.items.read', keywords: 'products services أصناف منتجات' },
  ],
};
