import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../core/i18n';
import { normalizeDigits } from '../core/format';

export interface ComboOption {
  id: number;
  label: string;
  code?: string;
  meta?: ReactNode;
  /** Extra text to match on (e.g. the name in the other language). */
  search?: string;
}

/**
 * Searchable select built for fast data entry: type a code or part of a
 * name, arrows to move, Enter to pick. The list renders in a portal so it is
 * never clipped by scrolling tables.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  sm,
  autoFocus,
  disabled,
  invalid,
  'aria-label': ariaLabel,
}: {
  options: ComboOption[];
  value: number | null;
  onChange(id: number | null): void;
  placeholder?: string;
  sm?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  'aria-label'?: string;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const display = selected ? (selected.code ? `${selected.code} · ${selected.label}` : selected.label) : '';

  const filtered = useMemo(() => {
    const q = normalizeDigits(query).trim().toLowerCase();
    if (!q) return options.slice(0, 200);
    const starts: ComboOption[] = [];
    const contains: ComboOption[] = [];
    for (const o of options) {
      const code = (o.code ?? '').toLowerCase();
      const hay = `${o.label} ${o.search ?? ''}`.toLowerCase();
      if (code.startsWith(q) || o.label.toLowerCase().startsWith(q)) starts.push(o);
      else if (hay.includes(q) || code.includes(q)) contains.push(o);
    }
    return [...starts, ...contains].slice(0, 200);
  }, [options, query]);

  const place = () => {
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!inputRef.current?.contains(target) && !listRef.current?.contains(target)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  });

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const pick = (o: ComboOption | undefined) => {
    if (!o) return;
    onChange(o.id);
    close();
  };

  const below = rect ? window.innerHeight - rect.bottom > 280 || rect.top < 300 : true;

  return (
    <div className="combo">
      <input
        ref={inputRef}
        className={`input ${sm ? 'input-sm' : ''}`}
        value={open ? query : display}
        placeholder={open && display ? display : placeholder ?? t('common.select')}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={invalid}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        onFocus={() => {
          setOpen(true);
          setActive(Math.max(0, filtered.findIndex((o) => o.id === value)));
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            if (open && filtered[active]) {
              e.preventDefault();
              pick(filtered[active]);
            }
          } else if (e.key === 'Escape') {
            close();
          } else if (e.key === 'Tab') {
            if (open && query && filtered[active]) pick(filtered[active]);
            else close();
          } else if (e.key === 'Backspace' && !query && value != null && open) {
            onChange(null);
          }
        }}
      />
      {open &&
        rect &&
        createPortal(
          <div
            ref={listRef}
            className="combo-list"
            style={{
              position: 'fixed',
              left: document.dir === 'rtl' ? undefined : rect.left,
              right: document.dir === 'rtl' ? window.innerWidth - rect.right : undefined,
              top: below ? rect.bottom + 4 : undefined,
              bottom: below ? undefined : window.innerHeight - rect.top + 4,
              minWidth: rect.width,
            }}
            role="listbox"
          >
            {filtered.length === 0 && <div className="combo-empty">{t('common.noResults')}</div>}
            {filtered.map((o, i) => (
              <button
                key={o.id}
                type="button"
                className="combo-option"
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
              >
                {o.code && <span className="code">{o.code}</span>}
                <span>{o.label}</span>
                {o.meta && <span className="meta">{o.meta}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
