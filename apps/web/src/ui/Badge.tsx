import type { ReactNode } from 'react';
import { useI18n } from '../core/i18n';
import { todayIso } from '../core/format';

export type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'cyan';

export function Badge({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${tone === 'neutral' ? '' : 'badge-' + tone} ${plain ? 'plain' : ''}`}>{children}</span>;
}

/** Status of an invoice/bill/credit note, including payment progress. */
export function DocStatus({ status, total, settled, due }: { status: string; total: number; settled: number; due?: string }) {
  const { t } = useI18n();
  if (status === 'draft') return <Badge>{t('status.draft')}</Badge>;
  if (status === 'void') return <Badge tone="red">{t('status.void')}</Badge>;
  if (settled >= total) return <Badge tone="green">{t('status.paid')}</Badge>;
  if (due && due < todayIso()) return <Badge tone="red">{t('status.overdue')}</Badge>;
  if (settled > 0) return <Badge tone="amber">{t('status.partial')}</Badge>;
  return <Badge tone="blue">{t('status.unpaid')}</Badge>;
}

export function EntryStatus({ status, reversed, reversal }: { status: string; reversed?: boolean; reversal?: boolean }) {
  const { t } = useI18n();
  if (status === 'draft') return <Badge>{t('status.draft')}</Badge>;
  if (reversed) return <Badge tone="amber">{t('status.reversed')}</Badge>;
  if (reversal) return <Badge tone="cyan">{t('status.reversal')}</Badge>;
  return <Badge tone="green">{t('status.posted')}</Badge>;
}

export function SimpleStatus({ status }: { status: 'draft' | 'posted' | 'void' | string }) {
  const { t } = useI18n();
  const tone: Tone = status === 'posted' ? 'green' : status === 'void' ? 'red' : 'neutral';
  return <Badge tone={tone}>{t('status.' + status)}</Badge>;
}
