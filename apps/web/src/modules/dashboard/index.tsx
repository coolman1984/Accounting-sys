import { Link } from 'react-router';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  FilePlus,
  FileText,
  Landmark,
  LayoutDashboard,
  ReceiptText,
  TrendingUp,
  Wallet,
  ClipboardList,
} from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useDate, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { formatMonth } from '../../core/format';
import { Card, CardHeader } from '../../ui/Card';
import { BarChart } from '../../ui/Chart';
import { EmptyState, Loading } from '../../ui/Page';
import { Kbd, modKey } from '../../ui/Brand';
import { Money } from '../../ui/Money';
import { useSlot } from '../../core/slots';

interface Dashboard {
  today: string;
  cash: number;
  receivables: number;
  payables: number;
  month: { revenue: number; expenses: number; profit: number };
  lastMonth: { revenue: number; expenses: number; profit: number };
  yearToDate: { revenue: number; expenses: number; profit: number };
  series: { month: string; revenue: number; expenses: number; profit: number }[];
  cashAccounts: { id: number; code: string; name_en: string; name_ar: string; balance: number }[];
  recent: { id: number; number: string; date: string; memo: string | null; source_type: string; total: number }[];
  drafts: number;
}

function Kpi({ icon, label, value, foot, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; foot?: React.ReactNode; tone?: string }) {
  return (
    <Card className="kpi">
      <div className="kpi-label">
        <span className="kpi-icon" style={tone ? { background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone } : undefined}>
          {icon}
        </span>
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </Card>
  );
}

interface Quick {
  to: string;
  label: string;
  icon: typeof FilePlus;
  perm: string;
}

function QuickActions({ quick, drafts }: { quick: Quick[]; drafts?: number }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader
        title={t('common.quickActions')}
        actions={
          <span className="row" style={{ gap: 3 }}>
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        }
      />
      <div style={{ padding: 6 }}>
        {quick.map((q) => {
          const Icon = q.icon;
          return (
            <Link key={q.to} to={q.to} className="palette-item">
              <Icon />
              <span>{q.label}</span>
            </Link>
          );
        })}
      </div>
      {!!drafts && drafts > 0 && (
        <div className="card-footer muted" style={{ fontSize: 13 }}>
          {t('dashboard.drafts', { n: drafts })}
        </div>
      )}
    </Card>
  );
}

function DashboardPage() {
  const { t, locale, pick } = useI18n();
  const { user, company, can, hasApp } = useSession();
  const { fmt } = useMoney();
  const date = useDate();
  // Ledger figures need the GL reports right; everyone else gets actions and their modules' cards.
  const gl = can('gl.reports.read');
  const { data, isLoading } = useApi<Dashboard>(gl ? '/reports/dashboard' : null);
  const widgets = useSlot('dashboard.widgets');

  const quick = [
    { to: '/sales/invoices/new', label: t('docs.sales_invoice.new'), icon: FilePlus, perm: 'ar.invoices.write' },
    { to: '/receipts/new', label: t('payments.in.new'), icon: ArrowDownLeft, perm: 'treasury.receipts.write' },
    { to: '/purchases/bills/new', label: t('docs.purchase_bill.new'), icon: ReceiptText, perm: 'ap.bills.write' },
    { to: '/purchasing/orders/new', label: t('adv.newPo'), icon: ClipboardList, perm: 'purchasing.orders.write' },
    { to: '/payments/new', label: t('payments.out.new'), icon: ArrowUpRight, perm: 'treasury.payments.write' },
    { to: '/journal/new', label: t('journal.new'), icon: BookOpen, perm: 'gl.journal.write' },
  ].filter((q) => can(q.perm));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{t('dashboard.title', { name: user?.displayName.split(' ')[0] })}</h1>
          <p className="subtitle">{t('dashboard.subtitle', { company: company?.name })}</p>
        </div>
      </div>

      {!gl ? (
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <QuickActions quick={quick} />
          <div className="dash-widgets">
            {widgets.map((W, i) => (
              <W key={i} />
            ))}
          </div>
        </div>
      ) : isLoading || !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <div className="grid-4">
            <Kpi icon={<Wallet />} label={t('dashboard.cash')} value={fmt(data.cash)} foot={company?.baseCurrency} />
            {hasApp('ar') && (
              <Kpi icon={<ArrowDownLeft />} tone="var(--success)" label={t('dashboard.receivables')} value={fmt(data.receivables)} foot={t('dashboard.controlAccounts')} />
            )}
            {hasApp('ap') && (
              <Kpi icon={<ArrowUpRight />} tone="var(--line-pink)" label={t('dashboard.payables')} value={fmt(data.payables)} foot={t('dashboard.controlAccounts')} />
            )}
            <Kpi
              icon={<TrendingUp />}
              tone="var(--line-amber)"
              label={t('dashboard.profitMonth')}
              value={<span className={data.month.profit < 0 ? 'danger-text' : ''}>{fmt(data.month.profit)}</span>}
              foot={t('dashboard.ytd', { value: fmt(data.yearToDate.profit) })}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 20 }} className="dash-main">
            <Card>
              <CardHeader
                title={t('dashboard.chartTitle')}
                sub={t('dashboard.chartSub')}
                actions={
                  <div className="legend">
                    <span>
                      <i style={{ background: 'var(--chart-1)' }} />
                      {t('dashboard.revenue')}
                    </span>
                    <span>
                      <i style={{ background: 'var(--chart-2)' }} />
                      {t('dashboard.expenses')}
                    </span>
                  </div>
                }
              />
              <div style={{ padding: '12px 16px 8px' }}>
                <BarChart
                  labels={data.series.map((s) => formatMonth(s.month, locale))}
                  series={[
                    { label: t('dashboard.revenue'), color: 'var(--chart-1)', values: data.series.map((s) => s.revenue) },
                    { label: t('dashboard.expenses'), color: 'var(--chart-2)', values: data.series.map((s) => s.expenses) },
                  ]}
                  format={(v) => fmt(v)}
                />
              </div>
            </Card>

            <QuickActions quick={quick} drafts={data.drafts} />
          </div>

          <div className="grid-2">
            <Card>
              <CardHeader title={t('dashboard.cashAccounts')} icon={<Landmark size={18} className="muted" />} />
              <div className="table-wrap">
                <table className="table table-compact">
                  <tbody>
                    {data.cashAccounts.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link to={`/reports/general-ledger?accountId=${a.id}`}>
                            <span className="faint num" style={{ marginInlineEnd: 8 }}>
                              {a.code}
                            </span>
                            {pick(a.name_en, a.name_ar)}
                          </Link>
                        </td>
                        <td className="end">
                          <Money v={a.balance} tone />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>


            <Card>
              <CardHeader
                title={t('dashboard.recent')}
                icon={<FileText size={18} className="muted" />}
                actions={
                  <Link to="/journal" className="btn btn-sm btn-ghost">
                    {t('common.viewAll')}
                  </Link>
                }
              />
              {data.recent.length === 0 ? (
                <EmptyState title={t('dashboard.nothingYet')} />
              ) : (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <tbody>
                      {data.recent.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link to={`/journal/${r.id}`} style={{ fontWeight: 550 }}>
                              {r.number}
                            </Link>
                            <div className="faint" style={{ fontSize: 12 }}>
                              {date(r.date)} · {t('journal.sources.' + r.source_type)}
                            </div>
                          </td>
                          <td className="end">
                            <Money v={r.total} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
          <div className="dash-widgets">
            {widgets.map((W, i) => (
              <W key={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const dashboardModule: WebModule = {
  id: 'dashboard',
  nav: [{ to: '/', label: 'nav.dashboard', icon: LayoutDashboard, section: 'overview', order: 0, end: true }],
  routes: [{ path: '/', element: <DashboardPage /> }],
  commands: [{ id: 'go-dashboard', label: 'nav.dashboard', icon: LayoutDashboard, group: 'navigate', to: '/', keywords: 'home لوحة' }],
};
