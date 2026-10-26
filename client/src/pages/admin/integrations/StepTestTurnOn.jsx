/**
 * DEF-354 — Step 5, Test & turn on.
 *
 * "Run the test" is a DRY run of the ON-SCREEN mapping version (spec §2.4 step 6): it reads
 * the sheet, works out every reading that would change, stores those as preview rows and
 * writes nothing else. It reports the change-cap verdict as a SCHEDULED run would see it
 * (spec §2.4 step 5), so the admin learns before turning on whether the first unattended
 * run would stop.
 *
 * "Turn it on" is enabled only after a passing test of this version. The server checks the
 * same thing again in one transaction — a SUCCESS dry run of this version with the current
 * connection fingerprint (spec §2.5) — and its refusal reasons are shown verbatim. Turning
 * on NEVER runs anything; the confirm says so and shows when the first run would be.
 */
import { useEffect, useState } from 'react';
import {
  listSuggestions, listRuns, listRunChanges, runAndWait, activateIntegration, errorText,
} from '../../../services/integrationsApi';
import { runStageText } from './WorkingOverlay';
import {
  C, s, btn, InlineConfirm, ChangesList, formatPkt, scheduleText, previewNextRun, runResult,
} from './integrationUi';

export default function StepTestTurnOn({ integ, refresh, setMsg, signal, setWorking, versionId, setVersionId, onBack, onDone }) {
  const [version, setVersion] = useState(null);
  const [approvedCount, setApprovedCount] = useState(0);
  const [run, setRun] = useState(null); // RunStatusView of the latest test of this version
  const [changes, setChanges] = useState([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Load the on-screen version (latest when the admin jumped straight here) and the most
  // recent finished test of THAT version, so a test passed earlier still counts — unless a
  // field was approved or withdrawn after it started.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setRun(null);
      setChanges([]);
      try {
        const res = await listSuggestions(integ.id, versionId || undefined);
        if (cancelled) return;
        setVersion(res.version);
        setApprovedCount(res.suggestions.filter((x) => x.status === 'APPROVED').length);
        if (res.version && res.version.id !== versionId) setVersionId(res.version.id);
        if (res.version) {
          const runs = await listRuns(integ.id, { limit: 20 });
          if (cancelled) return;
          // Only a test started after the version's last approve/withdraw counts — the
          // server's activation rule (mappingStore.activate). An older test previewed a
          // different set of fields, so it is neither shown as current nor a pass.
          const lastDecided = res.suggestions.reduce((max, x) => {
            const t = x.decidedAt ? Date.parse(x.decidedAt) : NaN;
            return Number.isFinite(t) && t > max ? t : max;
          }, -Infinity);
          const lastTest = runs.find((r) => r.dryRun && r.status !== 'RUNNING' && r.mappingVersionId === res.version.id
            && Date.parse(r.startedAt) >= lastDecided);
          if (lastTest) {
            setRun(lastTest);
            loadChanges(lastTest.runId, () => cancelled);
          }
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integ.id, versionId]);

  async function loadChanges(runId, isCancelled = () => false) {
    setChangesLoading(true);
    try {
      const list = await listRunChanges(integ.id, runId);
      if (!isCancelled()) setChanges(list);
    } catch (e) {
      if (!isCancelled()) setError(errorText(e));
    } finally {
      if (!isCancelled()) setChangesLoading(false);
    }
  }

  async function runTest() {
    if (!version) return;
    const startedAt = new Date().toISOString();
    const title = `Testing mapping version ${version.version}`;
    setWorking({ title, stage: runStageText(null, true), startedAt });
    setError('');
    setChanges([]);
    try {
      const final = await runAndWait(integ.id, { dryRun: true, versionId: version.id }, {
        signal,
        onTick: (r) => setWorking({ title, stage: runStageText(r, true), startedAt }),
      });
      setRun(final);
      setMsg(`Test finished: ${runResult(final).text}.`);
      await loadChanges(final.runId);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(null);
    }
  }

  async function turnOn() {
    setError('');
    try {
      const updated = await activateIntegration(integ.id, version.id);
      setMsg(updated?.frequency === 'once'
        ? `“${updated?.name ?? integ.name}” is on. It runs only when you press Run now.`
        : `“${updated?.name ?? integ.name}” is on. First run: ${formatPkt(updated?.nextRunAt)}.`);
      onDone();
    } catch (e) {
      const reasons = e?.response?.data?.reasons;
      setError(Array.isArray(reasons) && reasons.length ? `Cannot turn on: ${reasons.join('; ')}` : errorText(e));
    }
  }

  if (loading && !version) return <div style={s.hint}>Loading…</div>;
  if (!version) {
    return (
      <div>
        <h3 style={s.h3}>Test & turn on</h3>
        <p style={s.hint}>There is no mapping to test yet.</p>
        {error && <div style={s.error}>{error}</div>}
        <div style={{ ...s.row, marginTop: 16 }}><button style={btn('outline')} onClick={onBack}>← Schedule</button></div>
      </div>
    );
  }

  const r = run?.result;
  const passed = run?.status === 'SUCCESS';
  const alreadyRunning = integ.status === 'ACTIVE' && integ.approvedVersionId === version.id;
  const canTurnOn = passed && approvedCount > 0 && !alreadyRunning;
  const next = previewNextRun(integ, integ.timezone);
  const confirmText = integ.frequency === 'once'
    ? 'Turning it on does not run it. It will run only when you press Run now.'
    : `Turning it on does not run it. ${scheduleText(integ)} (${integ.timezone || 'Asia/Karachi'}); first run about ${next ? formatPkt(next.toISOString()) : '—'}.`;

  return (
    <div>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <h3 style={{ ...s.h3, margin: 0 }}>Test & turn on</h3>
        <span style={s.hint}>Mapping version {version.version} · {approvedCount} approved field{approvedCount === 1 ? '' : 's'}</span>
      </div>
      <p style={s.hint}>
        The test reads the sheet now and shows exactly what would change. It writes nothing.
      </p>

      <div style={{ ...s.row, marginTop: 12 }}>
        <button style={btn('primary', { disabled: approvedCount === 0 })} disabled={approvedCount === 0} onClick={runTest}>
          {run ? 'Run the test again' : 'Run the test'}
        </button>
        {approvedCount === 0 && <span style={s.hint}>Approve at least one field first.</span>}
        {run && <span style={s.hint}>Last test {formatPkt(run.finishedAt || run.startedAt)}</span>}
      </div>

      {run && (
        <>
          {run.status === 'FAILED' || run.status === 'ABORTED' ? (
            <div style={s.error}>The test did not pass. {run.error || r?.error || ''}</div>
          ) : run.status === 'PARTIAL' ? (
            <div style={s.warnBox}>Only part of the sheet could be read, so this test does not count as a pass. {(r?.anomalies || []).join(' ')}</div>
          ) : null}

          {r && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
              <Tile label="Rows read" value={r.recordsRead} />
              <Tile label="Readings that would change" value={r.writes} />
              <Tile label="Set aside" value={r.setAside} />
              <Tile label="Blanks (kept as they are)" value={r.blanks} />
              <Tile label="Change" value={`${Number(r.changePercent ?? 0).toFixed(1)}%`} />
              <Tile
                label="Safety limit"
                value={r.capVerdict?.wouldTrip ? 'Would stop' : 'Would continue'}
                color={r.capVerdict?.wouldTrip ? C.warn : C.ok}
              />
            </div>
          )}
          {r?.capVerdict && (
            <p style={s.hint}>
              {r.capVerdict.wouldTrip
                ? `A scheduled run would stop here and write nothing: it would change ${r.capVerdict.pct}% of the readings this integration keeps, above the ${r.capVerdict.cap}% limit. Run now is never limited.`
                : `A scheduled run would continue: ${r.capVerdict.pct}% change against a ${r.capVerdict.cap}% limit${r.capVerdict.pct === 0 && r.writes > 0 ? ' (a first load is never stopped)' : ''}.`}
            </p>
          )}
          {Array.isArray(r?.anomalies) && r.anomalies.length > 0 && run.status !== 'PARTIAL' && (
            <div style={s.warnBox}>
              <strong>Worth a look:</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{r.anomalies.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          )}

          <div style={s.sectionTitle}>What would change</div>
          <ChangesList changes={changes} loading={changesLoading} dryRun />
        </>
      )}

      {error && <div style={s.error}>{error}</div>}

      <div style={{ ...s.row, justifyContent: 'space-between', marginTop: 18 }}>
        <button style={btn('outline')} onClick={onBack}>← Schedule</button>
        <span style={s.row}>
          {alreadyRunning && <span style={s.hint}>This version is already on.</span>}
          {!alreadyRunning && !passed && <span style={s.hint}>Available after a passing test.</span>}
          <InlineConfirm
            label={integ.status === 'ACTIVE' ? 'Turn this version on' : 'Turn it on'}
            confirmLabel="Yes, turn it on"
            kind="primary"
            small={false}
            disabled={!canTurnOn}
            consequence={confirmText}
            onConfirm={turnOn}
          />
        </span>
      </div>
    </div>
  );
}

function Tile({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value ?? 0}</div>
    </div>
  );
}
