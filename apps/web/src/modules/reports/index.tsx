import { Link } from 'react-router';
import { BarChart3, BookText, Clock, Droplets, FileSpreadsheet, Landmark, Percent, Scale, TrendingUp } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useI18n } from '../../core/i18n';
import { PageHeader } from '../../ui/Page';
import { useContributedReports } from '../../core/slots';
import { useSession } from '../../core/session';
import { AgingPage, GeneralLedgerPage, TaxSummaryPage, TrialBalancePage } from './ledgers';
import { BalanceSheetPage, CashFlowPage, IncomeStatementPage } from './statements';

const GROUPS = [
  {
    id: 'statements',
    items: [
      { to: '/reports/income-statement', title: 'reports.incomeStatement', desc: 'reports.incomeStatementDesc', icon: TrendingUp, color: 'var(--line-blue)' },
      { to: '/reports/balance-sheet', title: 'reports.balanceSheet', desc: 'reports.balanceSheetDesc', icon: Landmark, color: 'var(--line-purple)' },
      { to: '/reports/cash-flow', title: 'reports.cashFlow', desc: 'reports.cashFlowDesc', icon: Droplets, color: 'var(--line-teal)' },
    ],
  },
  {
    id: 'ledgers',
    items: [
      { to: '/reports/trial-balance', title: 'reports.trialBalance', desc: 'reports.trialBalanceDesc', icon: Scale, color: 'var(--line-amber)' },
      { to: '/reports/general-ledger', title: 'reports.generalLedger', desc: 'reports.generalLedgerDesc', icon: BookText, color: 'var(--line-blue)' },
    ],
  },
  {
    id: 'parties',
    items: [
      { to: '/reports/aging?type=receivable', title: 'reports.aging', desc: 'reports.agingDesc', icon: Clock, color: 'var(--line-pink)', app: ['sales', 'purchases'] },
    ],
  },
  {
    id: 'tax',
    items: [{ to: '/reports/tax', title: 'reports.taxSummary', desc: 'reports.taxSummaryDesc', icon: Percent, color: 'var(--line-purple)' }],
  },
];

function ReportsHub() {
  const { t } = useI18n();
  const { allowed } = useSession();
  // Other modules (e.g. inventory) contribute their own report tiles.
  const extra = useContributedReports().filter(allowed);
  const extraGroups = [...new Set(extra.map((r) => r.group))].map((g) => ({
    id: g,
    title: g,
    items: extra.filter((r) => r.group === g),
  }));
  const groups = [...GROUPS.map((g) => ({ ...g, title: 'reports.groups.' + g.id, items: g.items.filter((r) => allowed(r as { app?: string[] })) })), ...extraGroups].filter((g) => g.items.length);
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
  id: 'reports',
  nav: [{ to: '/reports', label: 'nav.reports', icon: BarChart3, section: 'insights', order: 10, perm: 'reports.read' }],
  routes: [
    { path: '/reports', element: <ReportsHub /> },
    { path: '/reports/trial-balance', element: <TrialBalancePage /> },
    { path: '/reports/general-ledger', element: <GeneralLedgerPage /> },
    { path: '/reports/income-statement', element: <IncomeStatementPage /> },
    { path: '/reports/balance-sheet', element: <BalanceSheetPage /> },
    { path: '/reports/cash-flow', element: <CashFlowPage /> },
    { path: '/reports/aging', element: <AgingPage /> },
    { path: '/reports/tax', element: <TaxSummaryPage /> },
  ],
  commands: [
    { id: 'go-reports', label: 'nav.reports', icon: BarChart3, group: 'navigate', to: '/reports', perm: 'reports.read', keywords: 'تقارير' },
    { id: 'go-is', label: 'reports.incomeStatement', icon: TrendingUp, group: 'navigate', to: '/reports/income-statement', perm: 'reports.read', keywords: 'profit loss p&l أرباح دخل' },
    { id: 'go-bs', label: 'reports.balanceSheet', icon: Landmark, group: 'navigate', to: '/reports/balance-sheet', perm: 'reports.read', keywords: 'ميزانية' },
    { id: 'go-tb', label: 'reports.trialBalance', icon: Scale, group: 'navigate', to: '/reports/trial-balance', perm: 'reports.read', keywords: 'ميزان مراجعة' },
    { id: 'go-gl', label: 'reports.generalLedger', icon: BookText, group: 'navigate', to: '/reports/general-ledger', perm: 'reports.read', keywords: 'ledger أستاذ' },
    { id: 'go-cf', label: 'reports.cashFlow', icon: Droplets, group: 'navigate', to: '/reports/cash-flow', perm: 'reports.read', keywords: 'تدفقات نقدية' },
    { id: 'go-aging', label: 'reports.aging', icon: Clock, group: 'navigate', to: '/reports/aging', perm: 'reports.read', app: ['sales', 'purchases'], keywords: 'أعمار ديون' },
    { id: 'go-tax', label: 'reports.taxSummary', icon: FileSpreadsheet, group: 'navigate', to: '/reports/tax', perm: 'reports.read', keywords: 'vat ضريبة' },
  ],
};
