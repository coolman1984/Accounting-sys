import { Link } from 'react-router';
import { BarChart3, BookText, Droplets, Landmark, PieChart, Scale, TrendingUp } from 'lucide-react';
import type { WebModule } from '../../../core/registry';
import { useI18n } from '../../../core/i18n';
import { PageHeader } from '../../../ui/Page';
import { useContributedReports } from '../../../core/slots';
import { useSession } from '../../../core/session';
import { GeneralLedgerPage, TrialBalancePage } from './ledgers';
import { BalanceSheetPage, CashFlowPage, EquityChangesPage, IncomeStatementPage } from './statements';

const GROUPS = [
  {
    id: 'statements',
    items: [
      { to: '/reports/income-statement', title: 'reports.incomeStatement', desc: 'reports.incomeStatementDesc', icon: TrendingUp, color: 'var(--line-blue)' },
      { to: '/reports/balance-sheet', title: 'reports.balanceSheet', desc: 'reports.balanceSheetDesc', icon: Landmark, color: 'var(--line-purple)' },
      { to: '/reports/cash-flow', title: 'reports.cashFlow', desc: 'reports.cashFlowDesc', icon: Droplets, color: 'var(--line-teal)' },
      { to: '/reports/equity-changes', title: 'reports.equityChanges', desc: 'reports.equityChangesDesc', icon: PieChart, color: 'var(--line-pink)' },
    ],
  },
  {
    id: 'ledgers',
    items: [
      { to: '/reports/trial-balance', title: 'reports.trialBalance', desc: 'reports.trialBalanceDesc', icon: Scale, color: 'var(--line-amber)' },
      { to: '/reports/general-ledger', title: 'reports.generalLedger', desc: 'reports.generalLedgerDesc', icon: BookText, color: 'var(--line-blue)' },
    ],
  },
];

function ReportsHub() {
  const { t } = useI18n();
  const { allowed, can } = useSession();
  // Other modules (e.g. inventory) contribute their own report tiles.
  const extra = useContributedReports().filter(allowed);
  const extraGroups = [...new Set(extra.map((r) => r.group))].map((g) => ({
    id: g,
    title: g,
    items: extra.filter((r) => r.group === g),
  }));
  const groups = [...GROUPS.map((g) => ({ ...g, title: 'reports.groups.' + g.id, items: can('gl.reports.read') ? g.items : [] })), ...extraGroups].filter((g) => g.items.length);
  return (
    <div className="page">
      <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} />
      <div className="stack" style={{ '--gap': '28px' } as React.CSSProperties}>
        {groups.map((g) => (
          <section key={g.id}>
            <div className="nav-section" style={{ padding: '0 2px 10px' }}>
              {t(g.title)}
            </div>
            <div className="feature-grid">
              {g.items.map((r) => {
                const Icon = r.icon;
                return (
                  <Link key={r.to} to={r.to} className="feature">
                    <Icon style={{ color: r.color }} />
                    <h3>{t(r.title)}</h3>
                    <p>{t(r.desc)}</p>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export const reportsModule: WebModule = {
  id: 'gl-reports',
  // The hub is open to everyone: each tile shows only for those allowed to open it.
  nav: [
    { to: '/reports/trial-balance', label: 'reports.trialBalance', icon: Scale, section: 'gl', order: 30, perm: 'gl.reports.read' },
    { to: '/reports/income-statement', label: 'reports.incomeStatement', icon: TrendingUp, section: 'gl', order: 40, perm: 'gl.reports.read' },
    { to: '/reports/balance-sheet', label: 'reports.balanceSheet', icon: Landmark, section: 'gl', order: 50, perm: 'gl.reports.read' },
    { to: '/reports/cash-flow', label: 'reports.cashFlow', icon: Droplets, section: 'gl', order: 55, perm: 'gl.reports.read' },
    { to: '/reports/equity-changes', label: 'reports.equityChanges', icon: PieChart, section: 'gl', order: 58, perm: 'gl.reports.read' },
    { to: '/reports', label: 'nav.reports', icon: BarChart3, section: 'insights', order: 10, end: true },
  ],
  routes: [
    { path: '/reports', element: <ReportsHub /> },
    { path: '/reports/trial-balance', element: <TrialBalancePage /> },
    { path: '/reports/general-ledger', element: <GeneralLedgerPage /> },
    { path: '/reports/income-statement', element: <IncomeStatementPage /> },
    { path: '/reports/balance-sheet', element: <BalanceSheetPage /> },
    { path: '/reports/cash-flow', element: <CashFlowPage /> },
    { path: '/reports/equity-changes', element: <EquityChangesPage /> },
  ],
  commands: [
    { id: 'go-reports', label: 'nav.reports', icon: BarChart3, group: 'navigate', to: '/reports', keywords: 'تقارير' },
    { id: 'go-is', label: 'reports.incomeStatement', icon: TrendingUp, group: 'navigate', to: '/reports/income-statement', perm: 'gl.reports.read', keywords: 'profit loss p&l أرباح دخل' },
    { id: 'go-bs', label: 'reports.balanceSheet', icon: Landmark, group: 'navigate', to: '/reports/balance-sheet', perm: 'gl.reports.read', keywords: 'ميزانية' },
    { id: 'go-tb', label: 'reports.trialBalance', icon: Scale, group: 'navigate', to: '/reports/trial-balance', perm: 'gl.reports.read', keywords: 'ميزان مراجعة' },
    { id: 'go-gl', label: 'reports.generalLedger', icon: BookText, group: 'navigate', to: '/reports/general-ledger', perm: 'gl.reports.read', keywords: 'ledger أستاذ' },
    { id: 'go-eq', label: 'reports.equityChanges', icon: PieChart, group: 'navigate', to: '/reports/equity-changes', perm: 'gl.reports.read', keywords: 'equity changes حقوق الملكية التغيرات' },
    { id: 'go-cf', label: 'reports.cashFlow', icon: Droplets, group: 'navigate', to: '/reports/cash-flow', perm: 'gl.reports.read', keywords: 'تدفقات نقدية' },
  ],
};
