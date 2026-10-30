/**
 * DEF-354 — Admin → Integrations (spec §2.7).
 *
 * The list of the tenant's integrations, grouped Working · Paused · Being set up, each group
 * headed "{label} · {count}" and hidden when empty. A draft's place in "Being set up" comes
 * from `stage` — derived on the server from facts (vm P:313), never a stored pointer — and
 * drafts are ordered furthest step first, so the one nearest to done is on top.
 *
 * The tenant is never chosen here: every call is scoped by the server from the session
 * (spec §2.6). Deletes and Run now confirm inline, never with window.confirm.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listIntegrations, deleteIntegration, pauseIntegration, activateIntegration, runAndWait, errorText,
} from '../../../services/integrationsApi';
import IntegrationWizard from './IntegrationWizard';
import RunHistory from './RunHistory';
import WorkingOverlay, { runStageText } from './WorkingOverlay';
import { C, s, btn, Pill, InlineConfirm, formatPkt, scheduleText, runResult, openStepFor } from './integrationUi';

const LAST_RUN_LABEL = {
  RUNNING: { text: 'Running…', color: C.info },
  SUCCESS: { text: 'Succeeded', color: C.ok },
  PARTIAL: { text: 'Part of the sheet unread', color: C.warn },
  FAILED: { text: 'Failed', color: C.bad },
  ABORTED: { text: 'Stopped by the safety limit', color: C.warn },
};

export default function IntegrationsTab({ setMsg }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  // view: {mode:'list'} | {mode:'wizard', id, step} | {mode:'history', id}
  const [view, setView] = useState({ mode: 'list' });
  const [working, setWorking] = useState(null); // {title, stage, startedAt}
  const pollSignal = useRef({ cancelled: false });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setList(await listIntegrations());
    } catch (e) {
      setMsg(`Failed to load integrations: ${errorText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [setMsg]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const sig = pollSignal.current;
    sig.cancelled = false; // re-arm after a StrictMode remount
    return () => { sig.cancelled = true; };
  }, []);

  const groups = useMemo(() => {
    const working = list.filter((i) => i.status === 'ACTIVE');
    const paused = list.filter((i) => i.status === 'PAUSED');
    const drafts = list
      .filter((i) => i.status !== 'ACTIVE' && i.status !== 'PAUSED')
      .sort((a, b) => (b.stage?.step ?? 1) - (a.stage?.step ?? 1)
        || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return [
      { key: 'working', label: 'Working', items: working },
      { key: 'paused', label: 'Paused', items: paused },
      { key: 'setup', label: 'Being set up', items: drafts },
    ].filter((g) => g.items.length > 0);
  }, [list]);

  async function runNow(integ) {
    const startedAt = new Date().toISOString();
    setWorking({ title: `Running “${integ.name}”`, stage: runStageText(null, false), startedAt });
    try {
      const run = await runAndWait(integ.id, { dryRun: false }, {
        signal: pollSignal.current,
        onTick: (r) => setWorking({ title: `Running “${integ.name}”`, stage: runStageText(r, false), startedAt }),
      });
      const res = runResult(run);
      const failed = run.status === 'FAILED' || run.status === 'ABORTED';
      setMsg(`${failed ? 'Run failed' : 'Run finished'}: ${res.text}${run.error ? ` — ${run.error}` : ''}`);
    } catch (e) {
      setMsg(`Run failed to start: ${errorText(e)}`);
    } finally {
      setWorking(null);
      reload();
    }
  }

  async function pauseOrResume(integ) {
    try {
      if (integ.status === 'ACTIVE') {
        await pauseIntegration(integ.id);
        setMsg(`Paused “${integ.name}”. No scheduled run will start until you resume it.`);
      } else {
        // Resume is a re-activation of the approved version: the server re-checks that the
        // tested connection is still the current one (spec §2.5) and never runs anything.
        const updated = await activateIntegration(integ.id, integ.approvedVersionId);
        setMsg(`Resumed “${integ.name}”. Next run: ${formatPkt(updated?.nextRunAt)}.`);
      }
    } catch (e) {
      const reasons = e?.response?.data?.reasons;
      setMsg(`Failed: ${Array.isArray(reasons) && reasons.length ? reasons.join('; ') : errorText(e)}`);
    } finally {
      reload();
    }
  }

  async function remove(integ) {
    try {
      await deleteIntegration(integ.id);
      setMsg(`Deleted “${integ.name}”. The KPI numbers it wrote are kept.`);
    } catch (e) {
      setMsg(`Delete failed: ${errorText(e)}`);
    } finally {
      reload();
    }
  }

  if (view.mode === 'wizard') {
    return (
      <IntegrationWizard
        integrationId={view.id}
        initialStep={view.step}
        setMsg={setMsg}
        onClose={() => { setView({ mode: 'list' }); reload(); }}
      />
    );
  }
  if (view.mode === 'history') {
    const integ = list.find((i) => i.id === view.id);
    return (
      <RunHistory
        integrationId={view.id}
        integrationName={integ?.name}
        setMsg={setMsg}
        onBack={() => { setView({ mode: 'list' }); reload(); }}
      />
    );
  }

  return (
    <div>
      <WorkingOverlay open={!!working} title={working?.title} stage={working?.stage} startedAt={working?.startedAt} />
      <div style={{ ...s.row, justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={s.h2}>Integrations</h2>
          <p style={s.hint}>Connect a Google Sheet, an API or an uploaded Excel / CSV file once; Nexeo keeps Brain’s KPI numbers and knowledge current from it, writing only what you approved.</p>
        </div>
        <button style={btn('primary')} onClick={() => setView({ mode: 'wizard', id: null, step: 1 })}>+ New integration</button>
      </div>

      {loading && list.length === 0 && <div style={s.hint}>Loading…</div>}
      {!loading && list.length === 0 && (
        <div style={s.card}>
          <div style={s.h3}>No integrations yet</div>
          <p style={s.hint}>Start with “New integration”: name it, paste a Google Sheet link, attach an API document or upload an Excel / CSV file, review the mapping the AI suggests, pick a schedule, test it and turn it on.</p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key}>
          <div style={s.sectionTitle}>{g.label} · {g.items.length}</div>
          {g.items.map((integ) => (
            <IntegrationRow
              key={integ.id}
              integ={integ}
              busy={!!working}
              onOpen={() => setView({ mode: 'wizard', id: integ.id, step: openStepFor(integ.stage) })}
              onHistory={() => setView({ mode: 'history', id: integ.id })}
              onRunNow={() => runNow(integ)}
              onPauseResume={() => pauseOrResume(integ)}
              onDelete={() => remove(integ)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function IntegrationRow({ integ, busy, onOpen, onHistory, onRunNow, onPauseResume, onDelete }) {
  const last = integ.lastRunStatus ? LAST_RUN_LABEL[integ.lastRunStatus] : null;
  const stage = integ.stage;
  const stageColor = integ.status === 'ACTIVE' ? C.ok : integ.status === 'PAUSED' ? C.warn : C.accent;
  const canRun = !!integ.approvedVersionId;
  return (
    <div style={{ ...s.card, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ ...s.row, gap: 8 }}>
          <strong style={{ color: 'var(--text)' }}>{integ.name}</strong>
          {stage && <Pill color={stageColor} title={`Step ${stage.step} of 5`}>{stage.label}</Pill>}
        </div>
        {integ.purpose && <div style={s.hint}>{integ.purpose}</div>}
        <div style={{ ...s.hint, marginTop: 6 }}>
          {scheduleText(integ)}
          {integ.status === 'ACTIVE' && integ.frequency !== 'once' && <> · Next run {formatPkt(integ.nextRunAt)}</>}
        </div>
        <div style={{ ...s.hint, marginTop: 2 }}>
          Last run:{' '}
          {last ? <><Pill color={last.color}>{last.text}</Pill> {formatPkt(integ.lastRunAt)}</> : 'never'}
        </div>
      </div>
      <div style={{ ...s.row, justifyContent: 'flex-end' }}>
        <button style={btn('outline', { small: true })} onClick={onOpen}>Open</button>
        <button style={btn('outline', { small: true })} onClick={onHistory}>History</button>
        {canRun && (
          <InlineConfirm
            label="Run now"
            confirmLabel="Run it now"
            kind="primary"
            disabled={busy}
            consequence="Reads the source now and writes what you approved. The safety limit does not apply to Run now."
            onConfirm={onRunNow}
          />
        )}
        {(integ.status === 'ACTIVE' || (integ.status === 'PAUSED' && canRun)) && (
          <button style={btn('outline', { small: true, disabled: busy })} disabled={busy} onClick={onPauseResume}>
            {integ.status === 'ACTIVE' ? 'Pause' : 'Resume'}
          </button>
        )}
        <InlineConfirm
          label="Delete"
          confirmLabel="Delete it"
          kind="danger"
          disabled={busy}
          consequence="Removes this integration, its mappings and its run history. KPI numbers it already wrote stay."
          onConfirm={onDelete}
        />
      </div>
    </div>
  );
}
