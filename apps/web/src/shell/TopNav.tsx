import { useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../core/i18n';
import type { NavItem, NavSection } from '../core/registry';
import { Popover } from '../ui/Popover';

/**
 * The menus as a horizontal bar (like Odoo): one dropdown per section,
 * the section holding the current page is highlighted.
 */
export function TopNav({ sections }: { sections: { s: NavSection; items: NavItem[] }[] }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const within = (n: NavItem) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(n.to + '/'));
  return (
    <nav className="topnav" aria-label={t('shell.menu')}>
      {sections.map(({ s, items }) =>
        s === 'overview' ? (
          items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `topnav-btn ${isActive ? 'active' : ''}`}>
              {t(n.label)}
            </NavLink>
          ))
        ) : (
          <SectionMenu key={s} label={t('sections.' + s)} items={items} active={items.some(within)} within={within} />
        ),
      )}
    </nav>
  );
}

function SectionMenu({ label, items, active, within }: { label: string; items: NavItem[]; active: boolean; within(n: NavItem): boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} className={`topnav-btn ${active ? 'active' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <ChevronDown size={14} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={250}>
        <div className="menu" role="menu">
          {items.map((n) => {
            const Icon = n.icon;
            return (
              <NavLink key={n.to} to={n.to} end={n.end} role="menuitem" className="menu-item" aria-current={within(n) ? 'page' : undefined} onClick={() => setOpen(false)}>
                <Icon /> {t(n.label)}
              </NavLink>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
