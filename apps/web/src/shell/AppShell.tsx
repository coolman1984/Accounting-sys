import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { KeyRound, LogOut, Menu, Search } from 'lucide-react';
import { useI18n } from '../core/i18n';
import { useSession } from '../core/session';
import { api } from '../core/api';
import { SECTION_ORDER, type Command, type NavItem } from '../core/registry';
import { Kbd, LangToggle, Logo, modKey, ThemeToggle } from '../ui/Brand';
import { CommandPalette } from './CommandPalette';
import { ChangePasswordDialog } from './ChangePassword';

export function AppShell({ nav, commands }: { nav: NavItem[]; commands: Command[] }) {
  const { t } = useI18n();
  const { user, company, info, can, logout } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pwd, setPwd] = useState(false);
  const location = useLocation();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const sections = useMemo(() => {
    const visible = nav.filter((n) => !n.perm || can(n.perm));
    return SECTION_ORDER.map((s) => ({ s, items: visible.filter((n) => n.section === s).sort((a, b) => a.order - b.order) })).filter(
      (g) => g.items.length > 0,
    );
  }, [nav, can]);

  const initials = (user?.displayName ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <Logo company={company?.name} />
        </div>
        <nav className="nav">
          {sections.map(({ s, items }) => (
            <div key={s} style={{ display: 'contents' }}>
              {s !== 'overview' && <div className="nav-section">{t('nav.' + s)}</div>}
              {items.map((n) => {
                const Icon = n.icon;
                return (
                  <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                    <Icon />
                    <span>{t(n.label)}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {t('app.name')} · {t('shell.version', { v: info?.version ?? '' })}
        </div>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon mobile-only" onClick={() => setNavOpen(true)} aria-label={t('shell.openMenu')}>
            <Menu />
          </button>
          <button className="search-trigger" onClick={() => setPalette(true)} aria-label={t('shell.searchPlaceholder')}>
            <Search />
            <span className="label-text">{t('shell.searchPlaceholder')}</span>
            <span className="kbds">
              <Kbd>{modKey}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <div className="right">
            <ThemeToggle />
            <LangToggle onChange={(l) => void api.put('/auth/me', { locale: l }).catch(() => undefined)} />
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button className="avatar" style={{ cursor: 'pointer' }} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
                {initials}
              </button>
              {menu && (
                <div className="menu" role="menu">
                  <div className="menu-head">
                    <div className="faint" style={{ fontSize: 12 }}>
                      {t('shell.signedInAs')}
                    </div>
                    <div style={{ fontWeight: 600 }}>{user?.displayName}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      @{user?.username} · {t('settings.roles.' + user?.role)}
                    </div>
                  </div>
                  <div className="menu-sep" />
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMenu(false);
                      setPwd(true);
                    }}
                  >
                    <KeyRound /> {t('shell.changePassword')}
                  </button>
                  <button className="menu-item" onClick={() => void logout()}>
                    <LogOut className="flip-rtl" /> {t('shell.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <ChangePasswordDialog open={pwd} onClose={() => setPwd(false)} />
    </div>
  );
}
