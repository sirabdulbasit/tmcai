/**
 * Admin — LLM Spend.
 * Per-user per-day rollup of tokens in/out, calls, estimated cost.
 * Data comes from system_config.llm_spend (maintained by llmRouter).
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';

export default function LlmSpendTab({ user }) {
  // Owner, 2026-08-27: "i need this daily, weekly, monthly and with date range etc".
  // `period` drives week/month boundaries SERVER-side so client and server cannot disagree about
  // where a week starts — it begins Monday, which matters because his working week does.
  const [period, setPeriod] = useState('day');
  const [day, setDay] = useState(today());
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const cn = user?.clientNumber ? `&cn=${user.clientNumber}` : '';
      const q = period === 'range'
        ? `from=${from}&to=${to}`
        : `period=${period}&day=${day}`;
      const { data } = await api.get(`/admin/llm-spend?${q}${cn}`);
      setReport(data);
    } catch (e) {
      setErr(e?.response?.data?.error ?? e.message);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [period, day, from, to]);

  const fmt = (n) => n.toLocaleString();
  const fmtUsd = (n) => `$${n.toFixed(4)}`;

  return (
    <section className="settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>LLM Spend · {report?.clientNumber ?? ''}</h2>
          {report?.from && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {report.from === report.to ? report.from : `${report.from} → ${report.to}`}
              {report.days != null && ` · ${report.days} day${report.days === 1 ? '' : 's'} with activity`}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={periodRow}>
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['range', 'Range']].map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setPeriod(k)}
                aria-pressed={period === k}
                style={period === k ? periodBtnOn : periodBtn}
              >
                {label}
              </button>
            ))}
          </div>
          {period === 'range' ? (
            <>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={dateInput} aria-label="From" />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>&rarr;</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={dateInput} aria-label="To" />
            </>
          ) : (
            /* One date for all three: it ANCHORS the period rather than naming it. Picking the
               14th with Month selected means that month, not the 14th — which is why the label
               changes with the period instead of always reading "Day". */
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={dateInput}
                   aria-label={period === 'day' ? 'Day' : `Any day in the ${period}`} />
          )}
          <button className="admin-action" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>

      {err && <div className="settings-msg error">{err}</div>}

      {report && (
        <>
          {/* Totals */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
            <StatCard label="Total calls" value={fmt(report.totals.calls)} />
            <StatCard label="Total tokens" value={fmt(report.totals.tokens)} />
            <StatCard label="Estimated cost" value={fmtUsd(report.totals.usd)} highlight />
          </div>

          {/* Per-user breakdown */}
          {report.users.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
              No LLM activity in this period.
            </div>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-2)' }}>
                    <th style={th}>User</th>
                    <th style={th}>Calls</th>
                    <th style={th}>Tokens in</th>
                    <th style={th}>Tokens out</th>
                    <th style={th}>Providers</th>
                    <th style={th}>Purposes</th>
                    <th style={th}>Cost (est)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.users.map((u) => {
                    const totalIn = Object.values(u.providers).reduce((s, p) => s + (p.in ?? 0), 0);
                    const totalOut = Object.values(u.providers).reduce((s, p) => s + (p.out ?? 0), 0);
                    return (
                      <tr key={u.userId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={td}>user #{u.userId}</td>
                        <td style={td}>{fmt(u.totalCalls)}</td>
                        <td style={td}>{fmt(totalIn)}</td>
                        <td style={td}>{fmt(totalOut)}</td>
                        <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>
                          {Object.entries(u.providers).map(([p, b]) => `${p.replace('gemini-', 'g-')}:${b.calls}`).join(' · ')}
                        </td>
                        <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>
                          {Object.entries(u.byPurpose).map(([p, n]) => `${p}:${n}`).join(' · ')}
                        </td>
                        <td style={{ ...td, fontWeight: 600, color: u.estimatedCostUsd > 0.1 ? '#f59e0b' : 'var(--text)' }}>
                          {fmtUsd(u.estimatedCostUsd)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
            Cost is estimated from published per-token pricing (Gemini Flash $0.075/$0.30 per 1M in/out · Gemini Pro $1.25/$5.00 · Claude Haiku $0.25/$1.25). Token counts are estimated from text length (~4 chars/token). Real cost is what your provider bills.
          </div>
        </>
      )}
    </section>
  );
}

const th = { padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)' };
const td = { padding: '10px 12px', fontSize: 13 };

function StatCard({ label, value, highlight }) {
  return (
    <div style={{
      background: 'var(--bg-2)', border: `1px solid ${highlight ? '#cc6b4a' : 'var(--border)'}`,
      borderRadius: 8, padding: '12px 16px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? '#cc6b4a' : 'var(--text)', marginTop: 4 }}>{value}</div>
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
