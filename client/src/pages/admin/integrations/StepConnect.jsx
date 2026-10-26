/**
 * DEF-354 — Step 2, Connect: paste the Google Sheet link and prove it can be read.
 *
 * Spec §2.2 rules this screen enforces on its side (the server enforces them too):
 *   - the test reads the sheet FOR REAL, and a sheet that answers with 0 rows is not OK;
 *   - "Suggest the mapping" stays disabled until a test of the CURRENT link passed —
 *     `integ.connectionOk` is the server's "tested AND fingerprint matches", and any
 *     unsaved edit to the link disables it locally too;
 *   - the link is parsed on the server into sheet id + tab id; the export URL is rebuilt
 *     from those alone, so what is pasted here can never send the server anywhere else.
 */
import { useState } from 'react';
import { updateIntegration, checkConnection, proposeAndWait, errorText } from '../../../services/integrationsApi';
import { proposalStageText } from './WorkingOverlay';
import { C, s, btn, formatPkt, stageHasMapping } from './integrationUi';

export default function StepConnect({ integ, setInteg, setMsg, signal, setWorking, onProposed }) {
  const savedLink = integ?.sourceConfig?.link ?? '';
  const savedTab = integ?.sourceConfig?.tabLabel ?? '';
  const [link, setLink] = useState(savedLink);
  const [tabLabel, setTabLabel] = useState(savedTab);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // TestResult of the test run on this screen
  const [error, setError] = useState('');

  const dirty = link.trim() !== savedLink || tabLabel.trim() !== savedTab;
  const tested = !!integ?.connectionOk && !dirty;
  const hasMapping = stageHasMapping(integ?.stage);

  async function saveLink() {
    const saved = await updateIntegration(integ.id, { link: link.trim(), tabLabel: tabLabel.trim() || null });
    setInteg(saved);
    // Saving a changed link clears the earlier pass on the server; clear it here too so a
    // green panel from the OLD sheet is never shown next to the new link.
    setResult(null);
    return saved;
  }

  async function test() {
    setBusy(true);
    setError('');
    try {
      if (dirty) await saveLink();
      const { result: r, integration } = await checkConnection(integ.id);
      setResult(r);
      if (integration) setInteg(integration);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function suggest() {
    const startedAt = new Date().toISOString();
    setWorking({ title: 'The AI is suggesting the mapping', stage: proposalStageText(null), startedAt });
    try {
      const res = await proposeAndWait(integ.id, null, {
        signal,
        onTick: (job) => setWorking({ title: 'The AI is suggesting the mapping', stage: proposalStageText(job), startedAt }),
      });
      setMsg(`Mapping version ${res?.mappingVersion ?? ''} is ready to review.`);
      onProposed(res?.versionId ?? null);
    } catch (e) {
      setMsg(`Failed to suggest the mapping: ${errorText(e)}`);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      <h3 style={s.h3}>Connect</h3>
      <p style={s.hint}>Paste the link to the Google Sheet tab that holds the numbers.</p>

      <label style={s.label} htmlFor="integ-link">Google Sheet link</label>
      <input
        id="integ-link"
        style={s.input}
        value={link}
        onChange={(e) => { setLink(e.target.value); setResult(null); }}
        placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0"
      />
      <p style={s.hint}>Open the tab you want, then copy the link from the address bar — it names the tab, so the right one is read.</p>

      <label style={s.label} htmlFor="integ-tab">Tab name (optional, for your own reference)</label>
      <input id="integ-tab" style={{ ...s.input, maxWidth: 320 }} value={tabLabel} maxLength={120} onChange={(e) => { setTabLabel(e.target.value); setResult(null); }} />

      <div style={{ ...s.card, background: 'var(--bg-1)', marginTop: 14 }}>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', fontWeight: 600 }}>Who can read the sheet</div>
        <p style={s.hint}>
          A public sheet must be shared as <strong>“Anyone with the link”</strong> (Viewer is enough).
          A private sheet is read through your organisation’s designated Google account — the one chosen in Admin → Client Connectors.
          If no account is designated, or it has no access to this sheet, the test below says so.
        </p>
      </div>

      <div style={{ ...s.row, marginTop: 14 }}>
        <button style={btn('primary', { disabled: busy || !link.trim() })} disabled={busy || !link.trim()} onClick={test}>
          {busy ? 'Reading the sheet…' : 'Test the connection'}
        </button>
        {dirty && savedLink && <span style={{ fontSize: 12, color: C.warn }}>The link changed — test it again before the mapping.</span>}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {result && result.ok && (
        <div style={s.success}>
          Read {result.rows} {result.rows === 1 ? 'row' : 'rows'}, {result.columns.length} {result.columns.length === 1 ? 'column' : 'columns'}.
          {result.sampleRow && (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={s.table}>
                <thead>
                  <tr>{result.columns.map((c) => <th key={c} style={s.th}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  <tr>{result.columns.map((c) => <td key={c} style={s.td}>{result.sampleRow[c] ?? ''}</td>)}</tr>
                </tbody>
              </table>
              <div style={{ ...s.hint, marginTop: 4 }}>First data row, as read.</div>
            </div>
          )}
        </div>
      )}
      {result && !result.ok && (
        <div style={s.error}>Not working. {result.reason || 'The sheet could not be read.'}</div>
      )}
      {!result && tested && (
        <div style={s.success}>Working — last tested {formatPkt(integ.connectionTestedAt)}.</div>
      )}

      <div style={{ ...s.row, justifyContent: 'flex-end', marginTop: 16 }}>
        <button style={btn('primary', { disabled: !tested || busy })} disabled={!tested || busy} onClick={suggest}>
          {hasMapping ? 'Suggest the mapping again' : 'Suggest the mapping'}
        </button>
      </div>
      {!tested && <p style={{ ...s.hint, textAlign: 'right' }}>Available once the connection test has passed.</p>}
      {hasMapping && tested && <p style={{ ...s.hint, textAlign: 'right' }}>A new suggestion keeps every field you already approved.</p>}
    </div>
  );
}
