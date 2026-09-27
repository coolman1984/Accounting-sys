import type { ReactNode } from 'react';
import { useI18n } from '../core/i18n';
import { todayIso } from '../core/format';

export type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'cyan';

export function Badge({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${tone === 'neutral' ? '' : 'badge-' + tone} ${plain ? 'plain' : ''}`}>{children}</span>;
}

export type DocState = 'draft' | 'void' | 'paid' | 'overdue' | 'partial' | 'unpaid';
const DOC_TONE: Record<DocState, Tone> = { draft: 'neutral', void: 'red', paid: 'green', overdue: 'red', partial: 'amber', unpaid: 'blue' };

/** Where an invoice/bill/credit note stands, including payment progress. */
export function docState(status: string, total: number, settled: number, due?: string | null): DocState {
  if (status === 'draft') return 'draft';
  if (status === 'void') return 'void';
  if (settled >= total) return 'paid';
  if (due && due < todayIso()) return 'overdue';
  if (settled > 0) return 'partial';
  return 'unpaid';
}

export function DocStatus({ status, total, settled, due }: { status: string; total: number; settled: number; due?: string }) {
  const { t } = useI18n();
  const s = docState(status, total, settled, due);
  return <Badge tone={DOC_TONE[s]}>{t('status.' + s)}</Badge>;
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
