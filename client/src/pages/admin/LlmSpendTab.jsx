/**
 * Admin — LLM Spend.
 * Per-user per-day rollup of tokens in/out, calls, estimated cost.
 * Data comes from system_config.llm_spend (maintained by llmRouter).
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';

export default function LlmSpendTab({ user }) {
  const [day, setDay] = useState(today());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const cn = user?.clientNumber ? `&cn=${user.clientNumber}` : '';
      const { data } = await api.get(`/admin/llm-spend?day=${day}${cn}`);
      setReport(data);
    } catch (e) {
      setErr(e?.response?.data?.error ?? e.message);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [day]);

  const fmt = (n) => n.toLocaleString();
  const fmtUsd = (n) => `$${n.toFixed(4)}`;

  return (
    <section className="settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>LLM Spend · {report?.clientNumber ?? ''}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Day</label>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ padding: '4px 8px', background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6 }} />
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
              No LLM activity for {day}.
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
