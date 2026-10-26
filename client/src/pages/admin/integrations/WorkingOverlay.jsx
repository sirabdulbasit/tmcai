/**
 * DEF-354 — blocking overlay while the AI proposes a mapping or a run executes.
 *
 * Port of vm AiWorkingOverlay with one correction: vm narrated runs on a TIMER even though
 * the job reported progress (vm client bug 4). Here the line under the title is whatever
 * the caller passes as `stage` — text built from the server's job/run status — and only
 * the elapsed seconds tick locally.
 *
 * It cannot be dismissed (no backdrop click, Escape ignored): the job is running on the
 * server either way, and a dismissed overlay invites a second click that starts a second
 * job. It sits above the Admin modal layer (z-index 200).
 */
import { useEffect, useState } from 'react';

export default function WorkingOverlay({ open, title, stage, startedAt }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const swallowEsc = (e) => { if (e.key === 'Escape') e.stopPropagation(); };
    window.addEventListener('keydown', swallowEsc, true);
    return () => {
      clearInterval(t);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', swallowEsc, true);
    };
  }, [open]);

  if (!open) return null;
  const start = startedAt ? new Date(startedAt).getTime() : now;
  const elapsed = Math.max(0, Math.floor((now - start) / 1000));

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="polite"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div style={{
        background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '24px 28px', width: '100%', maxWidth: 440, textAlign: 'center',
      }}>
        <div style={{
          width: 34, height: 34, margin: '0 auto 14px', borderRadius: '50%',
          border: '3px solid var(--border)', borderTopColor: '#cc6b4a',
          animation: 'integSpin 0.9s linear infinite',
        }} />
        <style>{'@keyframes integSpin { to { transform: rotate(360deg); } }'}</style>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
        {stage && <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>{stage}</div>}
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {elapsed}s elapsed
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          This keeps going on the server if you leave the page.
        </div>
      </div>
    </div>
  );
}

/** Server-status → overlay line, for a proposal job (ProposalJobStatus). */
export function proposalStageText(job) {
  if (!job) return 'Sending the request…';
  if (job.stage) return job.stage;
  if (job.state === 'running') return 'The AI is reading every field of the data, with your remarks, and matching it to KPIs, knowledge and filters.';
  if (job.state === 'done') return 'Saving the new mapping version…';
  return job.error || '';
}

/** Server-status → overlay line, for a run (RunStatusView). */
export function runStageText(run, dryRun) {
  if (!run) return 'Starting the run…';
  if (run.stage) return run.stage;
  if (run.status === 'RUNNING') {
    return dryRun
      ? 'Reading the source and working out what would change. Nothing is written.'
      : 'Reading the source and writing what you approved.';
  }
  return 'Finishing…';
}
