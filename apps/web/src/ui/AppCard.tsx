import { Check, Lock } from 'lucide-react';
import { useI18n } from '../core/i18n';
import { APP_META, type AppLike } from '../core/apps';
import { Switch } from './Switch';

/** One app of the catalogue: what it does, what it needs, and its switch. */
export function AppCard({ app, on, onToggle, busy, compact }: { app: AppLike; on: boolean; onToggle(v: boolean): void; busy?: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const meta = APP_META[app.id] ?? { icon: Check, color: 'var(--primary)' };
  const Icon = meta.icon;
  return (
    <div className={`app-card ${on ? 'on' : ''} ${compact ? 'compact' : ''}`} style={{ '--app': meta.color } as React.CSSProperties}>
      <div className="app-card-head">
        <span className="app-icon">
          <Icon />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="app-name">{t(`apps.${app.id}.name`)}</div>
          <div className="app-desc">{t(`apps.${app.id}.desc`)}</div>
        </div>
        {app.core ? (
          <span className="app-core" title={t('apps.coreHint')}>
            <Lock size={12} /> {t('apps.core')}
          </span>
        ) : (
          <Switch checked={on} onChange={onToggle} disabled={busy} label={t(`apps.${app.id}.name`)} />
        )}
      </div>
      {!compact && (
        <ul className="app-features">
          {(['f1', 'f2', 'f3'] as const).map((f) => (
            <li key={f}>
              <Check size={13} /> {t(`apps.${app.id}.${f}`)}
            </li>
          ))}
        </ul>
      )}
      {app.requires.length > 0 && (
        <div className="app-requires">
          {t('apps.requires')}: {app.requires.map((r) => t(`apps.${r}.name`)).join(' · ')}
        </div>
      )}
    </div>
  );
}
