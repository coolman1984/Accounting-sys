import { Link } from 'react-router';
import { AlertTriangle, Boxes } from 'lucide-react';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { Card, CardHeader } from '../../ui/Card';
import { Money } from '../../ui/Money';
import { Badge } from '../../ui/Badge';
import { Qty } from '../../ui/Stock';
import type { Summary } from './StockPage';

/** Shown on invoices/bills: the stock that moved and the cost entry it produced. */
export function DocumentStockPanel({ documentId, kind, status }: { documentId: number; kind: string; status: string }) {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { data } = useApi<
    { id: number; qty: number; value: number; is_reversal: number; item_id: number; sku: string; name_en: string; name_ar: string; warehouse_code: string; journal_entry_id: number | null; journal_number: string | null; lot_no: string | null; expiry_date: string | null }[]
  >(
    status !== 'draft' && can('inventory.stock.read') ? '/inventory/by-source' : null,
    { type: kind, id: documentId },
  );
  if (!data?.length) return null;
  const entries = [...new Map(data.filter((m) => m.journal_entry_id).map((m) => [m.journal_entry_id, m.journal_number])).entries()];
  return (
    <Card className="table-card no-print">
      <CardHeader
        title={t('inventory.stockMoves')}
        icon={<Boxes size={18} className="muted" />}
        actions={
          entries.length > 0 && (
            <span className="row" style={{ gap: 10, fontSize: 13 }}>
              <span className="muted">{t('inventory.costEntry')}:</span>
              {entries.map(([id, num]) => (
                <Link key={id} to={`/journal/${id}`}>
                  {num}
                </Link>
              ))}
            </span>
          )
        }
      />
      <table className="table table-compact">
        <tbody>
          {data.map((m) => (
            <tr key={m.id} style={{ opacity: m.is_reversal ? 0.65 : 1 }}>
              <td>
                <Link to={`/inventory/items/${m.item_id}`}>
                  <span className="num faint" style={{ marginInlineEnd: 8 }}>
                    {m.sku}
                  </span>
                  {pick(m.name_en, m.name_ar)}
                </Link>
                {!!m.is_reversal && (
                  <Badge tone="amber" plain>
                    {t('status.void')}
                  </Badge>
                )}
              </td>
              <td className="muted mono" style={{ fontSize: 12.5 }}>
                {m.lot_no}
                {m.expiry_date && <span className="faint"> · {m.expiry_date}</span>}
              </td>
              <td className="muted">{m.warehouse_code}</td>
              <td className="end">
                {m.qty !== 0 ? <Qty v={m.qty} signed tone /> : <span className="faint">{t('journal.sources.stock_revaluation')}</span>}
              </td>
              <td className="end">
                <Money v={m.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Dashboard widget: stock value and what needs reordering. */
export function InventoryWidget() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { data } = useApi<Summary>(can('inventory.stock.read') ? '/inventory/summary' : null);
  if (!data || data.items === 0) return null;
  return (
    <div className="grid-2">
      <Card>
        <CardHeader
          title={t('inventory.value')}
          icon={<Boxes size={18} className="muted" />}
          actions={
            <Link to="/inventory" className="btn btn-sm btn-ghost">
              {t('inventory.viewStock')}
            </Link>
          }
        />
        <div className="card-body">
          <div className="kpi-value num" style={{ fontSize: 26, fontWeight: 680 }}>
            <Money v={data.value} />
          </div>
          <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            {t('inventory.inStock')}: {data.inStock} / {data.items} · {t('inventory.warehouses')}: {data.warehouses}
          </p>
          <div className="label" style={{ margin: '16px 0 6px' }}>
            {t('inventory.topValue')}
          </div>
          {data.top.map((x) => (
            <Link key={x.id} to={`/inventory/items/${x.id}`} className="row" style={{ padding: '4px 0', fontSize: 13.5 }}>
              <span>{pick(x.name_en, x.name_ar)}</span>
              <span className="spacer" />
              <Money v={x.value} />
            </Link>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader
          title={t('inventory.needsReorder')}
          icon={<AlertTriangle size={18} className={data.lowItems.length ? 'danger-text' : 'muted'} />}
          actions={
            <Link to="/reports/inventory/reorder" className="btn btn-sm btn-ghost">
              {t('common.viewAll')}
            </Link>
          }
        />
        {data.lowItems.length === 0 ? (
          <div className="card-body muted">{t('dashboard.allGood')} ✓</div>
        ) : (
          <table className="table table-compact">
            <tbody>
              {data.lowItems.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link to={`/inventory/items/${x.id}`}>{pick(x.name_en, x.name_ar)}</Link>
                  </td>
                  <td className={`end ${x.qty <= 0 ? 'danger-text' : ''}`} style={{ fontWeight: 600 }}>
                    <Qty v={x.qty} />
                  </td>
                  <td className="end faint">
                    / <Qty v={x.reorder_level} />
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
