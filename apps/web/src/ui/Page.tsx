import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight, CircleAlert, Inbox } from 'lucide-react';
import { useI18n } from '../core/i18n';

export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
  badge,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  crumbs?: { to: string; label: ReactNode }[];
  badge?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div style={{ minWidth: 0 }}>
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs no-print">
            {crumbs.map((c, i) => (
              <span key={i} className="row" style={{ gap: 6 }}>
                <Link to={c.to}>{c.label}</Link>
                <ChevronRight className="flip-rtl" />
              </span>
            ))}
          </nav>
        )}
        <div className="row" style={{ gap: 12 }}>
          <h1>{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="actions no-print">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <Inbox size={22} />}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="loading-block">
      <div className="spinner" />
    </div>
  );
}

export function ErrorBlock({ message }: { message: ReactNode }) {
  return (
    <div className="notice danger" style={{ margin: 16 }}>
      <CircleAlert />
      <div>{message}</div>
    </div>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange(o: number): void }) {
  const { t } = useI18n();
  if (total <= limit) return null;
  return (
    <div className="row no-print" style={{ justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {t('common.showing', { from: offset + 1, to: Math.min(offset + limit, total), total })}
      </span>
      <button className="btn btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        {t('common.previous')}
      </button>
      <button className="btn btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        {t('common.next')}
      </button>
    </div>
  );
}
