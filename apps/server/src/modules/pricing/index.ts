import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import { parse, zId, zOptId } from '../../kernel/validate.js';

const zList = z.object({
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  isActive: z.boolean().default(true),
  prices: z
    .array(z.object({ itemId: zId, unitId: zOptId.transform((v) => v ?? null), price: z.number().int().min(0) }))
    .max(20000)
    .default([]),
  partyIds: z.array(zId).max(20000).default([]),
});

/**
 * Price lists per customer group and a minimum selling price guard.
 * Prices are suggestions for the invoice screen; the guard is enforced when a
 * sales invoice is posted (administrators may override).
 */
export const pricingModule: AppModule = {
  id: 'pricing',
  dependsOn: ['catalog', 'parties', 'documents'],
  permissions: ['pricing.read', 'pricing.write', 'pricing.override'],
  migrations: [
    {
      id: '001_price_lists',
      up: `
        CREATE TABLE price_lists (
          id         INTEGER PRIMARY KEY,
          name_en    TEXT NOT NULL,
          name_ar    TEXT NOT NULL,
          is_active  INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE TABLE price_list_prices (
          price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
          item_id       INTEGER NOT NULL REFERENCES items(id),
          unit_key      INTEGER NOT NULL DEFAULT 0,   -- 0 = base unit, else item_units.id
          price         INTEGER NOT NULL CHECK (price >= 0),
          PRIMARY KEY (price_list_id, item_id, unit_key)
        );
        CREATE TABLE party_price_lists (
          party_id      INTEGER PRIMARY KEY REFERENCES parties(id),
          price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE
        );
      `,
    },
  ],

  setup({ db, services, events }) {
    // Minimum price guard: net price per base unit (after discount, before tax) must not go below the item's minimum.
    events.on('document.posted', (e) => {
      if (e.kind !== 'sales_invoice') return;
      if (services.get('access').userCan(e.userId, 'pricing.override')) return;
      const lines = db.all<{ line_no: number; item_id: number; net: number; base_quantity: number; min_sale_price: number; sku: string }>(
        `SELECT l.line_no, l.item_id, l.net, l.base_quantity, i.min_sale_price, i.sku
         FROM document_lines l JOIN items i ON i.id = l.item_id WHERE l.document_id = ? AND i.min_sale_price > 0`,
        [e.documentId],
      );
      for (const l of lines) {
        const perUnit = Number(divRound(BigInt(l.net) * 1000n, BigInt(l.base_quantity)));
        if (perUnit < l.min_sale_price) {
          fail('price.below_minimum', `Line ${l.line_no}: ${l.sku} is below its minimum price`, {
            line: l.line_no,
            sku: l.sku,
            price: perUnit,
            minimum: l.min_sale_price,
          });
        }
      }
    });
  },

  routes(r, { db, services }) {
    const audit = services.get('audit');

    r.get('/pricing/lists', 'pricing.read', () =>
      db.all(
        `SELECT pl.*, (SELECT COUNT(*) FROM price_list_prices p WHERE p.price_list_id = pl.id) AS prices,
                (SELECT COUNT(*) FROM party_price_lists pp WHERE pp.price_list_id = pl.id) AS parties
         FROM price_lists pl ORDER BY pl.name_en`,
      ),
    );

    r.get('/pricing/lists/:id', 'pricing.read', ({ params }) => {
      const id = Number(params.id);
      const list = db.get('SELECT * FROM price_lists WHERE id = ?', [id]) ?? notFound('price_list', id);
      return {
        ...(list as object),
        prices: db.all(
          `SELECT p.item_id, NULLIF(p.unit_key, 0) AS unit_id, p.price, i.sku, i.name_en, i.name_ar, i.sale_price, i.unit AS base_unit,
                  u.name_en AS unit_name_en, u.name_ar AS unit_name_ar, u.factor
           FROM price_list_prices p JOIN items i ON i.id = p.item_id LEFT JOIN item_units u ON u.id = p.unit_key
           WHERE p.price_list_id = ? ORDER BY i.sku, u.factor`,
          [id],
        ),
        parties: db.all(
          'SELECT pa.id, pa.code, pa.name FROM party_price_lists pp JOIN parties pa ON pa.id = pp.party_id WHERE pp.price_list_id = ? ORDER BY pa.name',
          [id],
        ),
      };
    });

    const save = (id: number | null, input: z.infer<typeof zList>, userId: number) => {
      const catalog = services.get('catalog');
      const seen = new Set<string>();
      for (const p of input.prices) {
        const item = catalog.item(p.itemId);
        if (p.unitId) catalog.unitFactor(item, p.unitId);
        const key = `${p.itemId}:${p.unitId ?? 0}`;
        if (seen.has(key)) fail('pricing.duplicate', `${item.sku} appears twice`, { sku: item.sku });
        seen.add(key);
      }
      for (const pid of input.partyIds) services.get('parties').get(pid);
      return db.tx(() => {
        const row = { name_en: input.nameEn, name_ar: input.nameAr, is_active: input.isActive };
        const lid = id ?? db.insert('price_lists', { ...row, created_at: nowIso() });
        if (id != null) db.update('price_lists', id, row);
        db.run('DELETE FROM price_list_prices WHERE price_list_id = ?', [lid]);
        for (const p of input.prices) {
          db.insert('price_list_prices', { price_list_id: lid, item_id: p.itemId, unit_key: p.unitId ?? 0, price: p.price });
        }
        // A customer belongs to at most one list: joining this one leaves any other.
        db.run('DELETE FROM party_price_lists WHERE price_list_id = ?', [lid]);
        for (const pid of input.partyIds) {
          db.run(
            'INSERT INTO party_price_lists (party_id, price_list_id) VALUES (?, ?) ON CONFLICT(party_id) DO UPDATE SET price_list_id = excluded.price_list_id',
            [pid, lid],
          );
        }
        audit.log({ userId, action: id == null ? 'create' : 'update', entity: 'price_list', entityId: lid, summary: input.nameEn });
        return lid;
      });
    };

    r.post('/pricing/lists', 'pricing.write', ({ body, user }) => ({ id: save(null, parse(zList, body), user.id) }));
    r.put('/pricing/lists/:id', 'pricing.write', ({ params, body, user }) => {
      const id = Number(params.id);
      if (!db.get('SELECT 1 FROM price_lists WHERE id = ?', [id])) notFound('price_list', id);
      return { id: save(id, parse(zList, body), user.id) };
    });
    r.delete('/pricing/lists/:id', 'pricing.write', ({ params, user }) => {
      const id = Number(params.id);
      db.tx(() => {
        db.run('DELETE FROM price_lists WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'price_list', entityId: id });
      });
      return { ok: true };
    });

    /**
     * Prices for a customer, keyed "itemId:unitId" (unitId 0 = base unit), from
     * their price list when they have one. The invoice screen falls back to the
     * unit / item price.
     */
    r.get('/pricing/for-party/:id', 'auth', ({ params }) => {
      const pid = Number(params.id);
      const link = db.get<{ price_list_id: number; name_en: string; name_ar: string }>(
        `SELECT pp.price_list_id, pl.name_en, pl.name_ar FROM party_price_lists pp JOIN price_lists pl ON pl.id = pp.price_list_id
         WHERE pp.party_id = ? AND pl.is_active = 1`,
        [pid],
      );
      if (!link) return { list: null, prices: {} };
      const rows = db.all<{ item_id: number; unit_key: number; price: number }>(
        'SELECT item_id, unit_key, price FROM price_list_prices WHERE price_list_id = ?',
        [link.price_list_id],
      );
      return { list: { id: link.price_list_id, name_en: link.name_en, name_ar: link.name_ar }, prices: Object.fromEntries(rows.map((x) => [`${x.item_id}:${x.unit_key}`, x.price])) };
    });
  },
};
