/**
 * Egypt's figures the system applies or checks against, in one place with their source.
 * Amounts are in pounds (callers multiply by the currency unit). Values the authorities change
 * are also editable where they are used (payroll components, withholding settings).
 */

/** VAT Law 67/2016: the standard rate and the registration threshold on annual sales. */
export const EG_VAT = { standardRateBp: 1400, registrationThreshold: 500_000 };

/** Income Tax Law 91/2005: the corporate rate. */
export const EG_CORPORATE_TAX_BP = 2250;

/** Companies Law 159/1981: 5% of each year's net profit to the legal reserve until it equals half the issued capital. */
export const EG_LEGAL_RESERVE = { shareBp: 500, capBpOfCapital: 5000 };

/**
 * Social insurance (Law 148/2019): shares of the insurable wage and the monthly minimum and maximum
 * insurable wage announced for each year.
 */
export const EG_INSURANCE = {
  employeeBp: 1100,
  employerBp: 1875,
  limits: {
    2025: { min: 2_300, max: 14_500 },
    2026: { min: 2_700, max: 16_700 },
  } as Record<number, { min: number; max: number }>,
};

/** E-invoices and receipts: an individual buyer's national ID is required at or above this total. */
export const EG_PERSON_ID_LIMIT = 50_000;
