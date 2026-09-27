import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, CircleAlert, LayoutGrid, RefreshCw, XCircle } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession, type AppInfo } from '../../core/session';
import { api } from '../../core/api';
import { toggleApp } from '../../core/apps';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { AppCard } from '../../ui/AppCard';

// ------------------------------------------------------------------ apps
export function AppsPage() {
  const { t } = useI18n();
  const { can, refresh } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const errText = useErrorText();
  const { data: apps, isLoading, refetch } = useApi<AppInfo[]>('/system/apps');
  const save = useApiMutation((enabled: string[]) => api.put<AppInfo[]>('/system/apps', { enabled }));
  const manage = can('admin.settings.manage');

  const toggle = async (id: string, on: boolean) => {
    if (!apps) return;
    const current = new Set(apps.filter((a) => a.enabled && !a.core).map((a) => a.id));
    const next = toggleApp(apps, current, id, on);
    const off = [...current].filter((x) => !next.has(x));
    const added = [...next].filter((x) => !current.has(x) && x !== id);
    if (!on) {
      const names = off.map((x) => t(`apps.${x}.name`)).join('، ');
      const ok = await confirm({ title: t('apps.offTitle', { name: names }), body: t('apps.offText'), confirmLabel: t('apps.turnOff') });
      if (!ok.ok) return;
    }
    save.mutate([...next], {
      onSuccess: async () => {
        await refresh();
        await qc.invalidateQueries();
        void refetch();
        toast.success(on ? t('apps.onDone', { name: [id, ...added].map((x) => t(`apps.${x}.name`)).join(' + ') }) : t('apps.offDone'));
      },
      onError: (e) => toast.error(errText(e)),
    });
  };

  return (
    <div className="page">
      <PageHeader title={t('apps.title')} subtitle={t('apps.subtitle')} />
      {isLoading || !apps ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '18px' } as React.CSSProperties}>
          {!manage && (
            <div className="notice">
              <CircleAlert />
              <div>{t('apps.adminOnly')}</div>
            </div>
          )}
          <div className="app-grid">
            {apps.map((a) => (
              <AppCard key={a.id} app={a} on={a.enabled} busy={save.isPending || !manage} onToggle={(v) => void toggle(a.id, v)} />
            ))}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {t('apps.dataKept')}
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ health
interface ModuleHealth {
  module: string;
  ms: number;
  error?: string;
  checks: { id: string; ok: boolean; severity?: 'error' | 'warning'; details?: Record<string, string | number> }[];
}

export function HealthPage() {
  const { t } = useI18n();
  const { fmt } = useMoney();
  const { data, isLoading, refetch, isFetching } = useApi<ModuleHealth[]>('/system/health', undefined, { staleTime: 0 });
  const problems = (data ?? []).reduce((n, m) => n + (m.error ? 1 : 0) + m.checks.filter((c) => !c.ok && c.severity !== 'warning').length, 0);
  const warnings = (data ?? []).reduce((n, m) => n + m.checks.filter((c) => !c.ok && c.severity === 'warning').length, 0);
  // Amounts in details are minor units; counts and days are plain numbers.
  const money = new Set(['difference', 'stock', 'ledger', 'open']);
  const detail = (d?: Record<string, string | number>) =>
    Object.fromEntries(Object.entries(d ?? {}).map(([k, v]) => [k, money.has(k) && typeof v === 'number' ? fmt(v) : v]));

  return (
    <div className="page">
      <PageHeader
        title={t('health.title')}
        subtitle={t('health.subtitle')}
        actions={
          <Button icon={<RefreshCw className={isFetching ? 'spin' : ''} />} onClick={() => void refetch()}>
            {t('health.runAgain')}
          </Button>
        }
      />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '18px' } as React.CSSProperties}>
          <div className={`health-banner ${problems ? 'bad' : warnings ? 'warn' : 'good'}`}>
            {problems ? <XCircle /> : warnings ? <AlertTriangle /> : <CheckCircle2 />}
            <div>
              <strong>{problems ? t('health.problems', { n: problems }) : warnings ? t('health.warnings', { n: warnings }) : t('health.allGood')}</strong>
              <div>{t('health.explain')}</div>
            </div>
          </div>
          <div className="grid-2">
            {data.map((m) => {
              const bad = !!m.error || m.checks.some((c) => !c.ok && c.severity !== 'warning');
              return (
                <Card key={m.module}>
                  <CardHeader
                    title={t(`health.modules.${m.module}`)}
                    sub={t('health.module', { id: m.module, ms: m.ms })}
                    actions={bad ? <Badge tone="red">{t('health.fault')}</Badge> : <Badge tone="green">{t('health.ok')}</Badge>}
                  />
                  <div className="card-body stack" style={{ '--gap': '10px' } as React.CSSProperties}>
                    {m.error && (
                      <div className="health-row bad">
                        <XCircle size={16} />
                        <span className="mono" style={{ fontSize: 12.5 }}>
                          {m.error}
                        </span>
                      </div>
                    )}
                    {m.checks.map((c) => (
                      <div key={c.id} className={`health-row ${c.ok ? 'ok' : c.severity === 'warning' ? 'warn' : 'bad'}`}>
                        {c.ok ? <CheckCircle2 size={16} /> : c.severity === 'warning' ? <AlertTriangle size={16} /> : <XCircle size={16} />}
                        <span>{t(`health.${m.module}.${c.id}${c.ok ? '' : 'Bad'}`, detail(c.details))}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

