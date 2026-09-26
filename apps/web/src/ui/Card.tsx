import type { ReactNode } from 'react';

export function Card({ children, className = '', pad }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={`card ${pad ? 'card-pad' : ''} ${className}`}>{children}</div>;
}

export function CardHeader({ title, sub, actions, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card-header">
      {icon}
      <div style={{ minWidth: 0 }}>
        <h3>{title}</h3>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}
