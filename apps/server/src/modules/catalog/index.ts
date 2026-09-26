import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { parse, zBp, zOptId, zOptText } from '../../kernel/validate.js';

export interface Tax {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  rate_bp: number;
  scope: 'sales' | 'purchases' | 'both';
  sales_account_id: number | null;
  purchase_account_id: number | null;
  is_active: number;
}

export interface Item {
  id: number;
  sku: string;
  name_en: string;
  name_ar: string;
  kind: 'service' | 'product';
  unit: string | null;
  sale_price: number;
  purchase_price: number;
  income_account_id: number | null;
  expense_account_id: number | null;
  sales_tax_id: number | null;
  purchase_tax_id: number | null;
  description: string | null;
  is_active: number;
}

export interface CatalogService {
  tax(id: number): Tax;
  item(id: number): Item;
}

declare module '../../kernel/services.js' {
  interface ServiceMap {
    catalog: CatalogService;
  }
}

const zTax = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  rateBp: zBp,
  scope: z.enum(['sales', 'purchases', 'both']).default('both'),
  salesAccountId: zOptId.transform((v) => v ?? null),
  purchaseAccountId: zOptId.transform((v) => v ?? null),
  isActive: z.boolean().default(true),
});

const zItem = z.object({
  sku: z.string().trim().min(1).max(50),
  nameEn: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().min(1).max(200),
  kind: z.enum(['service', 'product']).default('service'),
  unit: zOptText(20),
  salePrice: z.number().int().min(0).default(0),
  purchasePrice: z.number().int().min(0).default(0),
  incomeAccountId: zOptId.transform((v) => v ?? null),
  expenseAccountId: zOptId.transform((v) => v ?? null),
  salesTaxId: zOptId.transform((v) => v ?? null),
  purchaseTaxId: zOptId.transform((v) => v ?? null),
  description: zOptText(1000),
  isActive: z.boolean().default(true),
});

function createCatalog({ db }: ModuleContext): CatalogService {
  return {
    tax: (id) => db.get<Tax>('SELECT * FROM taxes WHERE id = ?', [id]) ?? notFound('tax', id),
    item: (id) => db.get<Item>('SELECT * FROM items WHERE id = ?', [id]) ?? notFound('item', id),
  };
}

export const catalogModule: AppModule = {
  id: 'catalog',
  dependsOn: ['ledger'],
  permissions: ['catalog.read', 'catalog.write'],
  migrations: [
    {
      id: '001_catalog',
      up: `
        CREATE TABLE taxes (
          id                  INTEGER PRIMARY KEY,
          code                TEXT NOT NULL UNIQUE,
          name_en             TEXT NOT NULL,
          name_ar             TEXT NOT NULL,
          rate_bp             INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),  -- 1400 = 14%
          scope               TEXT NOT NULL DEFAULT 'both' CHECK (scope IN ('sales', 'purchases', 'both')),
          sales_account_id    INTEGER REFERENCES accounts(id),   -- output tax (liability)
          purchase_account_id INTEGER REFERENCES accounts(id),   -- input tax (asset)
          is_active           INTEGER NOT NULL DEFAULT 1,
          created_at          TEXT NOT NULL
        );

        CREATE TABLE items (
          id                 INTEGER PRIMARY KEY,
          sku                TEXT NOT NULL UNIQUE,
          name_en            TEXT NOT NULL,
          name_ar            TEXT NOT NULL,
          kind               TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'product')),
          unit               TEXT,
          sale_price         INTEGER NOT NULL DEFAULT 0,        -- minor units
          purchase_price     INTEGER NOT NULL DEFAULT 0,
          income_account_id  INTEGER REFERENCES accounts(id),
          expense_account_id INTEGER REFERENCES accounts(id),
          sales_tax_id       INTEGER REFERENCES taxes(id),
          purchase_tax_id    INTEGER REFERENCES taxes(id),
          description        TEXT,
          is_active          INTEGER NOT NULL DEFAULT 1,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX items_name ON items(name_en);
      `,
    },
  ],

  setup(ctx) {
    ctx.services.provide('catalog', createCatalog(ctx));
    ctx.events.on('system.setup', (s) => {
      if (s.vatRateBp == null) return;
      const ledger = ctx.services.get('ledger');
      const d = ledger.defaultAccounts();
      const pct = s.vatRateBp / 100;
      ctx.db.insert('taxes', {
        code: 'VAT',
        name_en: `VAT ${pct}%`,
        name_ar: `ضريبة القيمة المضافة ${pct}٪`,
        rate_bp: s.vatRateBp,
        scope: 'both',
        sales_account_id: d.vatOutput,
        purchase_account_id: d.vatInput,
        created_at: nowIso(),
      });
    });
  },

  routes(r, { db, services }) {
    const audit = services.get('audit');
    const ledger = services.get('ledger');

    const postable = (id: number | null, label: string) => {
      if (id == null) return;
      const a = ledger.account(id);
      if (a.is_group) fail('account.group_not_allowed', `${label}: choose a posting account, not a group`);
    };

    // -------------------------------------------------------------- taxes
    r.get('/taxes', 'catalog.read', () => db.all<Tax>('SELECT * FROM taxes ORDER BY code'));

    const taxRow = (i: z.infer<typeof zTax>) => ({
      code: i.code,
      name_en: i.nameEn,
      name_ar: i.nameAr,
      rate_bp: i.rateBp,
      scope: i.scope,
      sales_account_id: i.salesAccountId,
      purchase_account_id: i.purchaseAccountId,
      is_active: i.isActive,
    });

    const checkTax = (i: z.infer<typeof zTax>) => {
      if (i.rateBp > 0 && i.scope !== 'purchases' && !i.salesAccountId) fail('tax.account_required', 'Choose the output tax account');
      if (i.rateBp > 0 && i.scope !== 'sales' && !i.purchaseAccountId) fail('tax.account_required', 'Choose the input tax account');
      postable(i.salesAccountId, 'Output tax account');
      postable(i.purchaseAccountId, 'Input tax account');
    };

    r.post('/taxes', 'catalog.write', ({ body, user }) => {
      const input = parse(zTax, body);
      checkTax(input);
      if (db.get('SELECT 1 FROM taxes WHERE code = ?', [input.code])) conflict('tax.duplicate_code', 'Tax code already exists');
      return db.tx(() => {
        const id = db.insert('taxes', { ...taxRow(input), created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'tax', entityId: id, summary: input.code });
        return { id };
      });
    });

    r.put('/taxes/:id', 'catalog.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = services.get('catalog').tax(id);
      const input = parse(zTax, body);
      checkTax(input);
      const dup = db.get<{ id: number }>('SELECT id FROM taxes WHERE code = ?', [input.code]);
      if (dup && dup.id !== id) conflict('tax.duplicate_code', 'Tax code already exists');
      db.tx(() => {
        // Posted documents keep their own copy of the rate, so changing it only affects new documents.
        db.update('taxes', id, taxRow(input));
        audit.log({ userId: user.id, action: 'update', entity: 'tax', entityId: id, data: { before: cur, after: input } });
      });
      return { ok: true };
    });

    // -------------------------------------------------------------- items
    r.get('/items', 'catalog.read', ({ query }) => {
      const where: string[] = [];
      const p: Record<string, string> = {};
      if (query.active === '1') where.push('is_active = 1');
      if (query.q) {
        where.push('(sku LIKE :q OR name_en LIKE :q OR name_ar LIKE :q)');
        p.q = `%${query.q}%`;
      }
      return db.all<Item>(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sku LIMIT 1000`, p);
    });

    const itemRow = (i: z.infer<typeof zItem>) => ({
      sku: i.sku,
      name_en: i.nameEn,
      name_ar: i.nameAr,
      kind: i.kind,
      unit: i.unit,
      sale_price: i.salePrice,
      purchase_price: i.purchasePrice,
      income_account_id: i.incomeAccountId,
      expense_account_id: i.expenseAccountId,
      sales_tax_id: i.salesTaxId,
      purchase_tax_id: i.purchaseTaxId,
      description: i.description,
      is_active: i.isActive,
    });

    const checkItem = (i: z.infer<typeof zItem>) => {
      postable(i.incomeAccountId, 'Income account');
      postable(i.expenseAccountId, 'Expense account');
      if (i.salesTaxId) services.get('catalog').tax(i.salesTaxId);
      if (i.purchaseTaxId) services.get('catalog').tax(i.purchaseTaxId);
    };

    r.post('/items', 'catalog.write', ({ body, user }) => {
      const input = parse(zItem, body);
      checkItem(input);
      if (db.get('SELECT 1 FROM items WHERE sku = ?', [input.sku])) conflict('item.duplicate_sku', 'SKU already exists');
      return db.tx(() => {
        const id = db.insert('items', { ...itemRow(input), created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'item', entityId: id, summary: input.sku });
        return { id };
      });
    });

    r.put('/items/:id', 'catalog.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = services.get('catalog').item(id);
      const input = parse(zItem, body);
      checkItem(input);
      const dup = db.get<{ id: number }>('SELECT id FROM items WHERE sku = ?', [input.sku]);
      if (dup && dup.id !== id) conflict('item.duplicate_sku', 'SKU already exists');
      db.tx(() => {
        db.update('items', id, itemRow(input));
        audit.log({ userId: user.id, action: 'update', entity: 'item', entityId: id, data: { before: cur, after: input } });
      });
      return { ok: true };
    });

    r.delete('/items/:id', 'catalog.write', ({ params, user }) => {
      const id = Number(params.id);
      const cur = services.get('catalog').item(id);
      db.tx(() => {
        try {
          db.run('DELETE FROM items WHERE id = ?', [id]);
        } catch {
          conflict('item.in_use', 'This item is used on documents — deactivate it instead');
        }
        audit.log({ userId: user.id, action: 'delete', entity: 'item', entityId: id, summary: cur.sku });
      });
      return { ok: true };
    });
  },
};
