/**
 * DEF-354 — run history of one integration.
 *
 * Live runs by default; "Include tests" adds the dry runs. Each row: When · Who (On
 * schedule, or Run by <user>) · Read · Changed · Result. The Result is "Updated" ONLY when
 * something was written and "No changes" otherwise (vm §9 — never "Updated" for 0 writes;
 * integrationUi.runResult). Counts are distinct readings, never row counts. "What changed"
 * opens the outcome rows written in the same transaction as the data (spec §2.4 step 7).
 *
 * Read from the run rows, so it is right after a server restart too (an interrupted run
 * shows as Failed "interrupted by server restart", never as still running).
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { listRuns, listRunChanges, errorText } from '../../../services/integrationsApi';
import { s, btn, Pill, ChangesList, formatPkt, runResult } from './integrationUi';

function who(run) {
  if (run.trigger === 'scheduled') return 'On schedule';
  const by = run.triggeredByName || run.triggeredBy;
  if (by && !String(by).startsWith('user:')) return `Run by ${by}`;
  return by ? `Run by user ${String(by).slice(5)}` : 'Run by hand';
}

export default function RunHistory({ integrationId, integrationName, setMsg, onBack }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [includeTests, setIncludeTests] = useState(false);
  const [openRun, setOpenRun] = useState(null);
  const [changes, setChanges] = useState([]);
  const [changesLoading, setChangesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listRuns(integrationId, { limit: 100 }));
    } catch (e) {
      setMsg(`Failed to load the run history: ${errorText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [integrationId, setMsg]);

  useEffect(() => { load(); }, [load]);

  async function toggleChanges(run) {
    if (openRun === run.runId) { setOpenRun(null); return; }
    setOpenRun(run.runId);
    setChanges([]);
    setChangesLoading(true);
    try {
      setChanges(await listRunChanges(integrationId, run.runId));
    } catch (e) {
      setMsg(`Failed to load the changes: ${errorText(e)}`);
    } finally {
      setChangesLoading(false);
    }
  }

  const shown = includeTests ? runs : runs.filter((r) => !r.dryRun);

  return (
    <div>
      <div style={{ ...s.row, justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={s.h2}>History{integrationName ? ` — ${integrationName}` : ''}</h2>
          <p style={s.hint}>Times are Pakistan time (PKT).</p>
        </div>
        <span style={s.row}>
          <label style={{ ...s.row, gap: 6, cursor: 'pointer', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={includeTests} onChange={(e) => setIncludeTests(e.target.checked)} />
            Include tests
          </label>
          <button style={btn('outline', { small: true })} onClick={load}>Refresh</button>
          <button style={btn('outline', { small: true })} onClick={onBack}>← Back to integrations</button>
        </span>
      </div>

      {loading && runs.length === 0 && <div style={s.hint}>Loading…</div>}
      {!loading && shown.length === 0 && (
        <div style={s.card}>
          <p style={{ ...s.hint, margin: 0 }}>
            {runs.length > 0 ? 'No real runs yet — only tests. Tick “Include tests” to see them.' : 'Nothing has run yet.'}
          </p>
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ ...s.card, overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>When</th>
                <th style={s.th}>Who</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Read</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Changed</th>
                <th style={s.th}>Result</th>
                <th style={s.th}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((run) => {
                const res = runResult(run);
                const r = run.result;
                const isOpen = openRun === run.runId;
                return (
                  <Fragment key={run.runId}>
                    <tr>
                      <td style={s.td}>
                        {formatPkt(run.startedAt)}
                        {run.dryRun && <> <Pill>Test</Pill></>}
                      </td>
                      <td style={s.td}>{who(run)}</td>
                      <td style={s.tdNum}>{r ? r.recordsRead : '—'}</td>
                      <td style={s.tdNum}>{r ? r.writes : '—'}</td>
                      <td style={s.td}>
                        <Pill color={res.color}>{res.text}</Pill>
                        {run.error && <div style={{ ...s.hint, color: 'var(--text-muted)' }}>{run.error}</div>}
                        {Array.isArray(r?.anomalies) && r.anomalies.length > 0 && (
                          <ul style={{ ...s.hint, margin: '4px 0 0', paddingLeft: 18 }}>
                            {r.anomalies.map((a, i) => <li key={i}>{a}</li>)}
                          </ul>
                        )}
                      </td>
                      <td style={s.td}>
                        {run.status !== 'RUNNING' && (
                          <button style={btn('outline', { small: true })} onClick={() => toggleChanges(run)}>
                            {isOpen ? 'Hide' : 'What changed'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td style={{ ...s.td, background: 'var(--bg-1)' }} colSpan={6}>
                          <ChangesList changes={changes} loading={changesLoading} dryRun={run.dryRun} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
