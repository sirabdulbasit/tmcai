/**
 * DEF-354 — Step 1, Basics: what this integration is for and how careful it must be.
 * DEF-362 (Stage 1b, spec §2b) — the source is a Google Sheet OR an API. For an API the
 * admin attaches the API document (file or pasted text), and "Read with AI" drafts the
 * connection; the draft and "what the document did not say" are shown here and pre-fill
 * Connect, where every value stays editable. Both kinds get "Remarks for the AI"
 * (admin_brief) and "Filters (in your words)" (filter_instructions) — nothing filters
 * until the proposer turns those words into a filter row the admin approves.
 *
 * Sends only whitelisted IntegrationInput keys (integrationsApi.pickInput). A new
 * integration is created DRAFT by the server whatever the client sends; status, approval
 * and activation are not fields here at all (vm §9 "permissions are never accepted from
 * the client"). The document text is redacted on the server BEFORE it is stored or sent
 * to a model; nothing here ever handles a secret.
 */
import { useState } from 'react';
import {
  createIntegration, updateIntegration, uploadApiDocument, attachApiDocumentText, readApiDocument,
  errorText, DOC_MAX_BYTES, DOC_ACCEPT,
} from '../../../services/integrationsApi';
import { C, s, btn, formatPkt, stageHasMapping } from './integrationUi';

const SOURCE_CHOICES = [
  { kind: 'gsheet', label: 'Google Sheet', hint: 'A shared or private sheet of numbers.' },
  { kind: 'api', label: 'API', hint: 'A system with a REST API. Attach its API document and the AI drafts the connection.' },
];

/** The draft connection, in the order an admin reads it. */
const DRAFT_ROWS = [
  ['baseUrl', 'Base URL'],
  ['method', 'Method'],
  ['path', 'Endpoint path'],
  ['query', 'Fixed query'],
  ['authScheme', 'Sign-in'],
  ['authHeaderName', 'Key header'],
  ['authQueryParam', 'Key query parameter'],
  ['recordsPath', 'Where the records are'],
  ['idField', 'Field that identifies a record'],
  ['pagination', 'Pages'],
  ['declaredTotalPath', 'Where the total count is'],
];

const AUTH_WORDS = { NONE: 'None', BEARER: 'Bearer token', API_KEY: 'API key', BASIC: 'Username and password' };

export function draftValueText(key, v) {
  if (key === 'recordsPath' && v === '') return 'The whole answer is the list';
  if (v === undefined || v === null || v === '') return null;
  if (key === 'authScheme') return AUTH_WORDS[v] || String(v);
  if (key === 'query') {
    const entries = Object.entries(v || {});
    return entries.length ? entries.map(([k, val]) => `${k}=${val}`).join('&') : null;
  }
  if (key === 'pagination') {
    switch (v?.kind) {
      case 'none': return 'One page only';
      case 'page': return `Page numbers in “${v.pageParam}”${v.pageSizeParam ? `, size in “${v.pageSizeParam}”` : ''}${v.pageSize ? ` (${v.pageSize} a page)` : ''}`;
      case 'offset': return `Offset in “${v.offsetParam}”${v.limitParam ? `, limit in “${v.limitParam}”` : ''} (${v.pageSize} a page)`;
      case 'next_url': return `Next-page link at “${v.nextUrlPath}”`;
      default: return v?.kind ? String(v.kind) : null;
    }
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export default function StepBasics({ integ, setInteg, setMsg, setWorking, onNext }) {
  const [name, setName] = useState(integ?.name ?? '');
  const [purpose, setPurpose] = useState(integ?.purpose ?? '');
  const [sourceKind, setSourceKind] = useState(integ?.sourceKind ?? 'gsheet');
  const [adminBrief, setAdminBrief] = useState(integ?.adminBrief ?? '');
  const [filterInstructions, setFilterInstructions] = useState(integ?.filterInstructions ?? '');
  const [blankPolicy, setBlankPolicy] = useState(integ?.blankPolicy ?? 'normal');
  const [cap, setCap] = useState(String(integ?.changeCapPct ?? 25));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const capNum = Number(cap);
  const capOk = Number.isInteger(capNum) && capNum >= 1 && capNum <= 100;
  const canSave = name.trim().length > 0 && capOk && !saving;
  // The source cannot change under a mapping: every approved row names fields of THIS
  // source, so switching would leave approvals pointing at fields that do not exist.
  const kindLocked = !!integ && (integ.status !== 'DRAFT' || stageHasMapping(integ.stage));
  const isApi = sourceKind === 'api';

  function input() {
    return {
      name: name.trim(),
      purpose: purpose.trim() || null,
      adminBrief: adminBrief.trim() || null,
      filterInstructions: filterInstructions.trim() || null,
      blankPolicy,
      changeCapPct: capNum,
      ...(kindLocked ? null : { sourceKind }),
    };
  }

  const dirty = !integ
    || name.trim() !== (integ.name ?? '')
    || (purpose.trim() || null) !== (integ.purpose ?? null)
    || (adminBrief.trim() || null) !== (integ.adminBrief ?? null)
    || (filterInstructions.trim() || null) !== (integ.filterInstructions ?? null)
    || blankPolicy !== (integ.blankPolicy ?? 'normal')
    || capNum !== Number(integ.changeCapPct ?? 25)
    || (!kindLocked && sourceKind !== integ.sourceKind);

  /** Saves; returns the saved DTO or null (error shown). */
  async function persist() {
    const saved = integ ? await updateIntegration(integ.id, input()) : await createIntegration(input());
    setInteg(saved);
    return saved;
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const created = !integ;
      const saved = await persist();
      setMsg(created ? `Created “${saved?.name ?? name.trim()}”.` : 'Saved.');
      // A new API integration stays here: the document is attached to an existing
      // integration, and it is the next thing to do.
      if (created && saved?.sourceKind === 'api') return;
      // "Save and continue" always continues. Holding the admin here when no API document
      // was read (tried 10-26) read as a dead button — five successful saves, no movement.
      // Connect explains the missing document instead, with a button back to it.
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
      <p style={s.hint}>
        Name it and tell the AI what the {isApi ? 'data' : 'sheet'} is for. Nothing reads or writes anything yet.
      </p>

      <label style={s.label} htmlFor="integ-name">Name</label>
      <input id="integ-name" style={s.input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={isApi ? 'e.g. CRM customers' : 'e.g. Monthly sales sheet'} />

      <label style={s.label} htmlFor="integ-purpose">What it is for</label>
      <input id="integ-purpose" style={s.input} value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} placeholder={isApi ? 'e.g. Our customer list, so Brain knows each account' : 'e.g. Revenue and orders by region, updated by Finance each month'} />

      <label style={s.label}>Where the data comes from</label>
      <div style={{ display: 'grid', gap: 6 }}>
        {SOURCE_CHOICES.map((c) => (
          <label key={c.kind} style={{ ...s.row, cursor: kindLocked ? 'not-allowed' : 'pointer', color: 'var(--text)', fontSize: 'var(--fs-sm)', ...(kindLocked && sourceKind !== c.kind ? { opacity: 0.5 } : null) }}>
            <input
              type="radio"
              name="source-kind"
              checked={sourceKind === c.kind}
              disabled={kindLocked}
              onChange={() => setSourceKind(c.kind)}
            />
            <strong>{c.label}</strong> — {c.hint}
          </label>
        ))}
      </div>
      {kindLocked && <p style={s.hint}>The source cannot change once a mapping exists. Make a new integration for a different source.</p>}

      <label style={s.label} htmlFor="integ-brief">Remarks for the AI</label>
      <textarea
        id="integ-brief"
        style={{ ...s.input, minHeight: 80, resize: 'vertical' }}
        value={adminBrief}
        maxLength={4000}
        onChange={(e) => setAdminBrief(e.target.value)}
        placeholder={isApi
          ? 'e.g. We only need the customers endpoint. “status” 1 means active. Each customer should become a knowledge page Brain can read.'
          : 'e.g. Each row is a month. “Net revenue” is our revenue KPI; ignore the notes column.'}
      />
      <p style={s.hint}>The AI reads this when it {isApi ? 'reads the document and ' : ''}suggests the mapping. You still approve every field yourself.</p>

      <label style={s.label} htmlFor="integ-filters">Filters (in your words, optional)</label>
      <textarea
        id="integ-filters"
        style={{ ...s.input, minHeight: 56, resize: 'vertical' }}
        value={filterInstructions}
        maxLength={2000}
        onChange={(e) => setFilterInstructions(e.target.value)}
        placeholder="e.g. Only active customers, 2025 onwards."
      />
      <p style={s.hint}>
        The AI turns these words into a filter you can check, field by field, in Review. Nothing is filtered until you approve it.
      </p>

      {isApi && (
        <ApiDocument
          integ={integ}
          setInteg={setInteg}
          setMsg={setMsg}
          setWorking={setWorking}
          saveFirst={dirty && !!integ ? persist : null}
        />
      )}

      <label style={s.label}>When a value is blank</label>
      <div style={{ display: 'grid', gap: 6 }}>
        <label style={{ ...s.row, cursor: 'pointer', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
          <input type="radio" name="blank-policy" checked={blankPolicy === 'normal'} onChange={() => setBlankPolicy('normal')} />
          Normal — blanks are expected here (e.g. a month not filled in yet).
        </label>
        <label style={{ ...s.row, cursor: 'pointer', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
          <input type="radio" name="blank-policy" checked={blankPolicy === 'abnormal'} onChange={() => setBlankPolicy('abnormal')} />
          Worth reporting — a blank means something broke in the {isApi ? 'source' : 'sheet'}.
        </label>
      </div>
      <p style={s.hint}>Either way a blank never overwrites a value already in Nexeo.</p>

      <label style={s.label} htmlFor="integ-cap">Safety limit (% of what a scheduled run may change)</label>
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
        A scheduled run that would change more than this share of what it already keeps stops and writes nothing.
        The first load is never stopped. Run now is never limited.
      </p>
      {!capOk && <div style={s.error}>The safety limit is a whole number from 1 to 100.</div>}

      {error && <div style={s.error}>{error}</div>}

      <div style={{ ...s.row, justifyContent: 'flex-end', marginTop: 16 }}>
        {isApi && !integ && <span style={s.hint}>You attach the API document right after creating it.</span>}
        <button style={btn('primary', { disabled: !canSave })} disabled={!canSave} onClick={save}>
          {saving ? 'Saving…' : integ ? 'Save and continue' : isApi ? 'Create' : 'Create and continue'}
        </button>
      </div>
    </div>
  );
}

/**
 * The API document and the AI's reading of it. Upload or paste → the server extracts
 * and redacts the text → "Read with AI" → summary, draft connection, and the list of
 * what the document did not say (a guessed value is worse than an asked question —
 * vm integrationDocReader). `saveFirst` saves unsaved remarks/filter words before the
 * reading, because the reader reads them from the integration, not from this screen.
 */
function ApiDocument({ integ, setInteg, setMsg, setWorking, saveFirst }) {
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState(null);
  const [pasted, setPasted] = useState('');
  const [pastedName, setPastedName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!integ) {
    return (
      <div style={{ ...s.card, background: 'var(--bg-1)', marginTop: 14 }}>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', fontWeight: 600 }}>API document</div>
        <p style={s.hint}>Create the integration first; then attach the API document here.</p>
      </div>
    );
  }

  const reading = integ.apiDocReading;
  const tooBig = !!file && file.size > DOC_MAX_BYTES;
  const canAttach = !busy && (mode === 'file' ? !!file && !tooBig : pasted.trim().length > 0);

  /**
   * Upload, then read with the AI — one action. Owner 10-26: "i am attaching file
   * successfully, when click on Save and Continue the file missed": picking a file only
   * selected it, the upload sat behind a separate Attach button, and Save and continue
   * never sent it. Choosing a file now uploads it and starts the reading straight away.
   */
  async function attach(chosen) {
    const source = chosen ?? (mode === 'file' ? file : null);
    if (mode === 'file' && !source) return;
    if (source && source.size > DOC_MAX_BYTES) { setFile(source); return; }
    setBusy(true);
    setError('');
    let attached = false;
    try {
      // An unsaved switch to API (or unsaved remarks) is saved first: the server refuses a
      // document for an integration it still holds as a Google Sheet (DEF-362 review).
      if (saveFirst) await saveFirst();
      const res = mode === 'file'
        ? await uploadApiDocument(integ.id, source)
        : await attachApiDocumentText(integ.id, pasted, pastedName);
      if (res.integration) setInteg(res.integration);
      const d = res.document;
      setMsg(`Attached “${d?.name ?? 'the document'}”${d?.redactions ? ` — ${d.redactions} secret-looking value${d.redactions === 1 ? ' was' : 's were'} blanked out first` : ''}. The AI is reading it now.`);
      setFile(null);
      setPasted('');
      setPastedName('');
      attached = true;
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
    if (attached) await read();
  }

  async function read() {
    setBusy(true);
    setError('');
    const startedAt = new Date().toISOString();
    setWorking?.({ title: 'The AI is reading the API document', stage: 'Working out the endpoint, sign-in, where the records are and how pages work.', startedAt });
    try {
      if (saveFirst) await saveFirst();
      const res = await readApiDocument(integ.id);
      if (res.integration) setInteg(res.integration);
      else if (res.reading) setInteg({ ...integ, apiDocReading: res.reading });
      setMsg('The AI has read the document. Check its draft, then go to Connect.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking?.(null);
      setBusy(false);
    }
  }

  const draft = reading?.draft || {};
  const gaps = Array.isArray(reading?.gaps) ? reading.gaps : [];
  const draftRows = DRAFT_ROWS.map(([k, label]) => [k, label, draftValueText(k, draft[k])]).filter(([, , v]) => v !== null);

  return (
    <div style={{ ...s.card, background: 'var(--bg-1)', marginTop: 14 }}>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', fontWeight: 600 }}>API document</div>
      <p style={s.hint}>
        PDF, Word (.docx), text, Markdown or JSON (OpenAPI), up to 5 MB. Choosing a file uploads it and the AI reads it straight away.
        Anything that looks like a password, token or key is blanked out before the document is stored or shown to the AI — you type
        the real secret in Connect.
      </p>
      {integ.apiDocName && (
        <p style={{ ...s.hint, color: 'var(--text)' }}>Attached: <strong>{integ.apiDocName}</strong>{reading?.readAt ? ` · read ${formatPkt(reading.readAt)}` : ' · not read yet'}</p>
      )}

      <div style={{ ...s.row, marginTop: 8 }}>
        <button style={btn(mode === 'file' ? 'primary' : 'outline', { small: true })} onClick={() => setMode('file')}>Upload a file</button>
        <button style={btn(mode === 'paste' ? 'primary' : 'outline', { small: true })} onClick={() => setMode('paste')}>Paste text</button>
      </div>

      {mode === 'file' ? (
        <div style={{ marginTop: 8 }}>
          <input
            type="file"
            accept={DOC_ACCEPT}
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) attach(f); }}
            style={{ color: 'var(--text)', fontSize: 'var(--fs-sm)' }}
          />
          {tooBig && <div style={s.error}>That file is {(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.</div>}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <input style={{ ...s.input, maxWidth: 320 }} value={pastedName} maxLength={120} onChange={(e) => setPastedName(e.target.value)} placeholder="Name (optional), e.g. CRM API v2" />
          <textarea
            style={{ ...s.input, minHeight: 120, resize: 'vertical', marginTop: 6, ...s.mono }}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Paste the API documentation, or the OpenAPI JSON."
          />
        </div>
      )}

      <div style={{ ...s.row, marginTop: 8 }}>
        {mode === 'paste' && (
          <button style={btn('outline', { small: true, disabled: !canAttach })} disabled={!canAttach} onClick={() => attach()}>
            {busy ? 'Working…' : 'Attach and read with AI'}
          </button>
        )}
        {mode === 'file' && busy && <span style={s.hint}>Uploading and reading…</span>}
        <button style={btn('primary', { small: true, disabled: busy || !integ.apiDocName })} disabled={busy || !integ.apiDocName} onClick={read}>
          {reading ? 'Read with AI again' : 'Read with AI'}
        </button>
        {integ.apiDocName && reading && <span style={s.hint}>Replacing the document clears this reading.</span>}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {reading && (
        <div style={{ marginTop: 12 }}>
          <div style={s.sectionTitle}>What the AI understood</div>
          {reading.summary && <p style={{ ...s.hint, color: 'var(--text)' }}>{reading.summary}</p>}
          {draftRows.length > 0 ? (
            <table style={{ ...s.table, marginTop: 8 }}>
              <tbody>
                {draftRows.map(([k, label, v]) => (
                  <tr key={k}>
                    <td style={{ ...s.td, color: 'var(--text-muted)', whiteSpace: 'nowrap', width: '1%' }}>{label}</td>
                    <td style={{ ...s.td, ...s.mono, wordBreak: 'break-all' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={s.hint}>The AI could not draft a connection from this document.</p>
          )}
          {gaps.length > 0 && (
            <div style={s.warnBox}>
              <strong>What the document did not say</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{gaps.map((g, i) => <li key={i}>{String(g)}</li>)}</ul>
              <div style={{ marginTop: 4 }}>Fill these in yourself in Connect.</div>
            </div>
          )}
          {reading.redactions > 0 && (
            <p style={s.hint}>{reading.redactions} secret-looking value{reading.redactions === 1 ? ' was' : 's were'} blanked out before the AI saw the document.</p>
          )}
          <p style={{ ...s.hint, color: C.grey }}>Nothing here is used until you check it in Connect — every value is editable there.</p>
        </div>
      )}
    </div>
  );
}
