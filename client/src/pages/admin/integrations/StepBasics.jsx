/**
 * DEF-354 — Step 1, Basics: what this integration is for and how careful it must be.
 *
 * Sends only whitelisted IntegrationInput keys (integrationsApi.pickInput). A new
 * integration is created DRAFT by the server whatever the client sends; status, approval
 * and activation are not fields here at all (vm §9 "permissions are never accepted from
 * the client").
 */
import { useState } from 'react';
import { createIntegration, updateIntegration, errorText } from '../../../services/integrationsApi';
import { s, btn } from './integrationUi';

export default function StepBasics({ integ, setInteg, setMsg, onNext }) {
  const [name, setName] = useState(integ?.name ?? '');
  const [purpose, setPurpose] = useState(integ?.purpose ?? '');
  const [adminBrief, setAdminBrief] = useState(integ?.adminBrief ?? '');
  const [blankPolicy, setBlankPolicy] = useState(integ?.blankPolicy ?? 'normal');
  const [cap, setCap] = useState(String(integ?.changeCapPct ?? 25));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const capNum = Number(cap);
  const capOk = Number.isInteger(capNum) && capNum >= 1 && capNum <= 100;
  const canSave = name.trim().length > 0 && capOk && !saving;

  async function save() {
    setSaving(true);
    setError('');
    const input = {
      name: name.trim(),
      purpose: purpose.trim() || null,
      adminBrief: adminBrief.trim() || null,
      blankPolicy,
      changeCapPct: capNum,
    };
    try {
      const saved = integ
        ? await updateIntegration(integ.id, input)
        : await createIntegration({ ...input, sourceKind: 'gsheet' });
      setInteg(saved);
      setMsg(integ ? 'Saved.' : `Created “${saved?.name ?? input.name}”.`);
      onNext();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h3 style={s.h3}>Basics</h3>
      <p style={s.hint}>Name it and tell the AI what the sheet is for. Nothing reads or writes anything yet.</p>

      <label style={s.label} htmlFor="integ-name">Name</label>
      <input id="integ-name" style={s.input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly sales sheet" />

      <label style={s.label} htmlFor="integ-purpose">What it is for</label>
      <input id="integ-purpose" style={s.input} value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Revenue and orders by region, updated by Finance each month" />

      <label style={s.label} htmlFor="integ-brief">How should this be mapped?</label>
      <textarea
        id="integ-brief"
        style={{ ...s.input, minHeight: 80, resize: 'vertical' }}
        value={adminBrief}
        maxLength={4000}
        onChange={(e) => setAdminBrief(e.target.value)}
        placeholder="e.g. Each row is a month. “Net revenue” is our revenue KPI; ignore the notes column."
      />
      <p style={s.hint}>The AI reads this when it suggests the mapping. You still approve every field yourself.</p>

      <label style={s.label}>When a cell is blank</label>
      <div style={{ display: 'grid', gap: 6 }}>
        <label style={{ ...s.row, cursor: 'pointer', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
          <input type="radio" name="blank-policy" checked={blankPolicy === 'normal'} onChange={() => setBlankPolicy('normal')} />
          Normal — blanks are expected here (e.g. a month not filled in yet).
        </label>
        <label style={{ ...s.row, cursor: 'pointer', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
          <input type="radio" name="blank-policy" checked={blankPolicy === 'abnormal'} onChange={() => setBlankPolicy('abnormal')} />
          Worth reporting — a blank means something broke in the sheet.
        </label>
      </div>
      <p style={s.hint}>Either way a blank never overwrites a number already in Nexeo.</p>

      <label style={s.label} htmlFor="integ-cap">Safety limit (% of readings a scheduled run may change)</label>
      <input
        id="integ-cap"
        type="number"
        min={1}
        max={100}
        step={1}
        style={{ ...s.input, maxWidth: 120 }}
        value={cap}
        onChange={(e) => setCap(e.target.value)}
      />
      <p style={s.hint}>
        A scheduled run that would change more than this share of the numbers it already keeps stops and writes nothing.
        The first load is never stopped. Run now is never limited.
      </p>
      {!capOk && <div style={s.error}>The safety limit is a whole number from 1 to 100.</div>}

      {error && <div style={s.error}>{error}</div>}

      <div style={{ ...s.row, justifyContent: 'flex-end', marginTop: 16 }}>
        <button style={btn('primary', { disabled: !canSave })} disabled={!canSave} onClick={save}>
          {saving ? 'Saving…' : integ ? 'Save and continue' : 'Create and continue'}
        </button>
      </div>
    </div>
  );
}
