import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, ArrowLeftRight, ClipboardCheck, Download, PackageCheck, PackageX, Plus, Search, SlidersHorizontal, Warehouse as WarehouseIcon, Wallet } from 'lucide-react';
import { useApi, useDate, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { ItemCategory } from '../../core/types';
import { downloadCsv, csvMoney } from '../../lib/csv';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { Money } from '../../ui/Money';
import { Qty, StockStatus, WarehouseSelect } from './common';

interface StockRow {
  id: number;
  sku: string;
  barcode: string | null;
  name_en: string;
  name_ar: string;
  unit: string | null;
  category_name_en: string | null;
  category_name_ar: string | null;
  qty: number;
  value: number;
  avg_cost: number;
  reorder_level: number;
  status: 'ok' | 'low' | 'out';
  last_move: string | null;
  last_sale: string | null;
}

export interface Summary {
  value: number;
  items: number;
  inStock: number;
  low: number;
  out: number;
  warehouses: number;
  top: { id: number; sku: string; name_en: string; name_ar: string; qty: number; value: number }[];
  lowItems: { id: number; sku: string; name_en: string; name_ar: string; qty: number; reorder_level: number }[];
}

export function Kpi({ icon, label, value, tone, onClick, active }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: string; onClick?(): void; active?: boolean }) {
  return (
    <button
      type="button"
      className="card kpi"
      onClick={onClick}
      style={{ textAlign: 'start', cursor: onClick ? 'pointer' : 'default', borderColor: active ? 'var(--primary)' : undefined, font: 'inherit', color: 'inherit' }}
    >
      <div className="kpi-label">
        <span className="kpi-icon" style={tone ? { background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone } : undefined}>
          {icon}
        </span>
        {label}
      </div>
      <div className="kpi-value">{value}</div>
    </button>
  );
}

export function NewOperationButtons() {
  const { t } = useI18n();
  const { can } = useSession();
  if (!can('inventory.write')) return null;
  return (
    <>
      <Link to="/inventory/operations/new?kind=transfer" className="btn">
        <ArrowLeftRight /> {t('inventory.kinds.transfer')}
      </Link>
      <Link to="/inventory/operations/new?kind=count" className="btn">
        <ClipboardCheck /> {t('inventory.kinds.count')}
      </Link>
      <Link to="/inventory/operations/new?kind=adjustment" className="btn btn-primary">
        <SlidersHorizontal /> {t('inventory.kinds.adjustment')}
      </Link>
    </>
  );
}

export function StockPage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const { fmt, scale } = useMoney();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [wh, setWh] = useState<number | null>(null);
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('');
  const { data: summary } = useApi<Summary>('/inventory/summary');
  const { data: categories } = useApi<ItemCategory[]>('/item-categories');
  const { data, isLoading } = useApi<{ rows: StockRow[]; totals: { qty: number; value: number } }>('/inventory/stock', {
    q,
    warehouseId: wh ?? undefined,
    categoryId: cat,
    status,
  });

  const exportCsv = () =>
    data &&
    downloadCsv(
      'stock-on-hand',
      [t('items.sku'), t('common.name'), t('items.category'), t('inventory.onHand'), t('items.unit'), t('inventory.avgCost'), t('inventory.value'), t('inventory.status')],
      data.rows.map((r) => [
        r.sku,
        pick(r.name_en, r.name_ar),
        pick(r.category_name_en, r.category_name_ar),
        r.qty / 1000,
        r.unit ?? '',
        csvMoney(r.avg_cost, scale),
        csvMoney(r.value, scale),
        t('inventory.' + r.status),
      ]),
    );

  return (
    <div className="page">
      <PageHeader title={t('inventory.title')} subtitle={t('inventory.subtitle')} actions={<NewOperationButtons />} />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {summary && (
          <div className="grid-4">
            <Kpi icon={<Wallet />} label={t('inventory.value')} value={fmt(summary.value)} />
            <Kpi icon={<PackageCheck />} tone="var(--success)" label={t('inventory.inStock')} value={`${summary.inStock} / ${summary.items}`} onClick={() => setStatus(status === 'in' ? '' : 'in')} active={status === 'in'} />
            <Kpi icon={<AlertTriangle />} tone="var(--line-amber)" label={t('inventory.low')} value={summary.low} onClick={() => setStatus(status === 'low' ? '' : 'low')} active={status === 'low'} />
            <Kpi icon={<PackageX />} tone="var(--danger)" label={t('inventory.out')} value={summary.out} onClick={() => setStatus(status === 'out' ? '' : 'out')} active={status === 'out'} />
          </div>
        )}

        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="input-group">
            <Search />
            <input className="input" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <WarehouseSelect all value={wh} onChange={setWh} />
          <Select value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 'auto' }}>
            <option value="">{t('inventory.allCategories')}</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {pick(c.name_en, c.name_ar)}
              </option>
            ))}
          </Select>
          <div className="spacer" />
          <Link to="/inventory/warehouses" className="btn btn-sm btn-ghost">
            <WarehouseIcon /> {t('inventory.warehouses')}
          </Link>
          <Button size="sm" variant="ghost" icon={<Download />} onClick={exportCsv}>
            CSV
          </Button>
        </div>

        <Card className="table-card">
          {isLoading || !data ? (
            <Loading />
          ) : !data.rows.length ? (
            <EmptyState title={t('common.noResults')} action={<Link to="/items" className="btn btn-primary"><Plus /> {t('items.new')}</Link>} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('items.sku')}</th>
                    <th>{t('common.name')}</th>
                    <th className="end">{t('inventory.onHand')}</th>
                    <th className="end">{t('inventory.reorderLevel')}</th>
                    <th className="end">{t('inventory.avgCost')}</th>
                    <th className="end">{t('inventory.value')}</th>
                    <th>{t('inventory.status')}</th>
                    <th>{t('inventory.lastSale')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/inventory/items/${r.id}`)}>
                      <td className="num faint">{r.sku}</td>
                      <td>
                        <span style={{ fontWeight: 550 }}>{pick(r.name_en, r.name_ar)}</span>
                        {r.category_name_en && <div className="faint" style={{ fontSize: 12 }}>{pick(r.category_name_en, r.category_name_ar)}</div>}
                      </td>
                      <td className="end" style={{ fontWeight: 600 }}>
                        <Qty v={r.qty} unit={r.unit} />
                      </td>
                      <td className="end muted">{r.reorder_level ? <Qty v={r.reorder_level} /> : '—'}</td>
                      <td className="end">
                        <Money v={r.avg_cost} dashZero />
                      </td>
                      <td className="end">
                        <Money v={r.value} dashZero />
                      </td>
                      <td>
                        <StockStatus status={r.status} />
                      </td>
                      <td className="muted nowrap">{r.last_sale ? date(r.last_sale) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>{t('common.total')}</td>
                    <td className="end">
                      <Money v={data.totals.value} />
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
