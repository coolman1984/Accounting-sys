/**
 * Multi-currency (provided by the FX module). Rates are integers: base-currency units per
 * one foreign unit × 1,000,000 (e.g. 1 USD = 48.35 EGP → 48_350_000).
 */
export const RATE_SCALE = 1_000_000;

export interface Currency {
  code: string;
  name_en: string;
  name_ar: string;
  symbol: string | null;
  is_active: number;
}

export interface FxService {
  /** The company's functional currency. */
  base(): string;
  /** True for any currency other than the base one (no check that it exists). */
  isForeign(code: string | null | undefined): boolean;
  /** Throws when the currency is unknown or inactive. */
  assertCurrency(code: string): Currency;
  /** Latest rate on or before `date`; throws `fx.no_rate` when there is none. */
  rate(code: string, date: string): number;
  /** Foreign minor units → base minor units at `rate` (round half away from zero). */
  toBase(amount: number, rate: number): number;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    fx: FxService;
  }
}
