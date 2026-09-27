import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Filter,
  Layers,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '../core/i18n';
import { useDate, useMoney } from '../core/hooks';
import { formatQty, normalizeDigits, QTY_SCALE } from '../core/format';
import { csvMoney, downloadCsv } from '../lib/csv';
import { Popover } from './Popover';
import { DecimalInput, Input } from './Field';
import { Button } from './Button';
import { Loading } from './Page';

// ---------------------------------------------------------------- types
export type ColType = 'text' | 'enum' | 'number' | 'money' | 'qty' | 'date';
type Value = string | number | null | undefined;

export interface Column<T> {
  id: string;
  header: string;
  type?: ColType;
  /** Raw value used to filter, sort, group and export. */
  value(row: T): Value;
  /** How the cell looks (defaults to the formatted value). */
  render?(row: T): ReactNode;
  /** Text for a value in filters, groups and exports (enums: translated labels). */
  format?(v: Value): string;
  /** Sum in the footer and in group headers. */
  total?: boolean;
  /** Hidden until the user shows it from the Columns menu. */
  hidden?: boolean;
  width?: number;
  nowrap?: boolean;
  /** Cannot be hidden (the identifying column). */
  pinned?: boolean;
}

/** A named quick filter, like Odoo's predefined filters ("Overdue"). */
export interface Preset<T> {
  id: string;
  label: string;
  test(row: T): boolean;
}

type ColFilter =
  | { kind: 'set'; values: string[] }
  | { kind: 'range'; min: number | null; max: number | null }
  | { kind: 'dates'; from: string; to: string }
  | { kind: 'text'; q: string };

interface GridState {
  q: string;
  preset: string;
  sort: { id: string; dir: 1 | -1 } | null;
  filters: Record<string, ColFilter>;
  hidden: string[] | null;
  group: string | null;
}

interface SavedView {
  name: string;
  state: GridState;
}

const EMPTY: GridState = { q: '', preset: '', sort: null, filters: {}, hidden: null, group: null };
const PAGE = 100;
const BLANK = '\u0000';

// Per-viewer memory (last state and favourites); never required to work.
const store = {
  get<T>(key: string, def: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : def;
    } catch {
      return def;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

const keyOf = (v: Value) => (v == null || v === '' ? BLANK : String(v));
const isNum = (t: ColType) => t === 'number' || t === 'money' || t === 'qty';

// ---------------------------------------------------------------- grid
/**
 * The list screen of the system: every column can be sorted and filtered on
 * its own (Excel-style value lists, ranges, dates), rows can be grouped with
 * subtotals, columns shown or hidden, and the whole layout saved as a
 * favourite. Works on the rows it is given, in the browser.
 */
export function DataGrid<T>({
  id,
  rows,
  columns,
  rowKey,
  onRowClick,
  loading,
  empty,
  presets,
  toolbar,
  exportName,
  initialGroup,
  initialPreset,
}: {
  /** Stable name — the grid remembers its layout per id. */
  id: string;
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey(row: T): string | number;
  onRowClick?(row: T): void;
  loading?: boolean;
  empty?: ReactNode;
  presets?: Preset<T>[];
  toolbar?: ReactNode;
  exportName?: string;
  initialGroup?: string;
  /** Opens with this quick filter on (e.g. a dashboard link to "Overdue"). */
  initialPreset?: string;
}) {
  const { t, locale } = useI18n();
  const date = useDate();
  const { fmt, scale } = useMoney();
  const stateKey = `mizan.grid.${id}`;
  const [state, setState] = useState<GridState>(() => {
    const saved = { ...EMPTY, group: initialGroup ?? null, ...store.get<Partial<GridState>>(stateKey, {}) };
    return initialPreset ? { ...saved, preset: initialPreset } : saved;
  });
  const [views, setViews] = useState<SavedView[]>(() => store.get<SavedView[]>(`${stateKey}.views`, []));
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => store.set(stateKey, state), [stateKey, state]);
  useEffect(() => setPage(0), [state.q, state.preset, state.filters, state.sort, state.group]);
  const patch = useCallback((p: Partial<GridState>) => setState((s) => ({ ...s, ...p })), []);

  const colById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const hidden = new Set(state.hidden ?? columns.filter((c) => c.hidden).map((c) => c.id));
  const visible = columns.filter((c) => !hidden.has(c.id) || c.pinned);

  /** Text for a value: the column's own formatter, else by type. */
  const text = useCallback(
    (c: Column<T>, v: Value): string => {
      if (c.format) return c.format(v);
      if (v == null || v === '') return '';
      const type = c.type ?? 'text';
      if (type === 'money') return fmt(Number(v));
      if (type === 'qty') return formatQty(Number(v), locale);
      if (type === 'date') return date(String(v));
      return String(v);
    },
    [fmt, locale, date],
  );

  // ---- filtering -----------------------------------------------------------
  const passes = useCallback(
    (row: T, skip?: string) => {
      for (const [cid, f] of Object.entries(state.filters)) {
        if (cid === skip) continue;
        const c = colById.get(cid);
        if (!c) continue;
        const v = c.value(row);
        if (f.kind === 'set' && !f.values.includes(keyOf(v))) return false;
        if (f.kind === 'range') {
          if (v == null) return false;
          if (f.min != null && Number(v) < f.min) return false;
          if (f.max != null && Number(v) > f.max) return false;
        }
        if (f.kind === 'dates') {
          const s = v == null ? '' : String(v);
          if (!s || (f.from && s < f.from) || (f.to && s > f.to)) return false;
        }
        if (f.kind === 'text' && !text(c, v).toLowerCase().includes(f.q.toLowerCase())) return false;
      }
      return true;
    },
    [state.filters, colById, text],
  );

  const base = useMemo(() => {
    let out = rows ?? [];
    const preset = presets?.find((p) => p.id === state.preset);
    if (preset) out = out.filter(preset.test);
    const q = normalizeDigits(state.q).trim().toLowerCase();
    if (q) out = out.filter((r) => columns.some((c) => text(c, c.value(r)).toLowerCase().includes(q)));
    return out;
  }, [rows, presets, state.preset, state.q, columns, text]);

  const filtered = useMemo(() => {
    const out = base.filter((r) => passes(r));
    if (!state.sort) return out;
    const c = colById.get(state.sort.id);
    if (!c) return out;
    const dir = state.sort.dir;
    const num = isNum(c.type ?? 'text');
    return [...out].sort((a, b) => {
      const x = c.value(a);
      const y = c.value(b);
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      if (num) return (Number(x) - Number(y)) * dir;
      return text(c, x).localeCompare(text(c, y), locale) * dir;
    });
  }, [base, passes, state.sort, colById, text, locale]);

  // ---- grouping ------------------------------------------------------------
  const groupCol = state.group ? colById.get(state.group) : undefined;
  const groupKey = useCallback(
    (row: T) => {
      if (!groupCol) return '';
      const v = groupCol.value(row);
      // Dates group by month.
      return groupCol.type === 'date' && v ? String(v).slice(0, 7) : keyOf(v);
    },
    [groupCol],
  );
  const groups = useMemo(() => {
    if (!groupCol) return null;
    const m = new Map<string, T[]>();
    for (const r of filtered) {
      const k = groupKey(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    const keys = [...m.keys()];
    if (state.sort?.id !== groupCol.id) keys.sort((a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : a.localeCompare(b, locale, { numeric: true })));
    return keys.map((k) => ({ key: k, rows: m.get(k)! }));
  }, [filtered, groupCol, groupKey, state.sort, locale]);
  const groupLabel = (k: string) => {
    if (k === BLANK) return t('grid.blank');
    if (groupCol?.type === 'date') {
      const [y, mo] = k.split('-').map(Number);
      return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric' }).format(new Date(y, mo - 1, 1));
    }
    return groupCol ? text(groupCol, k) : k;
  };

  const sum = (list: T[], c: Column<T>) => list.reduce((s, r) => s + (Number(c.value(r)) || 0), 0);
  const hasTotals = visible.some((c) => c.total);

  // ---- export --------------------------------------------------------------
  const exportCsv = () =>
    downloadCsv(
      exportName ?? id,
      visible.map((c) => c.header),
      filtered.map((r) =>
        visible.map((c) => {
          const v = c.value(r);
          if (v == null) return '';
          if (c.type === 'money') return csvMoney(Number(v), scale);
          if (c.type === 'qty') return Number(v) / 1000;
          if (c.type === 'date') return String(v);
          return c.format ? c.format(v) : v;
        }),
      ),
    );

  // ---- views ---------------------------------------------------------------
  const saveViews = (v: SavedView[]) => {
    setViews(v);
    store.set(`${stateKey}.views`, v);
  };

  const activeChips = Object.entries(state.filters)
    .map(([cid, f]) => ({ c: colById.get(cid), f, cid }))
    .filter((x) => x.c);
  const anything = activeChips.length > 0 || !!state.q || !!state.preset || !!state.group;
  const shown = groups ? filtered : filtered.slice(page * PAGE, (page + 1) * PAGE);

  const cell = (c: Column<T>, r: T) => (c.render ? c.render(r) : text(c, c.value(r)));
  const align = (c: Column<T>) => (isNum(c.type ?? 'text') ? 'end' : '');

  return (
    <div className="grid-shell">
      <div className="grid-toolbar">
        <div className="input-group grid-search">
          <Search />
          <input className="input" placeholder={t('common.search')} value={state.q} onChange={(e) => patch({ q: e.target.value })} />
        </div>
        {presets && presets.length > 0 && (
          <div className="segmented">
            <button aria-pressed={!state.preset} onClick={() => patch({ preset: '' })}>
              {t('common.all')}
            </button>
            {presets.map((p) => (
              <button key={p.id} aria-pressed={state.preset === p.id} onClick={() => patch({ preset: state.preset === p.id ? '' : p.id })}>
                {p.label}
              </button>
            ))}
          </div>
        )}
        {toolbar}
        <span className="spacer" />
        <GroupMenu columns={columns} value={state.group} onChange={(group) => (patch({ group }), setCollapsed(new Set()))} />
        <ColumnsMenu columns={columns} hidden={hidden} onChange={(h) => patch({ hidden: h })} />
        <FavoritesMenu
          views={views}
          onApply={(v) => setState({ ...EMPTY, ...v.state })}
          onSave={(name) => saveViews([...views.filter((v) => v.name !== name), { name, state }])}
          onDelete={(name) => saveViews(views.filter((v) => v.name !== name))}
        />
        <Button size="sm" icon={<Download />} onClick={exportCsv} disabled={!filtered.length} title={t('grid.export')}>
          CSV
        </Button>
      </div>

      {anything && (
        <div className="grid-chips">
          {state.preset && presets && (
            <Chip label={t('grid.filter')} value={presets.find((p) => p.id === state.preset)?.label ?? ''} onClear={() => patch({ preset: '' })} />
          )}
          {state.q && <Chip label={t('common.search')} value={state.q} onClear={() => patch({ q: '' })} />}
          {activeChips.map(({ c, f, cid }) => (
            <Chip key={cid} label={c!.header} value={describe(f, c!, text, t)} onClear={() => patch({ filters: omit(state.filters, cid) })} />
          ))}
          {groupCol && <Chip icon={<Layers size={12} />} label={t('grid.groupBy')} value={groupCol.header} onClear={() => patch({ group: null })} />}
          <button className="grid-clear" onClick={() => patch({ q: '', preset: '', filters: {}, group: null })}>
            {t('grid.clearAll')}
          </button>
        </div>
      )}

      {loading || !rows ? (
        <Loading />
      ) : !rows.length ? (
        empty
      ) : (
        <>
          <div className="table-wrap">
            <table className="table grid-table">
              <thead>
                <tr>
                  {visible.map((c) => (
                    <HeaderCell
                      key={c.id}
                      col={c}
                      sort={state.sort?.id === c.id ? state.sort.dir : 0}
                      filter={state.filters[c.id]}
                      onSort={(dir) => patch({ sort: dir ? { id: c.id, dir } : null })}
                      onFilter={(f) => patch({ filters: f ? { ...state.filters, [c.id]: f } : omit(state.filters, c.id) })}
                      options={() => {
                        // Values offered in the list = rows passing every other filter (like Excel).
                        const counts = new Map<string, number>();
                        for (const r of base) if (passes(r, c.id)) counts.set(keyOf(c.value(r)), (counts.get(keyOf(c.value(r))) ?? 0) + 1);
                        return [...counts.entries()]
                          .map(([k, n]) => ({ key: k, label: k === BLANK ? t('grid.blank') : text(c, isNum(c.type ?? 'text') ? Number(k) : k), n }))
                          .sort((a, b) => (isNum(c.type ?? 'text') || c.type === 'date' ? a.key.localeCompare(b.key, 'en', { numeric: true }) : a.label.localeCompare(b.label, locale)));
                      }}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {!filtered.length && (
                  <tr>
                    <td colSpan={visible.length} className="center muted" style={{ padding: 32 }}>
                      {t('grid.noMatches')}{' '}
                      <button className="link-btn" onClick={() => patch({ q: '', preset: '', filters: {} })}>
                        {t('grid.clearAll')}
                      </button>
                    </td>
                  </tr>
                )}
                {groups
                  ? groups.map((g) => {
                      const open = !collapsed.has(g.key);
                      return (
                        <Fragment key={g.key}>
                          <tr
                            className="grid-group"
                            onClick={() =>
                              setCollapsed((s) => {
                                const n = new Set(s);
                                if (n.has(g.key)) n.delete(g.key);
                                else n.add(g.key);
                                return n;
                              })
                            }
                          >
                            {visible.map((c, i) =>
                              i === 0 ? (
                                <td key={c.id}>
                                  <span className="row" style={{ gap: 6 }}>
                                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} className="flip-rtl" />}
                                    {groupLabel(g.key)}
                                    <span className="grid-count">{g.rows.length}</span>
                                  </span>
                                </td>
                              ) : (
                                <td key={c.id} className={align(c)}>
                                  {c.total ? text({ ...c, format: undefined, render: undefined }, sum(g.rows, c)) : ''}
                                </td>
                              ),
                            )}
                          </tr>
                          {open &&
                            g.rows.map((r) => (
                              <tr key={rowKey(r)} className={onRowClick ? 'clickable' : ''} onClick={() => onRowClick?.(r)}>
                                {visible.map((c) => (
                                  <td key={c.id} className={`${align(c)} ${c.nowrap ? 'nowrap' : ''}`}>
                                    {cell(c, r)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })
                  : shown.map((r) => (
                      <tr key={rowKey(r)} className={onRowClick ? 'clickable' : ''} onClick={() => onRowClick?.(r)}>
                        {visible.map((c) => (
                          <td key={c.id} className={`${align(c)} ${c.nowrap ? 'nowrap' : ''}`} style={c.width ? { width: c.width } : undefined}>
                            {cell(c, r)}
                          </td>
                        ))}
                      </tr>
                    ))}
              </tbody>
              {hasTotals && filtered.length > 0 && (
                <tfoot>
                  <tr>
                    {visible.map((c, i) => (
                      <td key={c.id} className={align(c)}>
                        {i === 0 ? t('common.total') : c.total ? text({ ...c, format: undefined, render: undefined }, sum(filtered, c)) : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="grid-footer">
            <span className="muted">
              {filtered.length === rows.length ? t('grid.rows', { n: rows.length }) : t('grid.rowsOf', { n: filtered.length, total: rows.length })}
            </span>
            <span className="spacer" />
            {!groups && filtered.length > PAGE && (
              <div className="row" style={{ gap: 6 }}>
                <span className="muted num">
                  {page * PAGE + 1}–{Math.min((page + 1) * PAGE, filtered.length)}
                </span>
                <Button size="sm" iconOnly icon={<ChevronLeft className="flip-rtl" />} disabled={page === 0} onClick={() => setPage(page - 1)} />
                <Button size="sm" iconOnly icon={<ChevronRight className="flip-rtl" />} disabled={(page + 1) * PAGE >= filtered.length} onClick={() => setPage(page + 1)} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function omit<V>(o: Record<string, V>, k: string): Record<string, V> {
  const n = { ...o };
  delete n[k];
  return n;
}

function describe<T>(f: ColFilter, c: Column<T>, text: (c: Column<T>, v: Value) => string, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (f.kind === 'set') {
    if (f.values.length === 1) return f.values[0] === BLANK ? t('grid.blank') : text(c, isNum(c.type ?? 'text') ? Number(f.values[0]) : f.values[0]);
    return t('grid.nSelected', { n: f.values.length });
  }
  if (f.kind === 'text') return `“${f.q}”`;
  if (f.kind === 'range') {
    const a = f.min != null ? text({ ...c, format: undefined }, f.min) : '';
    const b = f.max != null ? text({ ...c, format: undefined }, f.max) : '';
    return a && b ? `${a} – ${b}` : a ? `≥ ${a}` : `≤ ${b}`;
  }
  const a = f.from ? text({ ...c, format: undefined }, f.from) : '';
  const b = f.to ? text({ ...c, format: undefined }, f.to) : '';
  return a && b ? `${a} – ${b}` : a ? `≥ ${a}` : `≤ ${b}`;
}

function Chip({ label, value, onClear, icon }: { label: string; value: string; onClear(): void; icon?: ReactNode }) {
  return (
    <span className="grid-chip">
      {icon}
      <span className="faint">{label}:</span>
      <span>{value}</span>
      <button onClick={onClear} aria-label="×">
        <X size={12} />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- header cell
function HeaderCell<T>({
  col,
  sort,
  filter,
  onSort,
  onFilter,
  options,
}: {
  col: Column<T>;
  sort: 0 | 1 | -1;
  filter: ColFilter | undefined;
  onSort(dir: 0 | 1 | -1): void;
  onFilter(f: ColFilter | null): void;
  options(): { key: string; label: string; n: number }[];
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const type = col.type ?? 'text';
  const end = isNum(type);
  return (
    <th className={end ? 'end' : ''} style={col.width ? { width: col.width } : undefined} aria-sort={sort === 1 ? 'ascending' : sort === -1 ? 'descending' : undefined}>
      <span className={`grid-th ${end ? 'end' : ''}`}>
        <button className="grid-th-label" onClick={() => onSort(sort === 0 ? 1 : sort === 1 ? -1 : 0)} title={t('grid.sort')}>
          {col.header}
          {sort === 1 ? <ArrowUp size={12} /> : sort === -1 ? <ArrowDown size={12} /> : <ArrowUpDown size={12} className="grid-th-hint" />}
        </button>
        <button ref={ref} className={`grid-th-filter ${filter ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} aria-label={t('grid.filter')} title={t('grid.filter')}>
          <Filter size={12} />
        </button>
      </span>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={290} align={end ? 'end' : 'start'}>
        <FilterPanel col={col} sort={sort} filter={filter} onSort={onSort} onFilter={onFilter} options={options} close={() => setOpen(false)} />
      </Popover>
    </th>
  );
}

function FilterPanel<T>({
  col,
  sort,
  filter,
  onSort,
  onFilter,
  options,
  close,
}: {
  col: Column<T>;
  sort: 0 | 1 | -1;
  filter: ColFilter | undefined;
  onSort(dir: 0 | 1 | -1): void;
  onFilter(f: ColFilter | null): void;
  options(): { key: string; label: string; n: number }[];
  close(): void;
}) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const type = col.type ?? 'text';
  const all = useMemo(options, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(filter?.kind === 'set' ? filter.values : all.map((o) => o.key)));
  const [min, setMin] = useState<number | null>(filter?.kind === 'range' ? filter.min : null);
  const [max, setMax] = useState<number | null>(filter?.kind === 'range' ? filter.max : null);
  const [from, setFrom] = useState(filter?.kind === 'dates' ? filter.from : '');
  const [to, setTo] = useState(filter?.kind === 'dates' ? filter.to : '');
  const list = all.filter((o) => !search || o.label.toLowerCase().includes(search.toLowerCase()));
  const numScale = type === 'money' ? scale : type === 'qty' ? QTY_SCALE : 0;

  const apply = () => {
    if (isNum(type) && (min != null || max != null)) onFilter({ kind: 'range', min, max });
    else if (type === 'date' && (from || to)) onFilter({ kind: 'dates', from, to });
    else if (search && list.length && picked.size === all.length) onFilter({ kind: 'set', values: list.map((o) => o.key) });
    else if (picked.size === all.length || picked.size === 0) onFilter(null);
    else onFilter({ kind: 'set', values: [...picked] });
    close();
  };

  return (
    <div className="grid-filter">
      <div className="grid-filter-sort">
        <button aria-pressed={sort === 1} onClick={() => (onSort(sort === 1 ? 0 : 1), close())}>
          <ArrowUp size={14} /> {t('grid.sortAsc')}
        </button>
        <button aria-pressed={sort === -1} onClick={() => (onSort(sort === -1 ? 0 : -1), close())}>
          <ArrowDown size={14} /> {t('grid.sortDesc')}
        </button>
      </div>

      {isNum(type) && (
        <div className="grid-filter-range">
          <label>
            <span>{t('grid.min')}</span>
            <DecimalInput sm scale={numScale} value={min} onChange={setMin} />
          </label>
          <label>
            <span>{t('grid.max')}</span>
            <DecimalInput sm scale={numScale} value={max} onChange={setMax} />
          </label>
        </div>
      )}
      {type === 'date' && (
        <div className="grid-filter-range">
          <label>
            <span>{t('grid.from')}</span>
            <Input sm type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>{t('grid.to')}</span>
            <Input sm type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      )}

      {!isNum(type) && type !== 'date' && (
        <>
          <div className="input-group">
            <Search />
            <input className="input input-sm" autoFocus placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
          </div>
          <div className="grid-filter-list">
            <label className="grid-filter-item strong">
              <input
                type="checkbox"
                checked={picked.size === all.length}
                ref={(el) => {
                  if (el) el.indeterminate = picked.size > 0 && picked.size < all.length;
                }}
                onChange={(e) => setPicked(new Set(e.target.checked ? all.map((o) => o.key) : []))}
              />
              <span>{t('grid.selectAll')}</span>
            </label>
            {list.map((o) => (
              <label key={o.key} className="grid-filter-item">
                <input
                  type="checkbox"
                  checked={picked.has(o.key)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(o.key);
                      else n.delete(o.key);
                      return n;
                    })
                  }
                />
                <span className="grid-filter-label">{o.label}</span>
                <span className="grid-count">{o.n}</span>
              </label>
            ))}
            {!list.length && <div className="faint" style={{ padding: 8, fontSize: 13 }}>{t('common.noResults')}</div>}
          </div>
        </>
      )}

      <div className="grid-filter-actions">
        <Button size="sm" variant="ghost" onClick={() => (onFilter(null), close())} disabled={!filter}>
          {t('grid.clear')}
        </Button>
        <span className="spacer" />
        <Button size="sm" variant="primary" icon={<Check />} onClick={apply}>
          {t('common.apply')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- menus
function MenuButton({ icon, label, active, children, width = 240 }: { icon: ReactNode; label: string; active?: boolean; children(close: () => void): ReactNode; width?: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} className={`btn btn-sm ${active ? 'btn-soft' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {icon} {label}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={width} align="end">
        <div className="menu">{children(() => setOpen(false))}</div>
      </Popover>
    </>
  );
}

function GroupMenu<T>({ columns, value, onChange }: { columns: Column<T>[]; value: string | null; onChange(id: string | null): void }) {
  const { t } = useI18n();
  const groupable = columns.filter((c) => !isNum(c.type ?? 'text'));
  return (
    <MenuButton icon={<Layers />} label={t('grid.groupBy')} active={!!value}>
      {(close) => (
        <>
          <button className="menu-item" aria-checked={!value} onClick={() => (onChange(null), close())}>
            {t('grid.noGrouping')}
          </button>
          <div className="menu-sep" />
          {groupable.map((c) => (
            <button key={c.id} className="menu-item" aria-checked={value === c.id} onClick={() => (onChange(c.id), close())}>
              {c.header}
              {c.type === 'date' && <span className="faint"> · {t('grid.byMonth')}</span>}
            </button>
          ))}
        </>
      )}
    </MenuButton>
  );
}

function ColumnsMenu<T>({ columns, hidden, onChange }: { columns: Column<T>[]; hidden: Set<string>; onChange(h: string[] | null): void }) {
  const { t } = useI18n();
  return (
    <MenuButton icon={<Columns3 />} label={t('grid.columns')}>
      {() => (
        <>
          {columns.map((c) => (
            <label key={c.id} className="menu-item">
              <input
                type="checkbox"
                disabled={c.pinned}
                checked={c.pinned || !hidden.has(c.id)}
                onChange={(e) => {
                  const n = new Set(hidden);
                  if (e.target.checked) n.delete(c.id);
                  else n.add(c.id);
                  onChange([...n]);
                }}
              />
              {c.header}
            </label>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => onChange(null)}>
            {t('grid.resetColumns')}
          </button>
        </>
      )}
    </MenuButton>
  );
}

function FavoritesMenu({ views, onApply, onSave, onDelete }: { views: SavedView[]; onApply(v: SavedView): void; onSave(name: string): void; onDelete(name: string): void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  return (
    <MenuButton icon={<Star />} label={t('grid.favorites')} width={270}>
      {(close) => (
        <>
          {views.map((v) => (
            <div key={v.name} className="menu-item" style={{ paddingInlineEnd: 4 }}>
              <button className="link-btn" style={{ flex: 1, textAlign: 'start' }} onClick={() => (onApply(v), close())}>
                <Star size={13} style={{ color: 'var(--warning)', fill: 'currentColor' }} /> {v.name}
              </button>
              <button className="icon-btn" aria-label={t('common.delete')} onClick={() => onDelete(v.name)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!views.length && <div className="faint" style={{ padding: '6px 10px', fontSize: 12.5 }}>{t('grid.noFavorites')}</div>}
          <div className="menu-sep" />
          <form
            className="row"
            style={{ gap: 6, padding: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              onSave(name.trim());
              setName('');
              close();
            }}
          >
            <Input sm placeholder={t('grid.viewName')} value={name} onChange={(e) => setName(e.target.value)} />
            <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
              {t('common.save')}
            </Button>
          </form>
        </>
      )}
    </MenuButton>
  );
}
