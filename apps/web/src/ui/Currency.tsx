import { useEffect, useRef } from 'react';
import { useApi } from '../core/hooks';
import { useI18n } from '../core/i18n';
import { useSession } from '../core/session';
import { DecimalInput, Field, Select } from './Field';

/** Rates travel as integers: base units per one foreign unit × 1,000,000. */
export const RATE_SCALE = 6;
export const RATE_ONE = 1_000_000;

export interface CurrencyRow {
  code: string;
  name_en: string;
  name_ar: string;
  symbol: string | null;
  is_active: number;
  last_rate: number | null;
  last_rate_date: string | null;
}

/** Foreign currencies when the Multi-currency app is on (the base currency is never in the list). */
export function useCurrencies() {
  const { hasApp, company } = useSession();
  const on = hasApp('fx');
  const { data } = useApi<CurrencyRow[]>(on ? '/currencies' : null, undefined, { staleTime: 60_000 });
  return { on, base: company?.baseCurrency ?? '', list: data ?? [] };
}

/** Foreign minor units → base minor units, as the server does it (round half away from zero). */
export function toBase(amount: number, rate: number): number {
  const v = (Math.abs(amount) * rate) / RATE_ONE;
  return Math.sign(amount) * Math.round(v);
}

/**
 * Currency picker + rate, used by invoices, bills and payments. The rate follows the currency and
 * the date (latest rate on or before it) until the user types their own.
 */
export function CurrencyRateFields({
  currency,
  rate,
  date,
  onChange,
  locked,
}: {
  currency: string;
  rate: number;
  date: string;
  onChange(v: { currency: string; rate: number }): void;
  /** The currency cannot change (e.g. a credit note follows its invoice). */
  locked?: boolean;
}) {
  const { t, pick } = useI18n();
  const { on, base, list } = useCurrencies();
  const foreign = currency !== base;
  const touched = useRef(false);
  const { data: day } = useApi<{ rate: number | null; date: string | null }>(on && foreign ? '/fx/rate' : null, { currency, date });
  useEffect(() => {
    if (!foreign || touched.current || !day?.rate || day.rate === rate) return;
    onChange({ currency, rate: day.rate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, foreign]);
  if (!on && !foreign) return null;
  return (
    <>
      <Field label={t('fx.currency')}>
        <Select
          value={currency}
          disabled={locked}
          onChange={(e) => {
            touched.current = false;
            onChange({ currency: e.target.value, rate: e.target.value === base ? RATE_ONE : rate });
          }}
        >
          <option value={base}>{base}</option>
          {list
            .filter((c) => c.is_active || c.code === currency)
            .map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {pick(c.name_en, c.name_ar)}
              </option>
            ))}
        </Select>
      </Field>
      {foreign && (
        <Field
          label={t('fx.rate')}
          hint={
            day && !day.rate
              ? t('fx.noRateHint', { currency, date })
              : t('fx.rateHint', { currency, base, rate: (rate / RATE_ONE).toLocaleString('en', { maximumFractionDigits: 6 }) })
          }
        >
          <DecimalInput
            scale={RATE_SCALE}
            trim
            value={rate}
            disabled={locked}
            onChange={(v) => {
              touched.current = true;
              onChange({ currency, rate: v && v > 0 ? v : rate });
            }}
          />
        </Field>
      )}
    </>
  );
}
