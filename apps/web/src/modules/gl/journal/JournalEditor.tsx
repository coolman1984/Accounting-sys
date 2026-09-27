import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CheckCircle2, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../../core/hooks';
import { useI18n } from '../../../core/i18n';
import { api } from '../../../core/api';
import { todayIso } from '../../../core/format';
import type { Account, JournalEntry } from '../../../core/types';
import { PageHeader, Loading } from '../../../ui/Page';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Checkbox, DecimalInput, Field, Input } from '../../../ui/Field';
import { AccountPicker, PartyPicker, useAccounts } from '../../../ui/Pickers';
import { useToast } from '../../../ui/Toast';
import { Kbd, modKey } from '../../../ui/Brand';
import { CostCenterSelect, useCostCenters } from '../../../ui/CostCenter';

interface Line {
  key: number;
  accountId: number | null;
  description: string;
  partyId: number | null;
  costCenterId: number | null;
  debit: number | null;
  credit: number | null;
}

let k = 0;
const blank = (): Line => ({ key: ++k, accountId: null, description: '', partyId: null, costCenterId: null, debit: null, credit: null });

export function JournalEditor() {
  const { id } = useParams();
  const editing = id != null;
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { data: accounts } = useAccounts();
  const { data: existing, isLoading } = useApi<JournalEntry>(editing ? `/journal/${id}` : null);

  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [opening, setOpening] = useState(false);
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!existing) return;
    setDate(existing.date);
    setReference(existing.reference ?? '');
    setMemo(existing.memo ?? '');
    setOpening(existing.source_type === 'opening');
    setLines(
      existing.lines.map((l) => ({
        key: ++k,
        accountId: l.account_id,
        description: l.description ?? '',
        partyId: l.party_id,
        costCenterId: l.cost_center_id ?? null,
        debit: l.debit || null,
        credit: l.credit || null,
      })),
    );
  }, [existing]);

  const byId = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const needsParty = (a?: Account) => a?.subtype === 'receivable' || a?.subtype === 'payable';
  // Cost centers (CO app) apply to income and expense lines.
  const cc = useCostCenters();
  const takesCostCenter = (a?: Account) => a?.type === 'income' || a?.type === 'expense';

  const totals = useMemo(() => {
    const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const c = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    return { d, c, diff: d - c };
  }, [lines]);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = useApiMutation((post: boolean) => {
    const body = {
      date,
      reference: reference || null,
      memo: memo || null,
      opening,
      post,
      lines: lines
        .filter((l) => l.accountId || l.debit || l.credit)
        .map((l) => ({
          accountId: l.accountId,
          description: l.description || null,
          partyId: needsParty(byId.get(l.accountId ?? 0)) ? l.partyId : null,
          costCenterId: cc.on && takesCostCenter(byId.get(l.accountId ?? 0)) ? l.costCenterId : null,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
        })),
    };
    return editing ? api.put<{ id: number }>(`/journal/${id}`, body) : api.post<{ id: number }>('/journal', body);
  });

  const submit = useCallback(
    (post: boolean) => {
      setErr('');
      save.mutate(post, {
        onSuccess: (r) => {
          toast.success(post ? t('common.posted') : t('common.saved'));
          navigate(`/journal/${r.id}`);
        },
        onError: (e) => setErr(errText(e)),
      });
    },
    [save, toast, t, navigate, errText],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') {
        e.preventDefault();
        submit(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submit(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  if (editing && isLoading) return <Loading />;

  const balanced = totals.diff === 0 && totals.d > 0;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/journal', label: t('journal.title') }]}
        title={editing ? t('journal.edit') : t('journal.new')}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables}>
              {t('common.saveDraft')}
            </Button>
            <Button variant="primary" onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!balanced}>
              {t('common.saveAndPost')}
            </Button>
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'end' }}>
            <Field label={t('common.date')}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={t('common.reference')}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Field label={t('common.memo')} className="span-2">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: 14 }}>
            <Checkbox label={t('journal.opening')} checked={opening} onChange={setOpening} />
          </div>
        </Card>

        <Card className="lines-grid">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: cc.on ? '24%' : '30%' }}>{t('common.account')}</th>
                  <th>{t('common.description')}</th>
                  <th style={{ width: cc.on ? '16%' : '18%' }}>{t('journal.partyNeeded')}</th>
                  {cc.on && <th style={{ width: 160 }}>{t('co.costCenter')}</th>}
                  <th className="end" style={{ width: 140 }}>
                    {t('common.debit')}
                  </th>
                  <th className="end" style={{ width: 140 }}>
                    {t('common.credit')}
                  </th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const acc = byId.get(l.accountId ?? 0);
                  return (
                    <tr key={l.key}>
                      <td className="line-no">{i + 1}</td>
                      <td>
                        <AccountPicker value={l.accountId} onChange={(id) => update(l.key, { accountId: id })} />
                      </td>
                      <td>
                        <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} placeholder={memo} />
                      </td>
                      <td>
                        {needsParty(acc) ? (
                          <PartyPicker
                            kind={acc?.subtype === 'receivable' ? 'customer' : 'supplier'}
                            value={l.partyId}
                            invalid={!l.partyId}
                            onChange={(id) => update(l.key, { partyId: id })}
                          />
                        ) : (
                          <span className="faint" style={{ display: 'block', paddingTop: 8, paddingInlineStart: 12 }}>
                            —
                          </span>
                        )}
                      </td>
                      {cc.on && (
                        <td>
                          {takesCostCenter(acc) ? (
                            <CostCenterSelect value={l.costCenterId} onChange={(v) => update(l.key, { costCenterId: v })} list={cc.list} />
                          ) : (
                            <span className="faint" style={{ display: 'block', paddingTop: 8, paddingInlineStart: 12 }}>
                              —
                            </span>
                          )}
                        </td>
                      )}
                      <td>
                        <DecimalInput
                          scale={scale}
                          value={l.debit}
                          onChange={(v) => update(l.key, { debit: v, credit: v ? null : l.credit })}
                          aria-label={t('common.debit')}
                        />
                      </td>
                      <td>
                        <DecimalInput
                          scale={scale}
                          value={l.credit}
                          onChange={(v) => update(l.key, { credit: v, debit: v ? null : l.debit })}
                          aria-label={t('common.credit')}
                        />
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon={<Trash2 />}
                          disabled={lines.length <= 2}
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                          aria-label={t('common.remove')}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 14px' }}>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus />}
              onClick={() => {
                // Pre-fill the balancing amount on the new line — the most common next step.
                const nl = blank();
                if (totals.diff > 0) nl.credit = totals.diff;
                if (totals.diff < 0) nl.debit = -totals.diff;
                setLines((ls) => [...ls, nl]);
              }}
            >
              {t('common.addLine')}
            </Button>
          </div>
          <div className="balance-bar">
            {balanced ? (
              <span className="row success-text" style={{ gap: 6, fontWeight: 600 }}>
                <CheckCircle2 size={17} /> {t('journal.balanced')}
              </span>
            ) : (
              <span className="row" style={{ gap: 6, color: 'var(--warning)', fontWeight: 600 }}>
                <AlertTriangle size={17} /> {t('journal.unbalanced', { amount: fmt(Math.abs(totals.diff)) })}
              </span>
            )}
            <span className="spacer" />
            <span className="muted">
              {t('common.debit')} <span className="amount">{fmt(totals.d)}</span>
            </span>
            <span className="muted">
              {t('common.credit')} <span className="amount">{fmt(totals.c)}</span>
            </span>
          </div>
        </Card>

        {err && (
          <div className="notice danger">
            <AlertTriangle />
            <div>{err}</div>
          </div>
        )}
        <p className="faint row" style={{ fontSize: 12.5, gap: 6 }}>
          <Kbd>{modKey}</Kbd>
          <Kbd>S</Kbd> {t('common.saveDraft')} · <Kbd>{modKey}</Kbd>
          <Kbd>↵</Kbd> {t('common.saveAndPost')}
        </p>
      </div>
    </div>
  );
}
