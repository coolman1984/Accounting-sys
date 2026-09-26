import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { History, Settings } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { formatDateTime } from '../../core/format';
import { PageHeader, Loading, Pager } from '../../ui/Page';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { BackupsTab, CompanyTab, DefaultsTab, FiscalTab, NetworkTab, NumberingTab, UsersTab } from './tabs';

const TABS = [
  { id: 'company', el: <CompanyTab />, perm: 'settings.read' },
  { id: 'users', el: <UsersTab />, perm: 'users.manage' },
  { id: 'fiscal', el: <FiscalTab />, perm: 'journal.read' },
  { id: 'defaults', el: <DefaultsTab />, perm: 'accounts.read' },
  { id: 'numbering', el: <NumberingTab />, perm: 'settings.read' },
  { id: 'backups', el: <BackupsTab />, perm: 'system.backup' },
  { id: 'network', el: <NetworkTab />, perm: 'settings.read' },
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

export const settingsModule: WebModule = {
  id: 'settings',
  nav: [
    { to: '/settings', label: 'nav.settings', icon: Settings, section: 'admin', order: 10, perm: 'settings.read' },
    { to: '/audit', label: 'nav.audit', icon: History, section: 'admin', order: 20, perm: 'audit.read' },
  ],
  routes: [
    { path: '/settings', element: <SettingsPage /> },
    { path: '/audit', element: <AuditPage /> },
  ],
  commands: [
    { id: 'go-settings', label: 'nav.settings', icon: Settings, group: 'navigate', to: '/settings', perm: 'settings.read', keywords: 'preferences company users إعدادات' },
    { id: 'go-audit', label: 'nav.audit', icon: History, group: 'navigate', to: '/audit', perm: 'audit.read', keywords: 'log سجل' },
  ],
};
