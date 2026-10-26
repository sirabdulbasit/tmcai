/**
 * DEF-354 — the five-step wizard: Basics · Connect · Review the mapping · Schedule · Test & turn on.
 *
 * The step bar is clickable up to max(stage.step, current step): `stage` is derived on the
 * server from facts (connection tested for THIS config, a version exists, ≥1 approved row,
 * a passing test), so a step the facts do not support cannot be jumped to, and nothing here
 * stores "where the admin was" (vm P:313).
 *
 * The wizard owns the one overlay and the ON-SCREEN mapping version: Review shows it and
 * Test & turn on dry-runs and activates exactly it — a test proves what you are looking at
 * (spec §2.5), never "whatever is latest by the time you click".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getIntegration, errorText } from '../../../services/integrationsApi';
import WorkingOverlay from './WorkingOverlay';
import StepBasics from './StepBasics';
import StepConnect from './StepConnect';
import StepReview from './StepReview';
import StepSchedule from './StepSchedule';
import StepTestTurnOn from './StepTestTurnOn';
import { C, s, btn } from './integrationUi';

const STEPS = [
  { step: 1, label: 'Basics' },
  { step: 2, label: 'Connect' },
  { step: 3, label: 'Review the mapping' },
  { step: 4, label: 'Schedule' },
  { step: 5, label: 'Test & turn on' },
];

export default function IntegrationWizard({ integrationId, initialStep = 1, setMsg, onClose }) {
  const [integ, setInteg] = useState(null);
  const [loading, setLoading] = useState(!!integrationId);
  const [step, setStep] = useState(Math.min(Math.max(Number(initialStep) || 1, 1), 5));
  const [versionId, setVersionId] = useState(null);
  const [working, setWorking] = useState(null); // {title, stage, startedAt}
  // Shared with every step's pollJob: unmounting the wizard stops watching (the job
  // itself carries on on the server).
  const signal = useRef({ cancelled: false });

  useEffect(() => {
    // Re-arm on (re)mount: StrictMode mounts, unmounts and mounts again in dev, and a
    // signal left cancelled by the first unmount would stop every later poll at once.
    const sig = signal.current;
    sig.cancelled = false;
    return () => { sig.cancelled = true; };
  }, []);

  const refresh = useCallback(async (id = integ?.id ?? integrationId) => {
    if (!id) return null;
    try {
      const fresh = await getIntegration(id);
      setInteg(fresh);
      return fresh;
    } catch (e) {
      setMsg(`Failed to load the integration: ${errorText(e)}`);
      return null;
    }
  }, [integ?.id, integrationId, setMsg]);

  useEffect(() => {
    if (!integrationId) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getIntegration(integrationId);
        if (!cancelled) setInteg(fresh);
      } catch (e) {
        if (!cancelled) setMsg(`Failed to load the integration: ${errorText(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [integrationId, setMsg]);

  const maxReachable = Math.max(integ?.stage?.step ?? 1, step);
  const go = (n) => setStep(Math.min(Math.max(n, 1), 5));

  const stepProps = {
    integ,
    setInteg,
    refresh,
    setMsg,
    signal: signal.current,
    setWorking,
    versionId,
    setVersionId,
    onNext: () => go(step + 1),
    onBack: () => go(step - 1),
  };

  return (
    <div>
      <WorkingOverlay open={!!working} title={working?.title} stage={working?.stage} startedAt={working?.startedAt} />
      <div style={{ ...s.row, justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={s.h2}>{integ?.name || 'New integration'}</h2>
          {integ?.status && integ.status !== 'DRAFT' && (
            <p style={s.hint}>{integ.status === 'ACTIVE' ? 'Working — changes you make here do not affect the running mapping until you turn the new version on.' : 'Paused.'}</p>
          )}
        </div>
        <button style={btn('outline', { small: true })} onClick={onClose}>← Back to integrations</button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {STEPS.map((st) => {
          const reachable = st.step <= maxReachable && (st.step === 1 || !!integ);
          const active = st.step === step;
          const done = (integ?.stage?.step ?? 1) > st.step;
          return (
            <button
              key={st.step}
              disabled={!reachable}
              onClick={() => reachable && go(st.step)}
              style={{
                ...s.btn,
                flex: '1 1 140px',
                textAlign: 'left',
                padding: '8px 12px',
                background: active ? C.accent + '22' : 'var(--bg-2)',
                border: `1px solid ${active ? C.accent : 'var(--border)'}`,
                color: active ? C.accent : reachable ? 'var(--text)' : 'var(--text-muted)',
                ...(reachable ? null : s.disabled),
              }}
            >
              <span style={{ fontSize: 11, color: done ? C.ok : 'var(--text-muted)', display: 'block' }}>
                {done ? '✓ ' : ''}Step {st.step}
              </span>
              {st.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div style={s.hint}>Loading…</div>
      ) : (
        <div style={s.card}>
          {step === 1 && <StepBasics {...stepProps} />}
          {step === 2 && integ && <StepConnect {...stepProps} onProposed={(vid) => { setVersionId(vid); go(3); }} />}
          {step === 3 && integ && <StepReview {...stepProps} />}
          {step === 4 && integ && <StepSchedule {...stepProps} />}
          {step === 5 && integ && <StepTestTurnOn {...stepProps} onDone={onClose} />}
        </div>
      )}
    </div>
  );
}
