/**
 * Payroll arithmetic — pure functions, no database.
 *
 *  - workedShare():  the part of a month an employee was on the payroll (hired or left mid-month).
 *  - bracketTax():   progressive tax on an annual amount (brackets set by the company).
 *  - payslip():      one employee's month: basic, earnings, gross, deductions, net, employer costs.
 *
 * Money in minor units; rates in basis points. Nothing here knows a country's law: components,
 * rates and brackets are the company's settings.
 */

export type Kind = 'earning' | 'deduction' | 'employer';
export type Calc = 'fixed' | 'percent_basic' | 'percent_gross' | 'tax';

export interface Bracket {
  /** Upper bound of the bracket (annual, minor units); null = no upper bound. */
  upTo: number | null;
  rateBp: number;
}

export interface Component {
  id: number;
  name: string;
  kind: Kind;
  calc: Calc;
  /** Fixed amount (monthly) or rate in bp. */
  value: number;
  /** Deducted before income tax (e.g. employee social insurance). */
  preTax: boolean;
  /** Fixed amounts follow the days worked. */
  prorate: boolean;
  /** Tax: annual exemption and brackets. */
  exemption?: number;
  brackets?: Bracket[];
  /** Social-insurance style ceiling on the base a percentage applies to (monthly, 0 = none). */
  cap?: number;
}

/** Share of the month worked (1 = full month), from hire and leaving dates. */
export function workedShare(month: string, hireDate: string | null, endDate: string | null): { days: number; ofDays: number; share: number } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const ofDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const last = `${month}-${String(ofDays).padStart(2, '0')}`;
  const from = hireDate && hireDate > first ? Number(hireDate.slice(8, 10)) : 1;
  const to = endDate && endDate < last ? Number(endDate.slice(8, 10)) : ofDays;
  if ((hireDate && hireDate > last) || (endDate && endDate < first) || to < from) return { days: 0, ofDays, share: 0 };
  const days = to - from + 1;
  return { days, ofDays, share: days / ofDays };
}

/** Progressive tax on an annual amount: each slice at its own rate. */
export function bracketTax(annual: number, brackets: Bracket[]): number {
  let tax = 0;
  let lower = 0;
  const sorted = [...brackets].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  for (const b of sorted) {
    if (annual <= lower) break;
    const upper = b.upTo ?? Infinity;
    const slice = Math.min(annual, upper) - lower;
    if (slice > 0) tax += (slice * b.rateBp) / 10000;
    lower = upper;
  }
  return Math.round(tax);
}

export interface PayslipLine {
  componentId: number | null;
  name: string;
  kind: Kind | 'basic' | 'adjustment';
  amount: number;
}

export interface PayslipInput {
  basicSalary: number;
  share: number;
  components: Component[];
  /** One-off for this month: extra earnings (bonus, overtime) and extra deductions (absence, advance). */
  bonus?: number;
  otherDeduction?: number;
}

/** One employee's month. */
export function payslip(p: PayslipInput) {
  const lines: PayslipLine[] = [];
  const r = Math.round;
  const basic = r(p.basicSalary * p.share);
  lines.push({ componentId: null, name: 'Basic salary', kind: 'basic', amount: basic });
  const pct = (base: number, c: Component) => r((Math.min(base, c.cap && c.cap > 0 ? c.cap : base) * c.value) / 10000);
  const fixed = (c: Component) => (c.prorate ? r(c.value * p.share) : c.value);

  let earnings = 0;
  for (const c of p.components.filter((x) => x.kind === 'earning')) {
    const amount = c.calc === 'fixed' ? fixed(c) : pct(basic, c);
    earnings += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'earning', amount });
  }
  if (p.bonus) {
    earnings += p.bonus;
    lines.push({ componentId: null, name: 'Bonus / overtime', kind: 'adjustment', amount: p.bonus });
  }
  const gross = basic + earnings;

  let deductions = 0;
  let preTax = 0;
  const taxes: Component[] = [];
  for (const c of p.components.filter((x) => x.kind === 'deduction')) {
    if (c.calc === 'tax') {
      taxes.push(c);
      continue;
    }
    const amount = c.calc === 'fixed' ? fixed(c) : pct(c.calc === 'percent_gross' ? gross : basic, c);
    deductions += amount;
    if (c.preTax) preTax += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'deduction', amount });
  }
  for (const c of taxes) {
    // Annualise the month's taxable pay, tax it on the yearly brackets, take a twelfth.
    const annualTaxable = Math.max(0, (gross - preTax) * 12 - (c.exemption ?? 0));
    const amount = r(bracketTax(annualTaxable, c.brackets ?? []) / 12);
    deductions += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'deduction', amount });
  }
  if (p.otherDeduction) {
    deductions += p.otherDeduction;
    lines.push({ componentId: null, name: 'Other deduction', kind: 'adjustment', amount: -p.otherDeduction });
  }

  let employer = 0;
  for (const c of p.components.filter((x) => x.kind === 'employer')) {
    const amount = c.calc === 'fixed' ? fixed(c) : pct(c.calc === 'percent_gross' ? gross : basic, c);
    employer += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'employer', amount });
  }
  return { basic, earnings, gross, deductions, net: gross - deductions, employer, lines };
}
