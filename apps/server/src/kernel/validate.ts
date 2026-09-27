import { z } from 'zod';
import { AppError } from './errors.js';
import { isValidDate } from './dates.js';

/** Parse input with a zod schema, turning failures into a 400 `validation` error. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError('validation', 'Invalid input', 400, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** Reusable field schemas. */
export const zId = z.coerce.number().int().positive();
export const zOptId = z.coerce.number().int().positive().nullish();
export const zDate = z.string().refine(isValidDate, 'Invalid date (YYYY-MM-DD)');
/** Money in minor units. */
export const zMinor = z.number().int().refine(Number.isSafeInteger, 'Amount out of range');
export const zPositiveMinor = zMinor.refine((n) => n > 0, 'Must be greater than zero');
/** Basis points, 0..100% */
export const zBp = z.number().int().min(0).max(10000);
export const zText = (max = 500) => z.string().trim().max(max);
export const zOptText = (max = 500) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

/** Upper bound for one page. Lists are small enough (local SMB data) to filter in the browser. */
export const MAX_ROWS = 20000;

/** Pagination from query string. */
export function paging(q: Record<string, string | undefined>, defLimit = 50) {
  const limit = Math.min(Math.max(Number(q.limit ?? defLimit) || defLimit, 1), MAX_ROWS);
  const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
  return { limit, offset };
}
