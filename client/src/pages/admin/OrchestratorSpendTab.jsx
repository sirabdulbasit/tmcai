/**
 * Admin — Build & Heal Spend. What the ORCHESTRATOR costs.
 *
 * A SECOND deck, deliberately not a section of LLM Spend. That page reports what the
 * application spends on Gemini/Claude through llmRouter — triage, criticality, composition,
 * billed per token by those providers. This page reports what building and healing the product
 * costs on Claude Code: the builder seat, the chat analyst, the reviewer. Different provider,
 * different bill. The two are never summed, and that is why they never share a page.
 *
 * THREE THINGS THIS SHOWS THAT THE LLM PAGE DOES NOT:
 *
 *   · CACHE READS AS THEIR OWN COLUMN. 96% of every token on this host is a cache read,
 *     because each turn of a resumed session re-sends the whole transcript. A "total tokens"
 *     figure that counted only input and output would report a twenty-fifth of the truth.
 *   · COST PER RUN AND PER TURN. The unit of orchestrator spend is a run, not a call. What
 *     a build iteration costs is the number that decides whether the loop can keep running.
 *   · WHAT IS NOT MEASURED, NAMED. Seats that emitted no usage are listed as unmeasured
 *     rather than shown at $0.00 — "healing was never measured" and "healing was free" are
 *     opposite claims and the page must not let one read as the other.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';

export default function OrchestratorSpendTab() {
  // Same controls as LLM Spend, and for the same reason: the window (`period`) and the bucket
  // (`groupBy`) are independent questions. A month grouped by day is thirty rows.
  const [period, setPeriod] = useState('month');
  const [groupBy, setGroupBy] = useState('day');
  const [day, setDay] = useState(today());
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const q = period === 'range'
        ? `from=${from}&to=${to}`
        : `period=${period}&day=${day}`;
      const { data } = await api.get(`/admin/orchestrator-spend?${q}&groupBy=${groupBy}`);
      setReport(data);
    } catch (e) {
      setErr(e?.response?.data?.error ?? e.message);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [period, day, from, to, groupBy]);

  // A reading with no age reads as "now". These figures can be days old, so they carry theirs.
  const ageOf = (iso) => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const h = ms / 3600000;
    if (h < 1) return { text: `${Math.max(1, Math.round(ms / 60000))}m ago`, stale: false };
    if (h < 24) return { text: `${Math.round(h)}h ago`, stale: h >= 12 };
    return { text: `${Math.round(h / 24)}d ago`, stale: true };
  };

  const fmt = (n) => Number(n ?? 0).toLocaleString();
  const fmtUsd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
  const fmtUsd4 = (n) => `$${Number(n ?? 0).toFixed(4)}`;

  const totals = report?.totals;
  // Per-run and per-turn are derived here rather than server-side: they are presentation of the
  // same two numbers, and a divide-by-zero on an empty window must show "—", not NaN.
  const perRun = totals?.runs ? totals.usd / totals.runs : null;
  const totalTurns = report?.seats?.reduce((s, x) => s + (x.turns ?? 0), 0) ?? 0;
  const perTurn = totalTurns ? totals.usd / totalTurns : null;
  const cacheShare = totals?.tokens
    ? Math.round((totals.cacheReadTokens / totals.tokens) * 1000) / 10
    : null;

  return (
    <section className="settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Build &amp; Heal Spend</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {report?.from && (report.from === report.to ? report.from : `${report.from} → ${report.to}`)}
            {report?.days != null && ` · ${report.days} ${groupBy}${report.days === 1 ? '' : 's'} with activity`}
            {' · Claude Code — separate bill from LLM Spend'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={periodRow}>
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['range', 'Range']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setPeriod(k)}
                      aria-pressed={period === k}
                      style={period === k ? periodBtnOn : periodBtn}>{label}</button>
            ))}
          </div>
          {period === 'range' ? (
            <>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={dateInput} aria-label="From" />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>&rarr;</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={dateInput} aria-label="To" />
            </>
          ) : (
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={dateInput}
                   aria-label={period === 'day' ? 'Day' : `Any day in the ${period}`} />
          )}
          <button className="admin-action" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>

      {err && <div className="settings-msg error">{err}</div>}

      {report && (
        <>
          {/* TOKENS LEAD, COST FOLLOWS — owner, 2026-09-01: "for build/heal the most important
              thing is token consumption then cost". The subscription is metered in tokens and
              throttles in tokens; the dollar figure is a consequence, not the constraint. So
              TOTAL TOKENS is highlighted and moved first, and Cost keeps its place but loses
              the emphasis it had. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
            <StatCard label="Total tokens" value={fmt(totals.tokens)} sub={cacheShare != null ? `${cacheShare}% cache reads` : null} highlight />
            <StatCard label="Runs" value={fmt(totals.runs)} />
            <StatCard label="Per turn" value={perTurn == null ? '—' : fmtUsd4(perTurn)} />
            <StatCard label="Per run" value={perRun == null ? '—' : fmtUsd(perRun)} />
            <StatCard label="Cost" value={fmtUsd(totals.usd)} />
          </div>

          {/* AGAINST THE SUBSCRIPTION — the owner's actual worry, 2026-09-01: "my concern is to
              review either we are over consuming tokens then my claude subscription limit?"

              These windows roll from NOW and ignore the range picker above, because "am I about
              to be throttled" is a question about this moment. Answering it with a month's total
              would be a different question answered quietly.

              WHAT THIS DOES NOT CLAIM. Anthropic publishes no window size, so there is no
              "X of Y tokens left" to show and inventing one would be the worst kind of number on
              a page like this. The share is derived from a MARGINAL rate measured on this box,
              and it is our contribution only — the same subscription also carries the owner's own
              sessions, so the real utilisation is always higher than our share. */}
          {report.subscription?.windows?.length > 0 && (
            <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ ...breakHead, padding: '8px 12px', margin: 0, background: 'var(--bg-2)' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Against the Claude subscription</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>rolling from now — not the range above</span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-2)' }}>
                    <th style={th}>Window</th>
                    <th style={{ ...th, textAlign: 'right' }}>Our runs</th>
                    <th style={{ ...th, textAlign: 'right' }}>Our tokens</th>
                    <th style={{ ...th, textAlign: 'right' }}>Our share</th>
                    <th style={th}>Claude reported</th>
                  </tr>
                </thead>
                <tbody>
                  {report.subscription.windows.map((w) => {
                    const rep = (report.limits || []).find((l) => l.type === w.type)
                      || (w.type === 'seven_day' && (report.limits || []).find((l) => l.type === 'seven_day_overage_included'));
                    const hot = w.sharePoints != null && w.sharePoints >= 15;
                    return (
                      <tr key={w.type} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...td, fontWeight: 600 }}>{w.label}</td>
                        <td style={{ ...td, ...numTd }}>{fmt(w.runs)}</td>
                        <td style={{ ...td, ...numTd, fontWeight: 600 }}>{fmt(w.tokens)}</td>
                        <td style={{ ...td, ...numTd, color: hot ? '#f59e0b' : 'var(--text)' }}>
                          {w.sharePoints == null
                            ? <span style={{ color: 'var(--text-muted)' }}>not measurable</span>
                            : `~${w.sharePoints}%`}
                        </td>
                        <td style={{ ...td, fontSize: 12 }}>
                          {!rep ? <span style={{ color: 'var(--text-muted)' }}>—</span> : (
                            <>
                              <span style={{
                                color: rep.status === 'rejected' ? '#ef4444'
                                  : rep.status === 'allowed_warning' ? '#f59e0b' : 'var(--text-muted)',
                                fontWeight: rep.status === 'allowed' ? 400 : 600,
                              }}>{rep.status || '—'}</span>
                              {' · '}
                              {rep.utilization == null
                                ? <span style={{ color: 'var(--text-muted)' }}>under 75% (not reported)</span>
                                : <strong>{Math.round(rep.utilization * 100)}% used</strong>}
                              {rep.rejectedRuns > 0 && (
                                <span style={{ color: '#ef4444' }}>{` · ${rep.rejectedRuns} run${rep.rejectedRuns === 1 ? '' : 's'} blocked`}</span>
                              )}
                              {/* HOW OLD THE READING IS. Claude only speaks when it is past its
                                  warning threshold, so the last figure can be days old — the
                                  seven-day "82%" on this box was five days stale when this was
                                  written. A percentage with no timestamp reads as "now", and a
                                  stale one would be the most misleading number on the page. */}
                              {ageOf(rep.observedAt) && (
                                <span style={{ color: ageOf(rep.observedAt).stale ? '#f59e0b' : 'var(--text-muted)' }}>
                                  {` · read ${ageOf(rep.observedAt).text}`}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                Share is <strong>ours only</strong>, from a marginal rate of {fmt(report.subscription.tokensPerPoint)} tokens
                per point measured on this box — your own sessions use the same subscription, so real
                utilisation is higher. Claude reports an exact figure only above its 75% warning
                threshold; below that it says nothing, which is shown as <em>under 75%</em> and never as 0%.
              </div>
            </div>
          )}

          {/* CONSUMPTION OVER TIME — the same shape as LLM Spend, so the two decks read alike.
              Cache reads get their own column because they are the workload here; folding them
              into "total" would hide the one number that explains the bill. */}
          <div style={{ marginBottom: 16 }}>
            <div style={breakHead}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Consumption by</span>
              <div style={periodRow}>
                {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setGroupBy(k)}
                          aria-pressed={groupBy === k}
                          style={groupBy === k ? periodBtnOn : periodBtn}>{label}</button>
                ))}
              </div>
            </div>
            {report.series?.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                No orchestrator runs in this window.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="admin-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>{groupBy === 'month' ? 'Month' : groupBy === 'week' ? 'Week' : 'Day'}</th>
                      <th style={numTh}>Runs</th>
                      <th style={numTh}>Tokens in</th>
                      <th style={numTh}>Tokens out</th>
                      <th style={numTh}>Cache reads</th>
                      <th style={numTh}>Total tokens</th>
                      <th style={numTh}>Cost</th>
                      <th>Seats</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.series.map((b) => (
                      <tr key={b.bucket}>
                        <td style={{ whiteSpace: 'nowrap' }}>{b.label}</td>
                        <td style={numTd}>{fmt(b.runs)}</td>
                        <td style={numTd}>{fmt(b.inTokens)}</td>
                        <td style={numTd}>{fmt(b.outTokens)}</td>
                        <td style={{ ...numTd, color: 'var(--text-muted)' }}>{fmt(b.cacheReadTokens)}</td>
                        <td style={numTd}>{fmt(b.tokens)}</td>
                        <td style={{ ...numTd, color: 'var(--accent, #c2410c)' }}>{fmtUsd(b.usd)}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {b.bySeat.map((s) => `${s.seat} ${fmtUsd(s.usd)}`).join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* PER SEAT — the orchestrator's equivalent of the per-user split. There is no user
              dimension: the loop builds the product, not a tenant's work. */}
          {report.seats?.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-2)' }}>
                    <th style={th}>Seat</th>
                    <th style={{ ...th, textAlign: 'right' }}>Runs</th>
                    <th style={{ ...th, textAlign: 'right' }}>Turns</th>
                    <th style={{ ...th, textAlign: 'right' }}>Tokens in</th>
                    <th style={{ ...th, textAlign: 'right' }}>Tokens out</th>
                    <th style={{ ...th, textAlign: 'right' }}>Cache reads</th>
                    <th style={{ ...th, textAlign: 'right' }}>Total tokens</th>
                    <th style={th}>Model</th>
                    <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.seats.map((s) => (
                    <tr key={s.seat} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{s.seat}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(s.runs)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(s.turns)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(s.inTokens)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(s.outTokens)}</td>
                      <td style={{ ...td, ...numTd, color: 'var(--text-muted)' }}>{fmt(s.cacheReadTokens)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(s.tokens)}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{s.models.join(' · ')}</td>
                      <td style={{ ...td, ...numTd, fontWeight: 600, color: '#cc6b4a' }}>{fmtUsd(s.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* PER CRON — the owner's "cron wise", and a genuinely different cut from Seat above.
              A seat is not a schedule: `build` comes from the nightly cron AND from a loop run
              by hand, and `heal` comes from both the ten-minute cron and the nightly loop's own
              chat stage. So this is its own query, not a regroup of the seat rows.

              UNATTRIBUTED IS ITS OWN ROW, never folded into "manual". Runs recorded before
              trigger capture existed have no schedule on file, and calling them manual would
              invent an answer for the whole August campaign. */}
          {report.triggers?.length > 0 && (
            <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-2)' }}>
                    <th style={th}>Cron / trigger</th>
                    <th style={{ ...th, textAlign: 'right' }}>Runs</th>
                    <th style={{ ...th, textAlign: 'right' }}>Tokens in</th>
                    <th style={{ ...th, textAlign: 'right' }}>Tokens out</th>
                    <th style={{ ...th, textAlign: 'right' }}>Total tokens</th>
                    <th style={th}>Seats</th>
                    <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.triggers.map((t) => (
                    <tr key={t.trigger ?? '∅'} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...td, fontWeight: 600 }}>
                        {t.trigger ?? (
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontStyle: 'italic' }}>
                            unattributed
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, ...numTd }}>{fmt(t.runs)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(t.inTokens)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(t.outTokens)}</td>
                      <td style={{ ...td, ...numTd }}>{fmt(t.tokens)}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{t.seats.join(' · ')}</td>
                      <td style={{ ...td, ...numTd, fontWeight: 600, color: '#cc6b4a' }}>{fmtUsd(t.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.triggers.some((t) => t.trigger == null) && (
                <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                  <em>unattributed</em> runs predate trigger recording — the schedule that launched
                  them was never written down. Unknown, not manual.
                </div>
              )}
            </div>
          )}

          {/* NOT MEASURED ≠ FREE. A seat that ran but emitted no usage events is named here
              rather than printed as a $0.00 row, which would be a false reading of the bill. */}
          {report.unmeasured?.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
              <strong style={{ color: '#f59e0b' }}>Not measured:</strong>{' '}
              {report.unmeasured.join(', ')} — these seats ran but emitted no usage events, so
              their cost is unknown. Not zero.
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
            Cost is the Claude Code CLI's own <code>total_cost_usd</code>, stored as reported at
            run time and never recomputed — a later rate change cannot rewrite history. Total
            tokens include cache reads and cache writes, which are billed.
            {report.ingest && ` Last sweep: ${report.ingest.ingested} of ${report.ingest.scanned} run logs ingested.`}
          </div>
        </>
      )}
    </section>
  );
}

const th = { padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)' };
const td = { padding: '10px 12px', fontSize: 13 };

function StatCard({ label, value, sub, highlight }) {
  return (
    <div style={{
      background: 'var(--bg-2)', border: `1px solid ${highlight ? '#cc6b4a' : 'var(--border)'}`,
      borderRadius: 8, padding: '12px 16px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? '#cc6b4a' : 'var(--text)', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function today() { return new Date().toISOString().slice(0, 10); }

const dateInput = {
  padding: '4px 8px', background: 'var(--bg-1)', border: '1px solid var(--border)',
  color: 'var(--text)', borderRadius: 6,
};
const periodRow = {
  display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
};
const periodBtn = {
  fontSize: 12, padding: '4px 10px', border: 0, cursor: 'pointer',
  background: 'transparent', color: 'var(--text-muted)',
};
const periodBtnOn = { ...periodBtn, background: 'var(--accent, #c2410c)', color: '#fff' };
const breakHead = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 };
const numTh = { textAlign: 'right' };
const numTd = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
