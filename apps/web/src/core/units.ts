import type { ItemUnit } from './types';

/** "Carton ×12" — the factor is added unless the unit name already says it. */
export function unitLabel(u: Pick<ItemUnit, 'name_en' | 'name_ar' | 'factor'>, pick: (en: string, ar: string) => string): string {
  const name = pick(u.name_en, u.name_ar);
  const n = String(u.factor / 1000);
  const digits = name.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return new RegExp(`(^|\\D)${n.replace('.', '\\.')}(\\D|$)`).test(digits) ? name : `${name} ×${n}`;
}
