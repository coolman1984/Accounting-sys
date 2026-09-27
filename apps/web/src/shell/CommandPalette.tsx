import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Languages, Search, SunMoon } from 'lucide-react';
import { useI18n } from '../core/i18n';
import { useTheme } from '../core/theme';
import { useSession } from '../core/session';
import { api } from '../core/api';
import type { Command } from '../core/registry';
import { Kbd } from '../ui/Brand';

interface Item {
  id: string;
  label: string;
  icon: Command['icon'];
  group: string;
  keys?: string[];
  run(): void;
  hay: string;
}

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose(): void; commands: Command[] }) {
  const { t, locale, setLocale } = useI18n();
  const { toggle } = useTheme();
  const { allowed, user } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = commands
      .filter(allowed)
      .map((c) => ({
        id: c.id,
        label: t(c.label),
        icon: c.icon,
        group: c.group,
        keys: c.keys,
        run: () => navigate(c.to),
        hay: `${t(c.label)} ${c.keywords ?? ''} ${c.to}`.toLowerCase(),
      }));
    out.push(
      { id: 'theme', label: t('palette.toggleTheme'), icon: SunMoon, group: 'preferences', run: toggle, hay: 'theme dark light الوضع' },
      {
        id: 'lang',
        label: t('palette.toggleLanguage'),
        icon: Languages,
        group: 'preferences',
        run: () => {
          const next = locale === 'ar' ? 'en' : 'ar';
          setLocale(next);
          if (user) void api.put('/auth/me', { locale: next }).catch(() => undefined);
        },
        hay: 'language arabic english لغة عربي',
      },
    );
    return out;
  }, [commands, allowed, t, navigate, toggle, locale, setLocale, user]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => s.split(/\s+/).every((w) => i.hay.includes(w))) : items;
  }, [items, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  const groups = ['create', 'navigate', 'preferences'];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true">
        <div className="palette-search">
          <Search />
          <input
            autoFocus
            value={q}
            placeholder={t('palette.placeholder')}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(filtered[active]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="combo-empty">{t('common.noResults')}</div>}
          {groups.map((g) => {
            const list = filtered.filter((i) => i.group === g);
            if (!list.length) return null;
            return (
              <div key={g}>
                <div className="palette-group">{t(g === 'preferences' ? 'palette.preferences' : g === 'create' ? 'palette.create' : 'palette.navigate')}</div>
                {list.map((i) => {
                  const Icon = i.icon;
                  const my = filtered.indexOf(i);
                  return (
                    <button key={i.id} className="palette-item" data-active={my === active} onMouseEnter={() => setActive(my)} onClick={() => run(i)}>
                      <Icon />
                      <span>{i.label}</span>
                      {i.keys && (
                        <span className="kbds">
                          {i.keys.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="palette-footer">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {t('palette.move')}
          </span>
          <span>
            <Kbd>↵</Kbd> {t('palette.open')}
          </span>
        </div>
      </div>
    </div>
  );
}
