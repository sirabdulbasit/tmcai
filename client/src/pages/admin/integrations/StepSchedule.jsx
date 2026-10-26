/**
 * DEF-354 — Step 4, Schedule: when a turned-on integration runs by itself.
 *
 * daily / weekly / monthly / once, always with a time (spec §2.5 — vm ignored the time for
 * weekly and monthly). The time is wall-clock in the integration's timezone, which is shown
 * here and defaults on the server to the creator's zone. Saving a schedule never runs
 * anything; the server computes next_run_at when the integration is turned on.
 */
import { useState } from 'react';
import { updateIntegration, errorText } from '../../../services/integrationsApi';
import { s, btn, WEEKDAYS, scheduleText, previewNextRun, formatPkt } from './integrationUi';

const FREQS = [
  { key: 'daily', label: 'Every day' },
  { key: 'weekly', label: 'Every week' },
  { key: 'monthly', label: 'Every month' },
  { key: 'once', label: 'Only when I press Run now' },
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function StepSchedule({ integ, setInteg, setMsg, onNext, onBack }) {
  const [frequency, setFrequency] = useState(integ.frequency || 'daily');
  const [runTime, setRunTime] = useState(integ.runTime || '02:00');
  const [dayOfWeek, setDayOfWeek] = useState(integ.dayOfWeek ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(integ.dayOfMonth ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const timeOk = TIME_RE.test(runTime);
  const draft = {
    frequency,
    runTime,
    dayOfWeek: frequency === 'weekly' ? Number(dayOfWeek) : null,
    dayOfMonth: frequency === 'monthly' ? Number(dayOfMonth) : null,
  };
  const preview = timeOk ? previewNextRun(draft, integ.timezone) : null;

  async function save() {
    setSaving(true);
    setError('');
    try {
      const saved = await updateIntegration(integ.id, draft);
      setInteg(saved);
      setMsg(`Schedule saved: ${scheduleText(saved || draft)}.`);
      onNext();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h3 style={s.h3}>Schedule</h3>
      <p style={s.hint}>When it runs by itself once it is turned on. Saving this runs nothing.</p>

      <label style={s.label}>How often</label>
      <div style={{ display: 'grid', gap: 6 }}>
        {FREQS.map((f) => (
          <label key={f.key} style={{ ...s.row, cursor: 'pointer', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
            <input type="radio" name="frequency" checked={frequency === f.key} onChange={() => setFrequency(f.key)} />
            {f.label}
          </label>
        ))}
      </div>

      {frequency === 'weekly' && (
        <>
          <label style={s.label} htmlFor="sched-dow">Day of the week</label>
          <select id="sched-dow" style={{ ...s.input, maxWidth: 200 }} value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </>
      )}

      {frequency === 'monthly' && (
        <>
          <label style={s.label} htmlFor="sched-dom">Day of the month</label>
          <select id="sched-dom" style={{ ...s.input, maxWidth: 200 }} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            <option value={-1}>Last day of the month</option>
          </select>
          {Number(dayOfMonth) > 28 && <p style={s.hint}>In shorter months it runs on the last day instead.</p>}
        </>
      )}

      {frequency !== 'once' && (
        <>
          <label style={s.label} htmlFor="sched-time">Time</label>
          <input id="sched-time" type="time" style={{ ...s.input, maxWidth: 160 }} value={runTime} onChange={(e) => setRunTime(e.target.value)} />
          <p style={s.hint}>Timezone: <strong>{integ.timezone || 'Asia/Karachi'}</strong>.</p>
          {!timeOk && <div style={s.error}>Pick a time (hours and minutes).</div>}
          {preview && <p style={s.hint}>Once turned on, the first run would be about {formatPkt(preview.toISOString())}.</p>}
        </>
      )}

      {error && <div style={s.error}>{error}</div>}

      <div style={{ ...s.row, justifyContent: 'space-between', marginTop: 16 }}>
        <button style={btn('outline')} onClick={onBack}>← Review the mapping</button>
        <button style={btn('primary', { disabled: saving || !timeOk })} disabled={saving || !timeOk} onClick={save}>
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}
