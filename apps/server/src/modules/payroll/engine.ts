/**
 * Payroll arithmetic — pure functions, no database.
 *
 *  - workedShare():  the part of a month an employee was on the payroll (hired or left mid-month).
 *  - bracketTax():   progressive tax on an annual amount (brackets set by the company).
 *  - payslip():      one employee's month: basic, earnings, gross, deductions, net, employer costs.
 *
 * Money in minor units; rates in basis points. Components, rates and brackets are the company's
 * settings; `egyptSalaryTax()` is the one built-in law (Egypt, Law 91/2005 art. 8 as amended by
 * Law 7/2024), chosen per tax component.
 */

export type Kind = 'earning' | 'deduction' | 'employer';
export type Calc = 'fixed' | 'percent_basic' | 'percent_gross' | 'percent_insurable' | 'tax';
export type TaxRule = 'eg_2024';

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
  /** Social-insurance style minimum base (monthly, 0 = none). */
  floor?: number;
  /** A tax law built in (brackets come from the law, not from `brackets`). */
  taxRule?: TaxRule | null;
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

/**
 * Egypt's salary tax on annual taxable income (after the employee's social insurance and the
 * personal exemption), Law 91/2005 art. 8 as amended by Law 7/2024:
 *
 *   0 – 40,000 at 0%, to 55,000 at 10%, to 70,000 at 15%, to 200,000 at 20%, to 400,000 at 22.5%,
 *   to 1,200,000 at 25%, above at 27.5%.
 *
 * Above 600,000 the lower brackets fall away: the first bracket applied starts at 10% (600k–700k),
 * 15% (700k–800k), 20% (800k–900k), 22.5% (900k–1.2m) and 25% above 1.2m. The income is rounded
 * down to the nearest 10 pounds. `unit` is one pound in minor units (100 for piasters).
 */
export function egyptSalaryTax(annual: number, unit = 100): number {
  const E = (egp: number) => egp * unit;
  const income = Math.floor(annual / E(10)) * E(10);
  if (income <= 0) return 0;
  const full: Bracket[] = [
    { upTo: E(40_000), rateBp: 0 },
    { upTo: E(55_000), rateBp: 1000 },
    { upTo: E(70_000), rateBp: 1500 },
    { upTo: E(200_000), rateBp: 2000 },
    { upTo: E(400_000), rateBp: 2250 },
    { upTo: E(1_200_000), rateBp: 2500 },
    { upTo: null, rateBp: 2750 },
  ];
  // How many of the lowest brackets are dropped (merged into the next one's rate).
  const dropped = income > E(1_200_000) ? 5 : income > E(900_000) ? 4 : income > E(800_000) ? 3 : income > E(700_000) ? 2 : income > E(600_000) ? 1 : 0;
  return bracketTax(income, full.slice(dropped));
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
  /** Monthly wage declared to social insurance (Egypt: أجر الاشتراك); null = the month's gross. */
  insurableWage?: number | null;
  /** One pound in minor units, for laws that round in pounds. */
  unit?: number;
}

/** One employee's month. */
export function payslip(p: PayslipInput) {
  const lines: PayslipLine[] = [];
  const r = Math.round;
  const basic = r(p.basicSalary * p.share);
  lines.push({ componentId: null, name: 'Basic salary', kind: 'basic', amount: basic });
  // A percentage's base is kept between the component's minimum and ceiling (social insurance).
  const clamp = (base: number, c: Component) => Math.max(Math.min(base, c.cap && c.cap > 0 ? c.cap : base), c.floor ?? 0);
  const pct = (base: number, c: Component) => r((clamp(base, c) * c.value) / 10000);
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

  // Declared insurable wage, bounded then prorated for a part month; without one, the month's gross.
  const insurable = (c: Component) => (p.insurableWage != null ? r((clamp(p.insurableWage, c) * p.share * c.value) / 10000) : pct(gross, c));
  const percent = (c: Component) => (c.calc === 'percent_insurable' ? insurable(c) : pct(c.calc === 'percent_gross' ? gross : basic, c));

  let deductions = 0;
  let preTax = 0;
  const taxes: Component[] = [];
  for (const c of p.components.filter((x) => x.kind === 'deduction')) {
    if (c.calc === 'tax') {
      taxes.push(c);
      continue;
    }
    const amount = c.calc === 'fixed' ? fixed(c) : percent(c);
    deductions += amount;
    if (c.preTax) preTax += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'deduction', amount });
  }
  for (const c of taxes) {
    // Annualise the month's taxable pay, tax it on the yearly brackets, take a twelfth.
    const annualTaxable = Math.max(0, (gross - preTax) * 12 - (c.exemption ?? 0));
    const yearly = c.taxRule === 'eg_2024' ? egyptSalaryTax(annualTaxable, p.unit ?? 100) : bracketTax(annualTaxable, c.brackets ?? []);
    const amount = r(yearly / 12);
    deductions += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'deduction', amount });
  }
  if (p.otherDeduction) {
    deductions += p.otherDeduction;
    lines.push({ componentId: null, name: 'Other deduction', kind: 'adjustment', amount: -p.otherDeduction });
  }

  let employer = 0;
  for (const c of p.components.filter((x) => x.kind === 'employer')) {
    const amount = c.calc === 'fixed' ? fixed(c) : percent(c);
    employer += amount;
    lines.push({ componentId: c.id, name: c.name, kind: 'employer', amount });
  }
  return { basic, earnings, gross, deductions, net: gross - deductions, employer, lines };
}
