import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AlertTriangle, ListPlus, Plus, Tags, Trash2, Users, X } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import type { Item } from '../../core/types';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Checkbox, DecimalInput, Field, Input, Select } from '../../ui/Field';
import { ItemPicker, PartyPicker, useItems, useParties } from '../../ui/Pickers';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';

interface PriceRow {
  key: number;
  itemId: number | null;
  unitId: number | null;
  price: number | null;
}
let k = 0;

/** The item's own price for a unit: the unit's price, else base price × factor. */
const standard = (item: Item | undefined, unitId: number | null) => {
  if (!item) return 0;
  const u = unitId ? item.units.find((x) => x.id === unitId) : null;
  return u ? u.sale_price ?? Math.round((item.sale_price * u.factor) / 1000) : item.sale_price;
};

function PriceListsPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<any[]>('/pricing/lists');
  return (
    <div className="page">
      <PageHeader
        title={t('adv.priceLists')}
        subtitle={t('adv.priceListsSubtitle')}
        actions={
          can('pricing.write') && (
            <Link to="/sales/price-lists/new" className="btn btn-primary">
              <Plus /> {t('adv.newPriceList')}
            </Link>
          )
        }
      />
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<Tags size={22} />} title={t('common.noResults')} text={t('adv.priceListsSubtitle')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th className="end">{t('docs.item')}</th>
                  <th className="end">{t('adv.customers')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => navigate(`/sales/price-lists/${l.id}`)}>
                    <td style={{ fontWeight: 550 }}>{pick(l.name_en, l.name_ar)}</td>
                    <td className="end num">{l.prices}</td>
                    <td className="end num">{l.parties}</td>
                    <td>{l.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function PriceListEditor() {
  const { id } = useParams();
  const editing = id != null;
  const { t, pick } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { data: items } = useItems();
  const { data: customers } = useParties('customer');
  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const { data: existing, isLoading } = useApi<any>(editing ? `/pricing/lists/${id}` : null);

  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [active, setActive] = useState(true);
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [parties, setParties] = useState<number[]>([]);
  const [pct, setPct] = useState<number | null>(1000);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!existing) return;
    setNameEn(existing.name_en);
    setNameAr(existing.name_ar);
    setActive(!!existing.is_active);
    setRows(existing.prices.map((p: any) => ({ key: ++k, itemId: p.item_id, unitId: p.unit_id, price: p.price })));
    setParties(existing.parties.map((p: any) => p.id));
  }, [existing]);

  const update = (key: number, patch: Partial<PriceRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // Every selling unit of every sellable item, at the standard price less a discount.
  const fillAll = () => {
    const off = pct ?? 0;
    const have = new Set(rows.map((r) => `${r.itemId}:${r.unitId ?? 0}`));
    const add: PriceRow[] = [];
    for (const it of items ?? []) {
      if (!it.is_active) continue;
      for (const unitId of [null, ...it.units.filter((u) => u.is_active).map((u) => u.id)]) {
        if (have.has(`${it.id}:${unitId ?? 0}`)) continue;
        add.push({ key: ++k, itemId: it.id, unitId, price: Math.round((standard(it, unitId) * (10000 - off)) / 10000) });
      }
    }
    setRows((rs) => [...rs.filter((r) => r.itemId), ...add]);
  };

  const save = useApiMutation(() => {
    const body = {
      nameEn,
      nameAr: nameAr || nameEn,
      isActive: active,
      prices: rows.filter((r) => r.itemId && r.price != null).map((r) => ({ itemId: r.itemId, unitId: r.unitId, price: r.price })),
      partyIds: parties,
    };
    return editing ? api.put<{ id: number }>(`/pricing/lists/${id}`, body) : api.post<{ id: number }>('/pricing/lists', body);
  });
  const remove = useApiMutation(() => api.del(`/pricing/lists/${id}`));

  if (editing && isLoading) return <Loading />;
  const writable = can('pricing.write');

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/sales/price-lists', label: t('adv.priceLists') }]}
        title={editing ? pick(nameEn, nameAr) || t('adv.priceLists') : t('adv.newPriceList')}
        actions={
          writable && (
            <>
              {editing && (
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok)
                      remove.mutate(undefined, { onSuccess: () => (toast.success(t('common.deleted')), navigate('/sales/price-lists')), onError: (e) => toast.error(errText(e)) });
                  }}
                >
                  {t('common.delete')}
                </Button>
              )}
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={!nameEn.trim()}
                onClick={() => {
                  setErr('');
                  save.mutate(undefined, {
                    onSuccess: (r) => (toast.success(t('common.saved')), navigate(`/sales/price-lists/${r.id}`)),
                    onError: (e) => setErr(errText(e)),
                  });
                }}
              >
                {t('common.save')}
              </Button>
            </>
          )
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'end' }}>
            <Field label={t('common.nameEn')}>
              <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} autoFocus={!editing} />
            </Field>
            <Field label={t('common.nameAr')}>
              <Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
            </Field>
            <Field label=" ">
              <Checkbox label={t('common.active')} checked={active} onChange={setActive} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title={t('adv.customers')} icon={<Users size={18} className="muted" />} />
          <div className="card-body stack">
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {parties.map((pid) => {
                const p = customers?.rows.find((x) => x.id === pid);
                return (
                  <span key={pid} className="badge badge-blue" style={{ gap: 4 }}>
                    {p?.name ?? `#${pid}`}
                    <button type="button" onClick={() => setParties((ps) => ps.filter((x) => x !== pid))} style={{ border: 0, background: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'inline-flex' }}>
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
              {!parties.length && <span className="faint">—</span>}
            </div>
            <div style={{ maxWidth: 360 }}>
              <PartyPicker kind="customer" value={null} placeholder={t('common.add')} onChange={(pid) => pid && setParties((ps) => (ps.includes(pid) ? ps : [...ps, pid]))} />
            </div>
          </div>
        </Card>

        <Card className="lines-grid">
          <CardHeader
            title={t('docs.item')}
            icon={<Tags size={18} className="muted" />}
            actions={
              <div className="row" style={{ gap: 8 }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  {t('docs.discount')}
                </span>
                <div style={{ width: 80 }}>
                  <DecimalInput trim scale={2} value={pct} onChange={(v) => setPct(v == null ? null : Math.min(v, 10000))} />
                </div>
                <Button size="sm" icon={<ListPlus />} onClick={fillAll}>
                  {t('adv.fillAll')}
                </Button>
              </div>
            }
          />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th style={{ width: 150 }}>{t('adv.unit')}</th>
                  <th className="end" style={{ width: 130 }}>
                    {t('adv.standardPrice')}
                  </th>
                  <th className="end" style={{ width: 150 }}>
                    {t('docs.price')}
                  </th>
                  <th className="end" style={{ width: 80 }}>
                    %
                  </th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const item = r.itemId ? itemById.get(r.itemId) : undefined;
                  const std = standard(item, r.unitId);
                  const diff = std && r.price != null ? ((r.price - std) / std) * 100 : null;
                  const belowMin = !!item && item.min_sale_price > 0 && r.price != null && r.price * 1000 < item.min_sale_price * (r.unitId ? item.units.find((u) => u.id === r.unitId)?.factor ?? 1000 : 1000);
                  return (
                    <tr key={r.key}>
                      <td>
                        <ItemPicker value={r.itemId} onChange={(itemId, it) => update(r.key, { itemId, unitId: null, price: it?.sale_price ?? null })} />
                      </td>
                      <td>
                        {item?.units.length ? (
                          <Select
                            value={r.unitId ?? ''}
                            onChange={(e) => {
                              const unitId = e.target.value ? Number(e.target.value) : null;
                              update(r.key, { unitId, price: standard(item, unitId) });
                            }}
                          >
                            <option value="">{item.unit || t('adv.baseUnit')}</option>
                            {item.units.map((u) => (
                              <option key={u.id} value={u.id}>
                                {pick(u.name_en, u.name_ar)}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="faint">{item?.unit ?? ''}</span>
                        )}
                      </td>
                      <td className="end muted">{item ? fmt(std) : ''}</td>
                      <td>
                        <DecimalInput scale={scale} value={r.price} onChange={(price) => update(r.key, { price })} />
                        {belowMin && <div className="danger-text" style={{ fontSize: 11, marginTop: 2 }}>{t('adv.belowMin', { min: fmt(item!.min_sale_price) })}</div>}
                      </td>
                      <td className={`end num ${diff != null && diff < 0 ? 'success-text' : ''}`} style={{ fontSize: 12 }}>
                        <span dir="ltr">{diff == null || Math.abs(diff) < 0.05 ? '' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`}</span>
                      </td>
                      <td>
                        <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="balance-bar">
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setRows((rs) => [...rs, { key: ++k, itemId: null, unitId: null, price: null }])}>
              {t('adv.addItem')}
            </Button>
            <span className="spacer" />
            <span className="muted">{rows.filter((r) => r.itemId).length}</span>
          </div>
        </Card>
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

export const pricingModule: WebModule = {
  id: 'pricing',
  nav: [{ to: '/sales/price-lists', label: 'nav.priceLists', icon: Tags, section: 'sales', order: 50, perm: 'pricing.read' }],
  routes: [
    { path: '/sales/price-lists', element: <PriceListsPage /> },
    { path: '/sales/price-lists/new', element: <PriceListEditor key="new" /> },
    { path: '/sales/price-lists/:id', element: <PriceListEditor key="edit" /> },
  ],
  commands: [{ id: 'go-price-lists', label: 'nav.priceLists', icon: Tags, group: 'navigate', to: '/sales/price-lists', perm: 'pricing.read', keywords: 'price list قائمة أسعار' }],
};
