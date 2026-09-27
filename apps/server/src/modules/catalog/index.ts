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
  barcode: string | null;
  category_id: number | null;
  /** Products are stock-tracked unless this is 0 (consumables). */
  track_stock: number;
  inventory_account_id: number | null;
  cogs_account_id: number | null;
  /** x1000, like every quantity. */
  reorder_level: number;
  reorder_qty: number;
  /** none | batch (lots, optional expiry) | serial (one unit per number). */
  tracking: 'none' | 'batch' | 'serial';
  requires_expiry: number;
  /** Lowest allowed net selling price per base unit (0 = no guard). */
  min_sale_price: number;
}

/** An alternative unit of measure: 1 unit = factor/1000 base units (a box of 12 => 12000). */
export interface ItemUnit {
  id: number;
  item_id: number;
  name_en: string;
  name_ar: string;
  factor: number;
  barcode: string | null;
  sale_price: number | null;
  purchase_price: number | null;
  is_active: number;
}

export interface CatalogService {
  tax(id: number): Tax;
  item(id: number): Item;
  /** Does this item carry a stock balance? */
  isStockItem(item: Item): boolean;
  unit(id: number): ItemUnit;
  units(itemId: number): ItemUnit[];
  /** Conversion factor (x1000) of a unit for an item; null unit = base unit (1000). */
  unitFactor(item: Item, unitId: number | null | undefined): number;
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
  barcode: zOptText(64),
  categoryId: zOptId.transform((v) => v ?? null),
  trackStock: z.boolean().default(true),
  inventoryAccountId: zOptId.transform((v) => v ?? null),
  cogsAccountId: zOptId.transform((v) => v ?? null),
  reorderLevel: z.number().int().min(0).default(0),
  reorderQty: z.number().int().min(0).default(0),
  tracking: z.enum(['none', 'batch', 'serial']).default('none'),
  requiresExpiry: z.boolean().default(false),
  minSalePrice: z.number().int().min(0).default(0),
  units: z
    .array(
      z.object({
        id: zOptId,
        nameEn: z.string().trim().min(1).max(40),
        nameAr: z.string().trim().min(1).max(40),
        factor: z.number().int().positive().max(1_000_000_000),
        barcode: zOptText(64),
        salePrice: z.number().int().min(0).nullish().transform((v) => v ?? null),
        purchasePrice: z.number().int().min(0).nullish().transform((v) => v ?? null),
        isActive: z.boolean().default(true),
      }),
    )
    .max(20)
    .default([]),
});

const zCategory = z.object({
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
});

function createCatalog({ db }: ModuleContext): CatalogService {
  return {
    tax: (id) => db.get<Tax>('SELECT * FROM taxes WHERE id = ?', [id]) ?? notFound('tax', id),
    item: (id) => db.get<Item>('SELECT * FROM items WHERE id = ?', [id]) ?? notFound('item', id),
    isStockItem: (item) => item.kind === 'product' && item.track_stock === 1,
    unit: (id) => db.get<ItemUnit>('SELECT * FROM item_units WHERE id = ?', [id]) ?? notFound('item_unit', id),
    units: (itemId) => db.all<ItemUnit>('SELECT * FROM item_units WHERE item_id = ? ORDER BY factor', [itemId]),
    unitFactor(item, unitId) {
      if (!unitId) return 1000;
      const u = db.get<ItemUnit>('SELECT * FROM item_units WHERE id = ?', [unitId]);
      if (!u || u.item_id !== item.id) return fail('item.unit_mismatch', `This unit does not belong to ${item.sku}`, { sku: item.sku });
      if (!u.is_active) fail('item.unit_inactive', `Unit ${u.name_en} of ${item.sku} is inactive`, { sku: item.sku });
      return u.factor;
    },
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
    {
      id: '002_item_master',
      up: `
        CREATE TABLE item_categories (
          id         INTEGER PRIMARY KEY,
          name_en    TEXT NOT NULL,
          name_ar    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        ALTER TABLE items ADD COLUMN barcode TEXT;
        ALTER TABLE items ADD COLUMN category_id INTEGER REFERENCES item_categories(id);
        ALTER TABLE items ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE items ADD COLUMN inventory_account_id INTEGER REFERENCES accounts(id);
        ALTER TABLE items ADD COLUMN cogs_account_id INTEGER REFERENCES accounts(id);
        ALTER TABLE items ADD COLUMN reorder_level INTEGER NOT NULL DEFAULT 0;   -- x1000
        ALTER TABLE items ADD COLUMN reorder_qty INTEGER NOT NULL DEFAULT 0;     -- x1000
        CREATE UNIQUE INDEX items_barcode ON items(barcode) WHERE barcode IS NOT NULL;
        CREATE INDEX items_category ON items(category_id);
      `,
    },
    {
      id: '003_units_tracking',
      up: `
        CREATE TABLE item_units (
          id             INTEGER PRIMARY KEY,
          item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          name_en        TEXT NOT NULL,
          name_ar        TEXT NOT NULL,
          factor         INTEGER NOT NULL CHECK (factor > 0),   -- base units x1000 in one of this unit
          barcode        TEXT,
          sale_price     INTEGER,                                -- NULL = base price x factor
          purchase_price INTEGER,
          is_active      INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX item_units_item ON item_units(item_id);
        CREATE UNIQUE INDEX item_units_barcode ON item_units(barcode) WHERE barcode IS NOT NULL;
        ALTER TABLE items ADD COLUMN tracking TEXT NOT NULL DEFAULT 'none' CHECK (tracking IN ('none', 'batch', 'serial'));
        ALTER TABLE items ADD COLUMN requires_expiry INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE items ADD COLUMN min_sale_price INTEGER NOT NULL DEFAULT 0;   -- per base unit
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
      const p: Record<string, string | number> = {};
      if (query.active === '1') where.push('i.is_active = 1');
      if (query.categoryId) (where.push('i.category_id = :cat'), (p.cat = Number(query.categoryId)));
      if (query.stock === '1') where.push("i.kind = 'product' AND i.track_stock = 1");
      if (query.q) {
        where.push('(i.sku LIKE :q OR i.name_en LIKE :q OR i.name_ar LIKE :q OR i.barcode = :exact OR i.id IN (SELECT item_id FROM item_units WHERE barcode = :exact))');
        p.q = `%${query.q}%`;
        p.exact = query.q;
      }
      const rows = db.all<Item>(
        `SELECT i.*, c.name_en AS category_name_en, c.name_ar AS category_name_ar
         FROM items i LEFT JOIN item_categories c ON c.id = i.category_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.sku LIMIT 20000`,
        p,
      );
      const units = new Map<number, ItemUnit[]>();
      for (const u of db.all<ItemUnit>('SELECT * FROM item_units ORDER BY factor')) units.set(u.item_id, [...(units.get(u.item_id) ?? []), u]);
      return rows.map((i) => ({ ...i, units: units.get(i.id) ?? [] }));
    });

    /** Barcode scanner lookup: an item's own barcode or one of its units'. */
    r.get('/items/lookup', 'catalog.read', ({ query }) => {
      const code = String(query.barcode ?? '');
      const item = db.get<Item>('SELECT * FROM items WHERE barcode = ?', [code]);
      if (item) return { item, unit: null };
      const unit = db.get<ItemUnit>('SELECT * FROM item_units WHERE barcode = ? AND is_active = 1', [code]);
      if (unit) return { item: services.get('catalog').item(unit.item_id), unit };
      return notFound('barcode', code);
    });

    // ------------------------------------------------------------ categories
    r.get('/item-categories', 'catalog.read', () =>
      db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS items
         FROM item_categories c ORDER BY c.name_en`,
      ),
    );

    r.post('/item-categories', 'catalog.write', ({ body, user }) => {
      const input = parse(zCategory, body);
      return db.tx(() => {
        const id = db.insert('item_categories', { name_en: input.nameEn, name_ar: input.nameAr, created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'item_category', entityId: id, summary: input.nameEn });
        return { id };
      });
    });

    r.put('/item-categories/:id', 'catalog.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zCategory, body);
      if (!db.get('SELECT 1 FROM item_categories WHERE id = ?', [id])) notFound('item_category', id);
      db.tx(() => {
        db.update('item_categories', id, { name_en: input.nameEn, name_ar: input.nameAr });
        audit.log({ userId: user.id, action: 'update', entity: 'item_category', entityId: id, data: input });
      });
      return { ok: true };
    });

    r.delete('/item-categories/:id', 'catalog.write', ({ params, user }) => {
      const id = Number(params.id);
      if (db.get('SELECT 1 FROM items WHERE category_id = ?', [id])) conflict('category.in_use', 'Move the items to another category first');
      db.tx(() => {
        db.run('DELETE FROM item_categories WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'item_category', entityId: id });
      });
      return { ok: true };
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
      barcode: i.barcode,
      category_id: i.categoryId,
      track_stock: i.trackStock,
      inventory_account_id: i.inventoryAccountId,
      cogs_account_id: i.cogsAccountId,
      reorder_level: i.reorderLevel,
      reorder_qty: i.reorderQty,
      tracking: i.kind === 'product' && i.trackStock ? i.tracking : 'none',
      requires_expiry: i.kind === 'product' && i.trackStock && i.tracking === 'batch' && i.requiresExpiry,
      min_sale_price: i.minSalePrice,
    });

    /** Upsert the item's units; units removed from the list are deactivated, never deleted (documents reference them). */
    const writeUnits = (itemId: number, units: z.infer<typeof zItem>['units']) => {
      const existing = db.all<ItemUnit>('SELECT * FROM item_units WHERE item_id = ?', [itemId]);
      const keep = new Set<number>();
      for (const u of units) {
        const row = {
          name_en: u.nameEn,
          name_ar: u.nameAr,
          factor: u.factor,
          barcode: u.barcode,
          sale_price: u.salePrice,
          purchase_price: u.purchasePrice,
          is_active: u.isActive,
        };
        const cur = u.id ? existing.find((e) => e.id === u.id) : undefined;
        if (u.id && !cur) notFound('item_unit', u.id);
        if (cur) {
          if (cur.factor !== u.factor && unitUsed(cur.id)) fail('item.unit_locked', `Unit ${cur.name_en} is used on documents; its size cannot change`);
          db.update('item_units', cur.id, row);
          keep.add(cur.id);
        } else keep.add(db.insert('item_units', { ...row, item_id: itemId, created_at: nowIso() }));
      }
      for (const e of existing) if (!keep.has(e.id)) db.run('UPDATE item_units SET is_active = 0 WHERE id = ?', [e.id]);
    };

    const unitUsed = (unitId: number) =>
      !!db.get('SELECT 1 FROM document_lines WHERE unit_id = ? LIMIT 1', [unitId]) ||
      (services.has('inventory') && services.get('inventory').unitUsed(unitId));

    const checkItem = (i: z.infer<typeof zItem>, current?: Item) => {
      postable(i.incomeAccountId, 'Income account');
      postable(i.expenseAccountId, 'Expense account');
      postable(i.cogsAccountId, 'Cost of sales account');
      if (i.inventoryAccountId && ledger.account(i.inventoryAccountId).subtype !== 'inventory') {
        fail('item.inventory_account', 'The inventory account must be an Inventory account');
      }
      if (i.categoryId && !db.get('SELECT 1 FROM item_categories WHERE id = ?', [i.categoryId])) notFound('item_category', i.categoryId);
      // Barcodes are unique across items and their units, so a scan always finds exactly one thing.
      const codes = [i.barcode, ...i.units.map((u) => u.barcode)].filter((b): b is string => !!b);
      if (new Set(codes).size !== codes.length) conflict('item.duplicate_barcode', 'The same barcode is used twice');
      for (const code of codes) {
        const onItem = db.get<{ id: number }>('SELECT id FROM items WHERE barcode = ?', [code]);
        const onUnit = db.get<{ item_id: number }>('SELECT item_id FROM item_units WHERE barcode = ?', [code]);
        if ((onItem && onItem.id !== current?.id) || (onUnit && onUnit.item_id !== current?.id)) {
          conflict('item.duplicate_barcode', `Barcode ${code} is already used by another item`, { barcode: code });
        }
      }
      if (i.units.some((u) => u.factor === 1000)) fail('item.unit_factor', 'An extra unit cannot equal the base unit');
      if (i.tracking === 'serial' && i.units.length) fail('item.serial_units', 'Serial-numbered items are counted one by one (no extra units)');
      // Once stock has moved, an item cannot stop (or start) being a stock item: its history would no longer add up.
      if (current && services.has('inventory') && services.get('inventory').hasMoves(current.id)) {
        const wasStock = current.kind === 'product' && current.track_stock === 1;
        const isStock = i.kind === 'product' && i.trackStock;
        if (wasStock !== isStock) fail('item.stock_locked', 'This item has stock movements; its stock tracking cannot change');
        if (current.tracking !== (isStock ? i.tracking : 'none')) fail('item.stock_locked', 'This item has stock movements; its lot/serial tracking cannot change');
        if ((current.inventory_account_id ?? null) !== i.inventoryAccountId) {
          fail('item.stock_locked', 'This item has stock movements; its inventory account cannot change');
        }
      }
      if (i.salesTaxId) services.get('catalog').tax(i.salesTaxId);
      if (i.purchaseTaxId) services.get('catalog').tax(i.purchaseTaxId);
    };

    r.post('/items', 'catalog.write', ({ body, user }) => {
      const input = parse(zItem, body);
      checkItem(input);
      if (db.get('SELECT 1 FROM items WHERE sku = ?', [input.sku])) conflict('item.duplicate_sku', 'SKU already exists');
      return db.tx(() => {
        const id = db.insert('items', { ...itemRow(input), created_at: nowIso() });
        writeUnits(id, input.units);
        audit.log({ userId: user.id, action: 'create', entity: 'item', entityId: id, summary: input.sku });
        return { id };
      });
    });

    r.put('/items/:id', 'catalog.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = services.get('catalog').item(id);
      const input = parse(zItem, body);
      checkItem(input, cur);
      const dup = db.get<{ id: number }>('SELECT id FROM items WHERE sku = ?', [input.sku]);
      if (dup && dup.id !== id) conflict('item.duplicate_sku', 'SKU already exists');
      db.tx(() => {
        db.update('items', id, itemRow(input));
        writeUnits(id, input.units);
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
