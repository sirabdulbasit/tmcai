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
 *
 * Owner 10-30: Basics looks and reads like Vision Metric's (vm IntegrationSyncTab.tsx
 * step 1, 06_INTEGRATION.md §7 Basics): one card, the name and source side by side,
 * "Why are we connecting it?", then sections in vm's order — which records, blanks,
 * the safety limit with "Run now is never limited", the brief in the admin's own words,
 * and the document box (file + paste together). Wired only to Nexeo's API.
 */
import { useState } from 'react';
import {
  createIntegration, updateIntegration, uploadApiDocument, attachApiDocumentText, readApiDocument,
  errorText, DOC_MAX_BYTES, DOC_ACCEPT,
} from '../../../services/integrationsApi';
import { C, s, vm, btn, pill, choiceCard, formatPkt, stageHasMapping } from './integrationUi';

const SOURCE_CHOICES = [
  { kind: 'gsheet', label: 'Google Sheet', hint: 'A shared or private sheet. Every run reads it as it is at that moment.' },
  { kind: 'api', label: 'API', hint: 'A system with a REST API. Attach its API document and the AI works out how to connect.' },
];

const BLANK_CHOICES = [
  ['normal', 'Yes — that’s normal here', 'Blanks just mean “nothing yet” (e.g. a month not filled in). Skipped quietly.'],
  ['abnormal', 'No — a blank means something is wrong', 'Skipped, the existing value kept, and the run reports it.'],
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
  // The paste box lives in the document box below, but its text belongs to this step:
  // the main button sends it too (vm's main button sends what is in the box). Held only
  // in ApiDocument, it was dropped when the step unmounted on "Save and continue".
  const [pasted, setPasted] = useState('');
  const [pastedName, setPastedName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const capNum = Number(cap);
  const capOk = Number.isInteger(capNum) && capNum >= 1 && capNum <= 100;
  const canSave = name.trim().length > 0 && capOk && !saving;
  // The source cannot change under a mapping: every approved row names fields of THIS
  // source, so switching would leave approvals pointing at fields that do not exist.
  const kindLocked = !!integ && (integ.status !== 'DRAFT' || stageHasMapping(integ.stage));
  const isApi = sourceKind === 'api';
  // vm's "Read the document & continue": pasted text, or an attached document nobody has
  // read yet, is read on the way to Connect, so the Connect form arrives filled in.
  const hasPaste = isApi && !!integ && pasted.trim().length > 0;
  const readOnContinue = hasPaste || (isApi && !!integ?.apiDocName && !integ?.apiDocReading);

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
      if (hasPaste && saved?.sourceKind === 'api') {
        // Pasted text is attached before anything else, so it is the document that is
        // read — never an older stored one. If attaching fails the admin stays here with
        // the text still in the box: continuing would lose it (owner 10-26, "the file missed").
        try {
          const att = await attachApiDocumentText(saved.id, pasted, pastedName);
          if (att.integration) setInteg(att.integration);
          setPasted('');
          setPastedName('');
        } catch (e) {
          setError(`${errorText(e)} — the pasted text is still in the box. Correct it, or empty the box to continue without it.`);
          return;
        }
      }
      if (readOnContinue && saved?.sourceKind === 'api') {
        setWorking?.({ title: 'The AI is reading the API document', stage: 'Working out the endpoint, sign-in, where the records are and how pages work.', startedAt: new Date().toISOString() });
        try {
          const res = await readApiDocument(saved.id);
          if (res.integration) setInteg(res.integration);
          else if (res.reading) setInteg({ ...saved, apiDocReading: res.reading });
        } catch (e) {
          // A failed reading never holds the admin here (that was the 10-26 dead button):
          // say so and continue — Connect explains the missing reading and offers the way back.
          setMsg(`The AI could not read the document (${errorText(e)}). Fill the connection by hand in Connect, or go back to Basics and press Read with AI again.`);
        } finally {
          setWorking?.(null);
        }
      }
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

  // No card of its own: the wizard already draws the one card every step sits in (vm: one card).
  return (
    <div>
      <div style={vm.grid2}>
        <div>
          <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-name">What is this system called?</label>
          <input id="integ-name" style={s.input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={isApi ? 'e.g. CRM customers' : 'e.g. Monthly sales sheet'} />
        </div>
        <div>
          <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-kind">Where does the data come from?</label>
          <select id="integ-kind" style={s.input} value={sourceKind} disabled={kindLocked} onChange={(e) => setSourceKind(e.target.value)}>
            {SOURCE_CHOICES.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}
          </select>
          <div style={s.hint}>
            {kindLocked
              ? 'The source cannot change once a mapping exists. Make a new integration for a different source.'
              : SOURCE_CHOICES.find((c) => c.kind === sourceKind)?.hint}
          </div>
        </div>
      </div>

      <label style={s.label} htmlFor="integ-purpose">Why are we connecting it?</label>
      <input id="integ-purpose" style={s.input} value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} placeholder={isApi ? 'e.g. Our customer list, so Brain knows each account' : 'e.g. Revenue and orders by region, updated by Finance each month'} />

      <h4 style={vm.section}>Which records should we read?</h4>
      <p style={vm.sectionHint}>
        Everything, unless you say otherwise here. The AI turns these words into a filter you check, field by field,
        in Review — nothing is filtered until you approve it. The brief below guides the AI's suggestions; this decides what is kept.
      </p>
      <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-filters">Filters (in your words, optional)</label>
      <textarea
        id="integ-filters"
        style={{ ...s.input, minHeight: 56, resize: 'vertical' }}
        value={filterInstructions}
        maxLength={2000}
        onChange={(e) => setFilterInstructions(e.target.value)}
        placeholder="e.g. Only active customers, 2025 onwards."
      />

      <h4 style={vm.section}>Does this system ever send blank or empty values?</h4>
      <p style={vm.sectionHint}>A blank is never written over good data either way — this decides whether the run reports it.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {BLANK_CHOICES.map(([v, t, d]) => (
          <label key={v} style={choiceCard(blankPolicy === v)}>
            <span style={vm.choiceTitle}>
              <input type="radio" name="blank-policy" checked={blankPolicy === v} style={{ marginRight: 7 }} onChange={() => setBlankPolicy(v)} />{t}
            </span>
            <span style={{ ...s.hint, display: 'block' }}>{d}</span>
          </label>
        ))}
      </div>

      <h4 style={vm.section}>Safety limit for scheduled runs</h4>
      <p style={vm.sectionHint}>
        A scheduled run happens unattended, so a sudden mass change usually means something broke at the other end.
        If one would change more than this share of what it already keeps, it is stopped before anything is written.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 14, alignItems: 'start' }}>
        <div>
          <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-cap">Stop a scheduled run above</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="integ-cap"
              type="number"
              min={1}
              max={100}
              step={1}
              style={{ ...s.input, width: 90 }}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>%</span>
          </div>
        </div>
        <div style={{ ...s.hint, marginTop: 22 }}>
          <strong>Run now is never limited.</strong> You are watching it, and a first load legitimately writes nearly
          everything — so the first load is never stopped either. This applies to the schedule, where nobody is looking.
        </div>
      </div>
      {!capOk && <div style={s.error}>The safety limit is a whole number from 1 to 100.</div>}

      <h4 style={vm.section}>In your own words: what is this system, and where should its data go?</h4>
      <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-brief">Remarks for the AI</label>
      <textarea
        id="integ-brief"
        style={{ ...s.input, minHeight: 90, resize: 'vertical' }}
        value={adminBrief}
        maxLength={4000}
        onChange={(e) => setAdminBrief(e.target.value)}
        placeholder={isApi
          ? 'e.g. We only need the customers endpoint. “status” 1 means active. Each customer should become a knowledge page Brain can read.'
          : 'e.g. Each row is a month. “Net revenue” is our revenue KPI; ignore the notes column.'}
      />
      <div style={s.hint}>Plain English is fine — this is what the AI follows when it {isApi ? 'reads the document and ' : ''}suggests the mapping. You still approve every field yourself.</div>

      {isApi ? (
        <ApiDocument
          integ={integ}
          setInteg={setInteg}
          setMsg={setMsg}
          setWorking={setWorking}
          saveFirst={dirty && !!integ ? persist : null}
          pasted={pasted}
          setPasted={setPasted}
          pastedName={pastedName}
          setPastedName={setPastedName}
        />
      ) : (
        <>
          <h4 style={vm.section}>The Google Sheet</h4>
          <p style={vm.sectionHint}>
            You paste its link in <strong>Connect</strong>; every run then reads the sheet as it is at that moment.
            A sheet shared as “Anyone with the link” needs no account. A private sheet stays private: it is read through
            your organisation’s designated Google account — the one chosen in Admin → Client Connectors.
          </p>
        </>
      )}

      {error && <div style={s.error}>{error}</div>}

      <div style={vm.footer}>
        {isApi && !integ && <span style={{ ...s.hint, marginTop: 0, flex: 1 }}>You attach the API document right after creating it.</span>}
        <button type="button" style={btn('primary', { disabled: !canSave })} disabled={!canSave} onClick={save}>
          {saving ? (readOnContinue ? 'Reading…' : 'Saving…')
            : !integ ? (isApi ? 'Create' : 'Create and continue')
              : readOnContinue ? '✨ Read the document & continue' : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}

/**
 * The API document and the AI's reading of it — vm's document box: the file chooser and
 * the paste box together ("either is fine — you can do both"). Choosing a file uploads
 * it and the AI reads it straight away; pasted text is attached with its own button.
 * The server extracts and redacts the text → summary, draft connection, and the list of
 * what the document did not say (a guessed value is worse than an asked question —
 * vm integrationDocReader). The pasted text is StepBasics' state, so the main button
 * attaches and reads it too. `saveFirst` saves unsaved remarks/filter words before the
 * reading, because the reader reads them from the integration, not from this screen.
 */
function ApiDocument({ integ, setInteg, setMsg, setWorking, saveFirst, pasted, setPasted, pastedName, setPastedName }) {
  const [tooBigFile, setTooBigFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const heading = (
    <>
      <h4 style={vm.section}>The system's API / integration document</h4>
      <p style={vm.sectionHint}>
        Attach the document you were given and the AI will work out how to connect — the web address, how to sign in,
        which endpoint to read. You don't need to know any of it. PDF, Word (.docx), text, Markdown or JSON (OpenAPI), up to 5 MB.
        Anything that looks like a password, token or key is blanked out before the document is stored or shown to the AI —
        you type the real secret in Connect.
      </p>
    </>
  );

  if (!integ) {
    return (
      <>
        {heading}
        <p style={s.hint}>Create the integration first; then attach the API document here.</p>
      </>
    );
  }

  const reading = integ.apiDocReading;
  const file = tooBigFile;
  const tooBig = !!file && file.size > DOC_MAX_BYTES;
  const canPaste = !busy && pasted.trim().length > 0;

  /**
   * Upload (or attach the pasted text), then read with the AI — one action. Owner 10-26:
   * "i am attaching file successfully, when click on Save and Continue the file missed":
   * picking a file only selected it. Choosing a file now uploads it and starts the reading.
   */
  async function attach(chosen) {
    const source = chosen ?? null;
    if (!source && !pasted.trim()) return;
    if (source && source.size > DOC_MAX_BYTES) { setTooBigFile(source); return; }
    setTooBigFile(null);
    setBusy(true);
    setError('');
    let attached = false;
    try {
      // An unsaved switch to API (or unsaved remarks) is saved first: the server refuses a
      // document for an integration it still holds as a Google Sheet (DEF-362 review).
      if (saveFirst) await saveFirst();
      const res = source
        ? await uploadApiDocument(integ.id, source)
        : await attachApiDocumentText(integ.id, pasted, pastedName);
      if (res.integration) setInteg(res.integration);
      const d = res.document;
      // DEF-367: keys the document printed are kept encrypted and tried by the Connect test.
      const keysNote = d?.keysKept ? ` The key${d.keysKept === 1 ? '' : 's'} it prints ${d.keysKept === 1 ? 'is' : 'are'} kept encrypted — Test the connection tries ${d.keysKept === 1 ? 'it' : 'them'} for you.` : '';
      setMsg(`Attached “${d?.name ?? 'the document'}”${d?.redactions ? ` — ${d.redactions} secret-looking value${d.redactions === 1 ? ' was' : 's were'} blanked out before the AI reads it` : ''}.${keysNote} The AI is reading it now.`);
      if (!source) { setPasted(''); setPastedName(''); }
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
    <>
      {heading}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          type="file"
          accept={DOC_ACCEPT}
          aria-label="Attach the API document"
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) attach(f); }}
          style={{ color: 'var(--text)', fontSize: 'var(--fs-sm)' }}
        />
        {integ.apiDocName && (
          <span style={pill(reading ? 'ok' : 'warn')}>{integ.apiDocName}{reading?.readAt ? ` · read ${formatPkt(reading.readAt)}` : ' · not read yet'}</span>
        )}
        {busy && <span style={{ ...s.hint, marginTop: 0 }}>Uploading and reading…</span>}
      </div>
      {tooBig && <div style={s.error}>That file is {(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.</div>}

      <label style={s.label} htmlFor="integ-doc">…or paste it here (either is fine — you can do both)</label>
      <textarea
        id="integ-doc"
        style={{ ...s.input, minHeight: 90, resize: 'vertical', ...s.mono }}
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder="Paste the API documentation, endpoint list or sample response — or the OpenAPI JSON."
        spellCheck={false}
      />
      <div style={{ ...s.row, marginTop: 8 }}>
        <input style={{ ...s.input, maxWidth: 280 }} value={pastedName} maxLength={120} onChange={(e) => setPastedName(e.target.value)} placeholder="Name (optional), e.g. CRM API v2" aria-label="Name of the pasted document" />
        <button type="button" style={btn('outline', { small: true, disabled: !canPaste })} disabled={!canPaste} onClick={() => attach()}>
          {busy ? 'Working…' : 'Attach and read with AI'}
        </button>
        <button type="button" style={btn('outline', { small: true, disabled: busy || !integ.apiDocName })} disabled={busy || !integ.apiDocName} onClick={read}>
          {reading ? 'Read with AI again' : 'Read with AI'}
        </button>
        {integ.apiDocName && reading && <span style={{ ...s.hint, marginTop: 0 }}>Replacing the document clears this reading.</span>}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {reading && (
        <div style={vm.notes}>
          <strong>What the AI understood.</strong> {reading.summary || ''}
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
          {reading.redactions > 0 && (
            <p style={s.hint}>{reading.redactions} secret-looking value{reading.redactions === 1 ? ' was' : 's were'} blanked out before the AI saw the document.</p>
          )}
          <p style={{ ...s.hint, color: C.grey }}>Nothing here is used until you check it in Connect — every value is editable there.</p>
        </div>
      )}
      {reading && gaps.length > 0 && (
        <div style={vm.amber}>
          <strong>What the document did not say</strong> — fill these in yourself in Connect:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{gaps.map((g, i) => <li key={i}>{String(g)}</li>)}</ul>
        </div>
      )}
    </>
  );
}
