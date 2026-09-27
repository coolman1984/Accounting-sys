import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Activity, History, LayoutGrid, Settings, ShieldCheck } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { formatDateTime } from '../../core/format';
import { PageHeader, Loading, Pager } from '../../ui/Page';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { BackupsTab, CompanyTab, DefaultsTab, FiscalTab, NetworkTab, NumberingTab } from './tabs';
import { AccessPage } from './access';
import { AppsPage, HealthPage } from './system';

const TABS = [
  { id: 'company', el: <CompanyTab />, perm: 'admin.settings.read' },
  { id: 'fiscal', el: <FiscalTab />, perm: 'gl.journal.read' },
  { id: 'defaults', el: <DefaultsTab />, perm: 'gl.accounts.read' },
  { id: 'numbering', el: <NumberingTab />, perm: 'admin.settings.read' },
  { id: 'backups', el: <BackupsTab />, perm: 'admin.backup.manage' },
  { id: 'network', el: <NetworkTab />, perm: 'admin.settings.read' },
];

function SettingsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const visible = TABS.filter((x) => can(x.perm));
  const tab = visible.find((x) => x.id === params.get('tab')) ?? visible[0];
  return (
    <div className="page">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="tabs" role="tablist">
        {visible.map((x) => (
          <button key={x.id} className="tab" role="tab" aria-selected={tab?.id === x.id} onClick={() => setParams({ tab: x.id }, { replace: true })}>
            {t('settings.tabs.' + x.id)}
          </button>
        ))}
      </div>
      {tab?.el}
    </div>
  );
}

interface AuditRow {
  id: number;
  at: string;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: number | null;
  summary: string | null;
}

const ACTION_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'cyan' | 'neutral'> = {
  post: 'green',
  void: 'red',
  delete: 'red',
  reverse: 'amber',
  close: 'amber',
  reopen: 'amber',
  create: 'blue',
  update: 'cyan',
};

function AuditPage() {
  const { t, locale } = useI18n();
  const [offset, setOffset] = useState(0);
  const { data, isLoading } = useApi<{ rows: AuditRow[]; total: number }>('/audit', { limit: 100, offset });
  return (
    <div className="page">
      <PageHeader title={t('settings.audit')} subtitle={t('settings.auditSubtitle')} />
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('common.time')}</th>
                    <th>{t('common.user')}</th>
                    <th>{t('common.actions')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('common.details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap muted">{formatDateTime(r.at, locale)}</td>
                      <td>{r.user_name ?? '—'}</td>
                      <td>
                        <Badge tone={ACTION_TONE[r.action] ?? 'neutral'} plain>
                          {r.action}
                        </Badge>
                      </td>
                      <td className="mono muted">
                        {r.entity}
                        {r.entity_id ? ` #${r.entity_id}` : ''}
                      </td>
                      <td>{r.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={data.total} limit={100} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * Administration (like SAP Basis, kept small): company settings, users &
 * roles, apps, system health, audit trail.
 */
export const adminModule: WebModule = {
  id: 'admin',
  nav: [
    { to: '/apps', label: 'nav.apps', icon: LayoutGrid, section: 'admin', order: 5, perm: 'admin.settings.read' },
    { to: '/settings', label: 'nav.settings', icon: Settings, section: 'admin', order: 10, perm: 'admin.settings.read' },
    { to: '/access', label: 'nav.access', icon: ShieldCheck, section: 'admin', order: 15, perm: 'admin.users.manage' },
    { to: '/audit', label: 'nav.audit', icon: History, section: 'admin', order: 20, perm: 'admin.audit.read' },
    { to: '/system/health', label: 'nav.health', icon: Activity, section: 'admin', order: 30, perm: 'admin.settings.read' },
  ],
  routes: [
    { path: '/settings', element: <SettingsPage /> },
    { path: '/access', element: <AccessPage /> },
    { path: '/audit', element: <AuditPage /> },
    { path: '/apps', element: <AppsPage /> },
    { path: '/system/health', element: <HealthPage /> },
  ],
  commands: [
    { id: 'go-settings', label: 'nav.settings', icon: Settings, group: 'navigate', to: '/settings', perm: 'admin.settings.read', keywords: 'preferences company إعدادات' },
    { id: 'go-access', label: 'nav.access', icon: ShieldCheck, group: 'navigate', to: '/access', perm: 'admin.users.manage', keywords: 'users roles permissions مستخدمين أدوار صلاحيات' },
    { id: 'go-audit', label: 'nav.audit', icon: History, group: 'navigate', to: '/audit', perm: 'admin.audit.read', keywords: 'log سجل' },
    { id: 'go-apps', label: 'nav.apps', icon: LayoutGrid, group: 'navigate', to: '/apps', perm: 'admin.settings.read', keywords: 'apps modules تطبيقات أقسام' },
    { id: 'go-health', label: 'nav.health', icon: Activity, group: 'navigate', to: '/system/health', perm: 'admin.settings.read', keywords: 'health check diagnose فحص سلامة' },
  ],
};
