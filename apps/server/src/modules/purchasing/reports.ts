import { z } from 'zod';
import type { ModuleContext, Router } from '../../kernel/modules.js';
import { addDays, daysBetween, today } from '../../kernel/dates.js';
import { parse, zDate } from '../../kernel/validate.js';
import { RATE_SCALE } from '../../contracts/fx.js';

const zRange = z.object({ from: zDate.nullish(), to: zDate.nullish(), supplierId: z.coerce.number().int().positive().nullish() });

/**
 * Purchasing reports (read-only):
 * - supplier on-time delivery: each goods-receipt line of an order, received date vs the order line's expected date;
 * - open purchase orders: what is still to arrive, when, and how late.
 */
export function reportRoutes(r: Router, { db, services }: ModuleContext) {
  r.get('/purchasing/reports/supplier-on-time', 'purchasing.reports.read', ({ query }) => {
    const q = parse(zRange, query);
    const to = q.to ?? today();
    const from = q.from ?? addDays(to, -365);
    // Without inventory there are no goods receipts: the report is empty rather than wrong.
    if (!services.has('inventory')) return { from, to, suppliers: [], lines: [] };
    const lines = db.all<{ supplier_id: number; supplier_name: string; receipt_number: string; received: string; po_number: string; line_no: number; sku: string | null; description: string; base_quantity: number; expected: string | null }>(
      `SELECT r.supplier_id, p.name AS supplier_name, r.number AS receipt_number, r.date AS received, o.number AS po_number, pl.line_no,
              i.sku, pl.description, gl.base_quantity, COALESCE(pl.expected_date, o.expected_date) AS expected
       FROM goods_receipt_lines gl
       JOIN goods_receipts r ON r.id = gl.receipt_id AND r.status = 'posted'
       JOIN purchase_order_lines pl ON pl.id = gl.po_line_id
       JOIN purchase_orders o ON o.id = pl.po_id
       JOIN parties p ON p.id = r.supplier_id
       LEFT JOIN items i ON i.id = pl.item_id
       WHERE r.date BETWEEN :from AND :to ${q.supplierId ? 'AND r.supplier_id = :sup' : ''}
       ORDER BY p.name, r.date, r.id, gl.line_no`,
      { from, to, ...(q.supplierId ? { sup: q.supplierId } : {}) },
    );
    const rows = lines.map((l) => {
      const days = l.expected ? daysBetween(l.expected, l.received) : null;
      return { ...l, days_late: days == null ? null : Math.max(0, days), on_time: days == null ? null : days <= 0 };
    });
    const by = new Map<number, { supplier_id: number; supplier_name: string; lines: number; measured: number; on_time: number; late: number; days_late_total: number; max_days_late: number }>();
    for (const l of rows) {
      const s = by.get(l.supplier_id) ?? { supplier_id: l.supplier_id, supplier_name: l.supplier_name, lines: 0, measured: 0, on_time: 0, late: 0, days_late_total: 0, max_days_late: 0 };
      s.lines++;
      if (l.on_time != null) {
        s.measured++;
        if (l.on_time) s.on_time++;
        else {
          s.late++;
          s.days_late_total += l.days_late!;
          s.max_days_late = Math.max(s.max_days_late, l.days_late!);
        }
      }
      by.set(l.supplier_id, s);
    }
    const suppliers = [...by.values()].map(({ days_late_total, ...s }) => ({
      ...s,
      /** Share of measured lines received on or before their expected date, in basis points. */
      on_time_bp: s.measured ? Math.round((s.on_time * 10000) / s.measured) : null,
      avg_days_late: s.late ? Math.round((days_late_total / s.late) * 10) / 10 : 0,
    }));
    return { from, to, suppliers, lines: rows };
  });

  r.get('/purchasing/reports/open-orders', 'purchasing.reports.read', ({ query }) => {
    const asOf = parse(zDate.nullish(), query.asOf) ?? today();
    const rows = db.all<{ po_id: number; number: string; date: string; supplier_name: string; currency: string | null; exchange_rate: number | null; incoterm: string | null; line_no: number; sku: string | null; description: string; base_quantity: number; received_base: number; billed_base: number; expected: string | null; net: number; requisition_number: string | null }>(
      `SELECT o.id AS po_id, o.number, o.date, p.name AS supplier_name, o.currency, o.exchange_rate, o.incoterm, l.line_no, i.sku, l.description,
              l.base_quantity, l.received_base, l.billed_base, COALESCE(l.expected_date, o.expected_date) AS expected, l.net,
              q.number AS requisition_number
       FROM purchase_orders o JOIN purchase_order_lines l ON l.po_id = o.id JOIN parties p ON p.id = o.supplier_id
       LEFT JOIN items i ON i.id = l.item_id LEFT JOIN purchase_requisitions q ON q.id = l.requisition_id
       WHERE o.status = 'open' AND l.received_base < l.base_quantity
       ORDER BY COALESCE(l.expected_date, o.expected_date, o.date), o.id, l.line_no`,
    );
    return {
      asOf,
      rows: rows.map((l) => {
        const open = l.base_quantity - l.received_base;
        const openValue = Math.round((l.net * open) / l.base_quantity);
        return {
          ...l,
          open_base: open,
          open_value: openValue,
          /** Estimate in the base currency at the order's rate (receipts use their own date's rate). */
          open_value_base: l.currency ? Math.round((openValue * (l.exchange_rate ?? RATE_SCALE)) / RATE_SCALE) : openValue,
          days_overdue: l.expected && l.expected < asOf ? daysBetween(l.expected, asOf) : 0,
        };
      }),
    };
  });
}
