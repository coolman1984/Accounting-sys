import { Link } from 'react-router';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { useApi, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { Card, CardHeader } from '../../ui/Card';
import { Money } from '../../ui/Money';

interface Overview {
  overdue: { n: number; amount: number };
  dueSoon: { n: number; amount: number };
  drafts: number;
  top: { party_id: number; name: string; balance: number }[];
}

/** Home-page card for one side: overdue documents and the largest balances (AR: customers, AP: suppliers). */
export function SideOverview({ side }: { side: 'sales' | 'purchases' }) {
  const { t } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const perm = side === 'sales' ? 'ar.reports.read' : 'ap.reports.read';
  const { data } = useApi<Overview>(can(perm) ? '/documents/overview' : null, { side });
  if (!data) return null;
  const sales = side === 'sales';
  const list = sales ? '/sales/invoices?overdue=1' : '/purchases/bills';
  const partyBase = sales ? '/customers' : '/suppliers';
  return (
    <Card>
      <CardHeader
        title={t(sales ? 'dashboard.overdueInvoices' : 'dashboard.billsDueTitle')}
        icon={sales ? <AlertTriangle size={18} className={data.overdue.n ? 'danger-text' : 'muted'} /> : <CalendarClock size={18} className="muted" />}
        actions={
          <Link to={list} className="btn btn-sm btn-ghost">
            {t('common.viewAll')}
          </Link>
        }
      />
      <div className="card-body">
        {data.overdue.n === 0 && data.dueSoon.n === 0 ? (
          <p className="muted">{t('dashboard.allGood')} ✓</p>
        ) : (
          <div className="row" style={{ gap: 28, alignItems: 'flex-start' }}>
            {data.overdue.n > 0 && (
              <div>
                <div className="kpi-value num danger-text" style={{ fontSize: 22, fontWeight: 680 }}>
                  {fmt(data.overdue.amount)}
                </div>
                <p className="muted" style={{ marginTop: 2, fontSize: 13 }}>
                  {t('dashboard.overdueCount', { n: data.overdue.n })}
                </p>
              </div>
            )}
            {data.dueSoon.n > 0 && (
              <div>
                <div className="kpi-value num" style={{ fontSize: 22, fontWeight: 680 }}>
                  {fmt(data.dueSoon.amount)}
                </div>
                <p className="muted" style={{ marginTop: 2, fontSize: 13 }}>
                  {t('dashboard.dueSoonCount', { n: data.dueSoon.n })}
                </p>
              </div>
            )}
          </div>
        )}
        {data.top.length > 0 && (
          <>
            <div className="label" style={{ margin: '18px 0 8px' }}>
              {t(sales ? 'dashboard.topDebtors' : 'dashboard.topCreditors')}
            </div>
            {data.top.map((d) => (
              <Link key={d.party_id} to={`${partyBase}/${d.party_id}`} className="row" style={{ padding: '5px 0', fontSize: 13.5 }}>
                <span>{d.name}</span>
                <span className="spacer" />
                <Money v={d.balance} />
              </Link>
            ))}
          </>
        )}
        {data.drafts > 0 && (
          <p className="faint" style={{ marginTop: 12, fontSize: 12.5 }}>
            {t('dashboard.drafts', { n: data.drafts })}
          </p>
        )}
      </div>
    </Card>
  );
}
