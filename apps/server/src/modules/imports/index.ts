import { z } from 'zod';
import type { AppModule, ModuleContext, SessionUser } from '../../kernel/modules.js';
import { AppError, fail, forbidden } from '../../kernel/errors.js';
import { isValidDate } from '../../kernel/dates.js';
import { parse, zDate } from '../../kernel/validate.js';
import { ACCOUNT_TYPES, SUBTYPES } from '../ledger/schema.js';
import type { JournalLineInput } from '../ledger/service.js';
import { readTable, writeXlsx, type Cell } from './xlsx.js';

/**
 * Import master data and opening balances from Excel (or CSV).
 * Every import is checked first by a trial run (all rows made, then rolled back) that reports each
 * row's problem; the real import runs only when no row has one, all in one transaction.
 */

type ColType = 'text' | 'money' | 'int' | 'bool' | 'enum';
interface Column {
  key: string;
  en: string;
  ar: string;
  required?: boolean;
  type?: ColType;
  values?: readonly string[];
  example?: Cell;
}
type Dataset = 'accounts' | 'parties' | 'items' | 'opening';

const DATASETS: Record<Dataset, { columns: Column[] }> = {
  accounts: {
    columns: [
      { key: 'code', en: 'Code', ar: 'الكود', required: true, example: '1125' },
      { key: 'name_en', en: 'Name (English)', ar: 'الاسم بالإنجليزي', required: true, example: 'Bank Misr' },
      { key: 'name_ar', en: 'Name (Arabic)', ar: 'الاسم بالعربي', required: true, example: 'بنك مصر' },
      { key: 'type', en: 'Type', ar: 'النوع', required: true, type: 'enum', values: ACCOUNT_TYPES, example: 'asset' },
      { key: 'subtype', en: 'Subtype', ar: 'النوع الفرعي', required: true, type: 'enum', values: [...new Set(Object.values(SUBTYPES).flat())], example: 'bank' },
      { key: 'parent_code', en: 'Parent code', ar: 'كود الحساب الأب', example: '11' },
      { key: 'is_group', en: 'Group (yes/no)', ar: 'تجميعي (نعم/لا)', type: 'bool', example: 'no' },
    ],
  },
  parties: {
    columns: [
      { key: 'kind', en: 'Kind', ar: 'النوع', required: true, type: 'enum', values: ['customer', 'supplier', 'both'], example: 'customer' },
      { key: 'code', en: 'Code', ar: 'الكود', example: 'C-0100' },
      { key: 'name', en: 'Name', ar: 'الاسم', required: true, example: 'Nile Hotels' },
      { key: 'name_alt', en: 'Name (other language)', ar: 'الاسم باللغة التانية', example: 'فنادق النيل' },
      { key: 'tax_number', en: 'Tax number', ar: 'الرقم الضريبي', example: '123-456-789' },
      { key: 'phone', en: 'Phone', ar: 'التليفون', example: '01000000000' },
      { key: 'email', en: 'Email', ar: 'البريد', example: 'ap@nilehotels.example' },
      { key: 'address', en: 'Address', ar: 'العنوان' },
      { key: 'city', en: 'City', ar: 'المدينة', example: 'Cairo' },
      { key: 'payment_terms_days', en: 'Payment terms (days)', ar: 'مدة السداد (أيام)', type: 'int', example: 30 },
      { key: 'credit_limit', en: 'Credit limit', ar: 'حد الائتمان', type: 'money', example: 50000 },
    ],
  },
  items: {
    columns: [
      { key: 'sku', en: 'SKU', ar: 'الكود', required: true, example: 'CHAIR-01' },
      { key: 'name_en', en: 'Name (English)', ar: 'الاسم بالإنجليزي', required: true, example: 'Office chair' },
      { key: 'name_ar', en: 'Name (Arabic)', ar: 'الاسم بالعربي', required: true, example: 'كرسي مكتب' },
      { key: 'kind', en: 'Kind', ar: 'النوع', type: 'enum', values: ['product', 'service'], example: 'product' },
      { key: 'unit', en: 'Unit', ar: 'الوحدة', example: 'pc' },
      { key: 'sale_price', en: 'Sale price', ar: 'سعر البيع', type: 'money', example: 1500 },
      { key: 'purchase_price', en: 'Purchase price', ar: 'سعر الشراء', type: 'money', example: 900 },
      { key: 'barcode', en: 'Barcode', ar: 'الباركود' },
      { key: 'track_stock', en: 'Track stock (yes/no)', ar: 'مخزني (نعم/لا)', type: 'bool', example: 'yes' },
    ],
  },
  opening: {
    columns: [
      { key: 'account_code', en: 'Account code', ar: 'كود الحساب', required: true, example: '1120' },
      { key: 'party_code', en: 'Customer / supplier code', ar: 'كود العميل / المورد' },
      { key: 'debit', en: 'Debit', ar: 'مدين', type: 'money', example: 250000 },
      { key: 'credit', en: 'Credit', ar: 'دائن', type: 'money' },
      { key: 'description', en: 'Description', ar: 'البيان', example: 'Opening balance' },
    ],
  },
};

/** Arabic-Indic digits and separators → a JS number. */
function toNumber(v: Cell): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = v
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٬,\s]/g, '')
    .replace('٫', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}
const YES = new Set(['yes', 'y', 'true', '1', 'نعم', 'ايوه', 'أيوه', 'x']);
const NO = new Set(['no', 'n', 'false', '0', 'لا']);

/** A problem as the web app translates it (errors.<code> with details), the English message as fallback. */
interface RowError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
interface RowResult {
  row: number;
  values: Record<string, Cell>;
  status: 'new' | 'exists' | 'error';
  error: RowError | null;
}
const err = (code: string, message: string, details?: Record<string, unknown>): RowError => ({ code, message, details });

class Rollback extends Error {}

function createImports({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const scale = () => services.get('settings').company().moneyScale;

  /** Header cells (English key, English label or Arabic label) → column keys. */
  function mapHeader(dataset: Dataset, header: Cell[]): Map<number, Column> {
    const out = new Map<number, Column>();
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\*$/, '').trim();
    header.forEach((h, i) => {
      if (h == null) return;
      const k = norm(String(h));
      const col = DATASETS[dataset].columns.find((c) => [c.key, c.en, c.ar].map(norm).includes(k));
      if (col) out.set(i, col);
    });
    const missing = DATASETS[dataset].columns.filter((c) => c.required && ![...out.values()].includes(c));
    if (missing.length) fail('import.missing_columns', `Missing columns: ${missing.map((c) => c.en).join(', ')}`, { columns: missing.map((c) => c.en).join(', ') });
    return out;
  }

  /** Typed values of one row, or the first problem. */
  function values(cols: Map<number, Column>, cells: Cell[]): { values: Record<string, Cell>; error: RowError | null } {
    const v: Record<string, Cell> = {};
    let error: RowError | null = null;
    for (const [i, c] of cols) {
      const raw = cells[i] ?? null;
      const str = raw == null ? '' : String(raw).trim();
      if (!str) {
        v[c.key] = null;
        if (c.required) error ??= err('import.required', `${c.en} is required`, { column: c.key });
        continue;
      }
      if (c.type === 'money') {
        const n = toNumber(raw);
        if (n == null || Number.isNaN(n)) error ??= err('import.not_number', `${c.en}: "${str}" is not a number`, { column: c.key, value: str });
        else v[c.key] = Math.round(n * 10 ** scale());
      } else if (c.type === 'int') {
        const n = toNumber(raw);
        if (n == null || Number.isNaN(n) || !Number.isInteger(n)) error ??= err('import.not_whole', `${c.en}: "${str}" is not a whole number`, { column: c.key, value: str });
        else v[c.key] = n;
      } else if (c.type === 'bool') {
        const s = str.toLowerCase();
        if (YES.has(s)) v[c.key] = true;
        else if (NO.has(s)) v[c.key] = false;
        else error ??= err('import.not_bool', `${c.en}: "${str}" should be yes or no`, { column: c.key, value: str });
      } else if (c.type === 'enum') {
        const s = str.toLowerCase();
        if (!c.values!.includes(s)) error ??= err('import.not_enum', `${c.en}: "${str}" should be one of ${c.values!.join(', ')}`, { column: c.key, value: str, values: c.values!.join(', ') });
        else v[c.key] = s;
      } else v[c.key] = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : str;
    }
    return { values: v, error };
  }

  const need = (user: SessionUser, perm: string) => {
    if (!user.permissions.has(perm)) forbidden(perm);
  };

  const errorOf = (e: unknown): RowError =>
    e instanceof AppError ? err(e.code, e.message, e.details) : err(/UNIQUE/.test(String(e)) ? 'duplicate' : 'generic', e instanceof Error ? e.message : String(e));

  /** Make every row (each in its own savepoint); `commit` keeps them when no row failed. */
  function run(dataset: Dataset, buf: Buffer, opts: { sheet?: string; date?: string | null; commit: boolean }, user: SessionUser) {
    need(user, 'imports.data.write');
    let table: Cell[][];
    try {
      table = readTable(buf, opts.sheet);
    } catch {
      return fail('import.bad_file', 'This file could not be read — save it as .xlsx or .csv');
    }
    const headerAt = table.findIndex((r) => r.some((c) => c != null && String(c).trim() !== ''));
    if (headerAt < 0) fail('import.empty', 'The file is empty');
    const cols = mapHeader(dataset, table[headerAt]);
    const rows: RowResult[] = [];
    for (let i = headerAt + 1; i < table.length; i++) {
      const cells = table[i] ?? [];
      if (!cells.some((c) => c != null && String(c).trim() !== '')) continue;
      const { values: v, error } = values(cols, cells);
      rows.push({ row: i + 1, values: v, status: error ? 'error' : 'new', error });
    }
    if (!rows.length) fail('import.empty', 'The file has no rows under the header');
    if (rows.length > 20_000) fail('import.too_many', 'At most 20,000 rows per import');
    let summary: RowError | null = null;
    const work = () => {
      if (dataset === 'accounts') importAccounts(rows, user);
      else if (dataset === 'parties') importParties(rows, user);
      else if (dataset === 'items') importItems(rows, user);
      else summary = importOpening(rows, opts.date, user);
    };
    const failed = () => rows.some((r) => r.status === 'error') || summary != null;
    try {
      db.tx(() => {
        work();
        if (!opts.commit || failed()) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    const counts = { new: rows.filter((r) => r.status === 'new').length, exists: rows.filter((r) => r.status === 'exists').length, errors: rows.filter((r) => r.status === 'error').length };
    const committed = opts.commit && !failed();
    if (opts.commit && !committed) {
      if (!counts.errors && summary) throw new AppError((summary as RowError).code, (summary as RowError).message, 400, (summary as RowError).details);
      fail('import.has_errors', `${counts.errors} rows have problems — nothing was imported`, { count: counts.errors });
    }
    if (committed) services.get('audit').log({ userId: user.id, action: 'import', entity: dataset, summary: `${counts.new} new, ${counts.exists} skipped` });
    return { dataset, committed, counts, problem: summary, rows };
  }

  /** Each row in a savepoint: a failure marks that row and undoes only it. */
  const each = (rows: RowResult[], fn: (r: RowResult) => 'new' | 'exists') => {
    for (const r of rows) {
      if (r.status === 'error') continue;
      try {
        r.status = db.tx(() => fn(r));
      } catch (e) {
        r.status = 'error';
        r.error = errorOf(e);
      }
    }
  };

  function importAccounts(rows: RowResult[], user: SessionUser) {
    need(user, 'gl.accounts.write');
    const byCode = (code: string) => db.get<{ id: number; is_group: number }>('SELECT id, is_group FROM accounts WHERE code = ?', [code]);
    // Parents may come later in the file: keep passing over the rows until nothing new can be made.
    let pending = rows.filter((r) => r.status !== 'error');
    for (let pass = 0; pass < 20 && pending.length; pass++) {
      const next: RowResult[] = [];
      for (const r of pending) {
        const v = r.values;
        if (byCode(String(v.code))) {
          r.status = 'exists';
          continue;
        }
        const parent = v.parent_code ? byCode(String(v.parent_code)) : null;
        if (v.parent_code && !parent) {
          next.push(r);
          continue;
        }
        each([r], () => {
          ledger().createAccount(
            { code: String(v.code), nameEn: String(v.name_en), nameAr: String(v.name_ar), type: v.type as never, subtype: String(v.subtype), parentId: parent?.id ?? null, isGroup: !!v.is_group, isActive: true, description: null },
            user.id,
          );
          return 'new';
        });
      }
      if (next.length === pending.length) {
        for (const r of next) (r.status = 'error'), (r.error = err('import.parent_missing', `Parent account ${r.values.parent_code} not found`, { code: String(r.values.parent_code) }));
        break;
      }
      pending = next;
    }
  }

  function importParties(rows: RowResult[], user: SessionUser) {
    if (!services.has('parties')) fail('import.unavailable', 'Customers and suppliers are not installed');
    each(rows, (r) => {
      const v = r.values;
      const kind = v.kind as 'customer' | 'supplier' | 'both';
      if (kind !== 'supplier') need(user, 'ar.customers.write');
      if (kind !== 'customer') need(user, 'ap.suppliers.write');
      if (v.code && db.get('SELECT 1 FROM parties WHERE code = ?', [v.code])) return 'exists';
      services.get('parties').create(
        {
          kind,
          code: v.code,
          name: v.name,
          nameAlt: v.name_alt,
          taxNumber: v.tax_number,
          phone: v.phone,
          email: v.email,
          address: v.address,
          city: v.city,
          paymentTermsDays: v.payment_terms_days ?? 0,
          creditLimit: v.credit_limit,
        },
        user.id,
      );
      return 'new';
    });
  }

  function importItems(rows: RowResult[], user: SessionUser) {
    if (!services.has('catalog')) fail('import.unavailable', 'Products and services are not installed');
    need(user, 'catalog.items.write');
    each(rows, (r) => {
      const v = r.values;
      if (db.get('SELECT 1 FROM items WHERE sku = ?', [v.sku])) return 'exists';
      services.get('catalog').createItem(
        {
          sku: v.sku,
          nameEn: v.name_en,
          nameAr: v.name_ar,
          kind: v.kind ?? 'product',
          unit: v.unit,
          salePrice: v.sale_price ?? 0,
          purchasePrice: v.purchase_price ?? 0,
          barcode: v.barcode,
          trackStock: v.track_stock ?? (v.kind ?? 'product') === 'product',
        },
        user.id,
      );
      return 'new';
    });
  }

  /** One opening entry from all rows; returns a problem that concerns the whole file (or null). */
  function importOpening(rows: RowResult[], date: string | null | undefined, user: SessionUser): RowError | null {
    need(user, 'gl.journal.post');
    // Importing the same file twice would double every balance: reverse the earlier import first.
    const earlier = db.get<{ number: string | null }>("SELECT number FROM journal_entries WHERE source_type = 'opening' AND reference = 'OPENING' AND status = 'posted' AND reversed_by_id IS NULL");
    if (earlier) fail('import.opening_exists', `Opening balances were already imported (${earlier.number}) — reverse that entry to import again`, { number: earlier.number ?? '' });
    const d = date ?? ledger().fiscalYears()[0]?.start_date;
    if (!d || !isValidDate(d)) fail('import.date', 'Choose the date of the opening balances');
    const lines: JournalLineInput[] = [];
    for (const r of rows) {
      if (r.status === 'error') continue;
      const v = r.values;
      const acc = db.get<{ id: number; is_group: number; is_active: number; subtype: string }>('SELECT id, is_group, is_active, subtype FROM accounts WHERE code = ?', [v.account_code]);
      const debit = (v.debit as number | null) ?? 0;
      const credit = (v.credit as number | null) ?? 0;
      let party: number | null = null;
      if (v.party_code) party = db.get<{ id: number }>('SELECT id FROM parties WHERE code = ?', [v.party_code])?.id ?? null;
      const code = { code: String(v.account_code), party: String(v.party_code ?? '') };
      const problem = !acc
        ? err('import.account_missing', `Account ${v.account_code} not found`, code)
        : acc.is_group
          ? err('import.group_account', `Account ${v.account_code} is a group account`, code)
          : !acc.is_active
            ? err('import.inactive_account', `Account ${v.account_code} is inactive`, code)
            : debit < 0 || credit < 0
              ? err('import.negative', 'Amounts cannot be negative')
              : (debit > 0) === (credit > 0)
                ? err('import.debit_or_credit', 'Enter either a debit or a credit')
                : v.party_code && !party
                  ? err('import.party_missing', `Customer / supplier ${v.party_code} not found`, code)
                  : (acc.subtype === 'receivable' || acc.subtype === 'payable') && !party
                    ? err('import.party_needed', `Account ${v.account_code} needs a customer or supplier code`, code)
                    : null;
      if (problem) {
        r.status = 'error';
        r.error = problem;
        continue;
      }
      lines.push({ accountId: acc!.id, debit, credit, partyId: party, description: (v.description as string | null) ?? 'Opening balance' });
    }
    if (rows.some((r) => r.status === 'error')) return null;
    const dr = lines.reduce((s, l) => s + l.debit, 0);
    const cr = lines.reduce((s, l) => s + l.credit, 0);
    const m = (x: number) => (x / 10 ** scale()).toFixed(scale());
    if (dr !== cr) return err('import.unbalanced', `Debits (${m(dr)}) and credits (${m(cr)}) differ by ${m(Math.abs(dr - cr))}`, { debit: m(dr), credit: m(cr), difference: m(Math.abs(dr - cr)) });
    if (!lines.length) return err('import.empty', 'The file has no rows under the header');
    try {
      ledger().createEntry({ date: d!, memo: 'Opening balances', reference: 'OPENING', lines }, { sourceType: 'opening', userId: user.id });
    } catch (e) {
      return errorOf(e);
    }
    return null;
  }

  /** A template workbook: the header, one example row, and the allowed values. */
  function template(dataset: Dataset, lang: 'en' | 'ar') {
    const cols = DATASETS[dataset].columns;
    const header = cols.map((c) => (lang === 'ar' ? c.ar : c.en) + (c.required ? ' *' : ''));
    const example = cols.map((c) => c.example ?? null);
    const help = cols.filter((c) => c.values).map((c) => [lang === 'ar' ? c.ar : c.en, c.values!.join(', ')] as Cell[]);
    const sheets: { name: string; rows: Cell[][]; rtl: boolean }[] = [{ name: dataset, rows: [header, example], rtl: lang === 'ar' }];
    if (help.length) sheets.push({ name: lang === 'ar' ? 'القيم المسموحة' : 'Allowed values', rows: [[lang === 'ar' ? 'العمود' : 'Column', lang === 'ar' ? 'القيم' : 'Values'], ...help], rtl: lang === 'ar' });
    return writeXlsx(sheets);
  }

  return { run, template };
}

export const importsModule: AppModule = {
  id: 'imports',
  dependsOn: ['ledger'],
  permissions: ['imports.data.write'],
  apps: [{ id: 'imports', order: 90, permissions: ['imports'] }],
  routes(r, ctx) {
    const im = createImports(ctx);
    const zDataset = z.enum(['accounts', 'parties', 'items', 'opening']);
    r.get('/imports/datasets', 'imports.data.write', () =>
      Object.entries(DATASETS).map(([id, d]) => ({ id, columns: d.columns.map(({ key, en, ar, required, type, values }) => ({ key, en, ar, required: !!required, type: type ?? 'text', values: values ?? null })) })),
    );
    r.get('/imports/template/:dataset', 'imports.data.write', ({ params, query, reply }) => {
      const dataset = parse(zDataset, params.dataset);
      const lang = query.lang === 'ar' ? 'ar' : 'en';
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('content-disposition', `attachment; filename="mizan-${dataset}.xlsx"`);
      return reply.send(im.template(dataset, lang));
    });
    const zBody = z.object({
      dataset: zDataset,
      /** The file, base64-encoded. */
      file: z.string().min(1).max(7_000_000),
      sheet: z.string().max(100).nullish(),
      date: zDate.nullish(),
    });
    const decode = (b64: string) => Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    r.post('/imports/preview', 'imports.data.write', ({ body, user }) => {
      const q = parse(zBody, body);
      return im.run(q.dataset, decode(q.file), { sheet: q.sheet ?? undefined, date: q.date, commit: false }, user);
    });
    r.post('/imports/commit', 'imports.data.write', ({ body, user }) => {
      const q = parse(zBody, body);
      return im.run(q.dataset, decode(q.file), { sheet: q.sheet ?? undefined, date: q.date, commit: true }, user);
    });
  },
};

