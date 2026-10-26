/**
 * DEF-354 — Step 2, Connect: paste the Google Sheet link and prove it can be read.
 * DEF-362 (Stage 1b, spec §2b) — or, for an API: the connection form pre-filled from the
 * AI's reading of the document, a write-only secret, and the same "Test the connection".
 * Both kinds then show EXACTLY ONE record (field → value) and the "How should this data
 * be mapped?" box (connect_instructions), which the proposer reads.
 *
 * Rules this screen enforces on its side (the server enforces them too):
 *   - the test reads the source FOR REAL, and an answer with 0 rows/records is not OK;
 *   - "Suggest the mapping" stays disabled until a test of the CURRENT connection passed —
 *     `integ.connectionOk` is the server's "tested AND fingerprint matches", and any
 *     unsaved edit to the link / connection disables it locally too (editing any
 *     connection field clears the test — spec §2b);
 *   - Google Sheet: the link is parsed on the server into sheet id + tab id; the export
 *     URL is rebuilt from those alone, so what is pasted here can never send the server
 *     anywhere else;
 *   - API: the secret is typed here and sent ONCE to its own write-only call; it is never
 *     put in the form, the config or the DTO, and is never shown again. The server tests
 *     a new secret first and keeps a working one over a failing one.
 *   - The instructions box is not part of the connection: saving it never clears a test.
 */
import { useMemo, useState } from 'react';
import {
  updateIntegration, checkConnection, proposeAndWait, setIntegrationSecret, errorText,
} from '../../../services/integrationsApi';
import { proposalStageText } from './WorkingOverlay';
import { C, s, btn, formatPkt, stageHasMapping, OneRecord } from './integrationUi';
import {
  AUTH_SCHEMES, API_METHODS, PAGINATION_KINDS, initialForm, formFromConfig, configFromForm, isConfigDirty,
  needsSecret, pageCountText,
} from './integrationLogic';

const AUTH_LABELS = { NONE: 'None', BEARER: 'Bearer token', API_KEY: 'API key', BASIC: 'Username and password' };
const PAGE_LABELS = { none: 'One page only', page: 'Page numbers', offset: 'Offset and limit', next_url: 'Next-page link in the answer' };

export default function StepConnect({ integ, setInteg, setMsg, signal, setWorking, onProposed, onBackToBasics }) {
  const isApi = integ?.sourceKind === 'api';
  const savedLink = integ?.sourceConfig?.link ?? '';
  const savedTab = integ?.sourceConfig?.tabLabel ?? '';
  const savedInstr = integ?.connectInstructions ?? '';
  const [link, setLink] = useState(savedLink);
  const [tabLabel, setTabLabel] = useState(savedTab);
  const [form, setForm] = useState(() => initialForm(integ));
  const [instructions, setInstructions] = useState(savedInstr);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // TestResult of the test run on this screen
  const [error, setError] = useState('');

  const built = useMemo(() => (isApi ? configFromForm(form) : null), [isApi, form]);
  const dirty = isApi
    ? isConfigDirty(form, integ?.apiConfig)
    : link.trim() !== savedLink || tabLabel.trim() !== savedTab;
  const instrDirty = instructions.trim() !== savedInstr.trim();
  const tested = !!integ?.connectionOk && !dirty;
  const hasMapping = stageHasMapping(integ?.stage);
  const canTest = !busy && (isApi ? !!built?.config : !!link.trim());

  function setField(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    // A green panel from the OLD connection is never shown next to an edited one.
    setResult(null);
  }

  /** Saves the connection (and the instructions with it, so one PUT carries the draft). */
  async function saveConnection() {
    const patch = isApi
      ? { apiConfig: built.config }
      : { link: link.trim(), tabLabel: tabLabel.trim() || null };
    if (instrDirty) patch.connectInstructions = instructions.trim() || null;
    const saved = await updateIntegration(integ.id, patch);
    setInteg(saved);
    // Saving a changed connection clears the earlier pass on the server; clear it here too.
    setResult(null);
    return saved;
  }

  async function saveInstructions() {
    if (!instrDirty) return integ;
    const saved = await updateIntegration(integ.id, { connectInstructions: instructions.trim() || null });
    setInteg(saved);
    return saved;
  }

  async function test() {
    setBusy(true);
    setError('');
    try {
      if (dirty) await saveConnection();
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
      // The proposer reads the instructions from the integration, so they are saved first.
      await saveInstructions();
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
      {/* DEF-362 (owner 10-26, "it stuck here"): Basics' "Save and continue" skips past the
          API document panel, so an admin landed here with an empty form and no idea the AI
          could fill it. Say so where they are, with the way back. */}
      {isApi && !integ?.apiDocReading && !integ?.apiConfig?.baseUrl && (
        <div style={{ ...s.card, borderColor: 'var(--accent, #cc6b4a)', marginBottom: 14 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>
            {integ?.apiDocName ? 'The API document is attached but not read yet.' : 'No API document has been attached yet.'}
          </div>
          <p style={s.hint}>
            Go back to Basics, {integ?.apiDocName ? '' : 'attach the API document under “API document”, then '}press <strong>Read with AI</strong> — it fills in this form for you. Or fill the fields below by hand.
          </p>
          {onBackToBasics && (
            <button style={btn('primary', { small: true })} onClick={onBackToBasics}>
              {integ?.apiDocName ? 'Back to Basics to read it' : 'Back to Basics to attach it'}
            </button>
          )}
        </div>
      )}
      {isApi ? (
        <ApiConnectionForm
          integ={integ}
          form={form}
          setField={setField}
          resetToDraft={() => { setForm(formFromConfig(integ.apiDocReading?.draft ?? null)); setResult(null); }}
          errors={built?.errors ?? []}
          dirty={dirty}
          saveConnection={saveConnection}
          setInteg={setInteg}
          setMsg={setMsg}
          setResult={setResult}
        />
      ) : (
        <>
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
        </>
      )}

      <div style={{ ...s.row, marginTop: 14 }}>
        <button style={btn('primary', { disabled: !canTest })} disabled={!canTest} onClick={test}>
          {busy ? (isApi ? 'Calling the API…' : 'Reading the sheet…') : 'Test the connection'}
        </button>
        {dirty && (isApi ? !!integ?.apiConfig : !!savedLink) && (
          <span style={{ fontSize: 12, color: C.warn }}>
            The {isApi ? 'connection' : 'link'} changed — test it again before the mapping.
          </span>
        )}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {result && result.ok && (
        <div style={s.success}>
          {isApi
            ? pageCountText(result)
            : `Read ${result.rows} ${result.rows === 1 ? 'row' : 'rows'}, ${result.columns.length} ${result.columns.length === 1 ? 'column' : 'columns'}.`}
          {result.sampleRow && (
            <>
              <OneRecord record={result.sampleRow} columns={result.columns} />
              <div style={{ ...s.hint, marginTop: 4 }}>{isApi ? 'One record, as read (nested fields shown with dots).' : 'First data row, as read.'}</div>
            </>
          )}
        </div>
      )}
      {result && !result.ok && (
        <div style={s.error}>Not working. {result.reason || (isApi ? 'The API could not be read.' : 'The sheet could not be read.')}</div>
      )}
      {!result && tested && (
        <div style={s.success}>Working — last tested {formatPkt(integ.connectionTestedAt)}.</div>
      )}

      <label style={s.label} htmlFor="integ-connect-instr">How should this data be mapped?</label>
      <textarea
        id="integ-connect-instr"
        style={{ ...s.input, minHeight: 64, resize: 'vertical' }}
        value={instructions}
        maxLength={4000}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder={isApi
          ? 'e.g. Each record is a customer: make one knowledge page per customer titled by “name”. “total_spend” is a KPI by month.'
          : 'e.g. “Net revenue” is revenue; the Region column is the breakdown.'}
      />
      <p style={s.hint}>
        The AI follows this, with your remarks and filter words, when it suggests the mapping. Saving it does not touch the connection test.
      </p>
      {instrDirty && (
        <div style={{ ...s.row, marginTop: 6 }}>
          <button
            style={btn('outline', { small: true, disabled: busy })}
            disabled={busy}
            onClick={async () => {
              try { await saveInstructions(); setMsg('Instructions saved.'); } catch (e) { setError(errorText(e)); }
            }}
          >Save the instructions</button>
          <span style={s.hint}>Also saved when you test or suggest the mapping.</span>
        </div>
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

/**
 * The API connection, every value editable. The AI's draft only pre-fills it; "Use the
 * AI's draft again" refills it on request, never by itself.
 */
function ApiConnectionForm({ integ, form, setField, resetToDraft, errors, dirty, saveConnection, setInteg, setMsg, setResult }) {
  const reading = integ?.apiDocReading;
  const gaps = Array.isArray(reading?.gaps) ? reading.gaps : [];
  const f = form;
  const input = (k, props = {}) => (
    <input
      style={{ ...s.input, ...(props.mono ? s.mono : null), ...(props.maxWidth ? { maxWidth: props.maxWidth } : null) }}
      value={f[k]}
      onChange={(e) => setField(k, e.target.value)}
      placeholder={props.placeholder}
      inputMode={props.numeric ? 'numeric' : undefined}
      autoComplete="off"
      spellCheck={false}
    />
  );
  const field = (label, el, hint) => (
    <div>
      <label style={s.label}>{label}</label>
      {el}
      {hint && <div style={{ ...s.hint, fontSize: 11 }}>{hint}</div>}
    </div>
  );
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 };

  return (
    <div>
      <p style={s.hint}>
        {reading
          ? 'Pre-filled from the AI’s reading of the API document. Check every value — you can change any of them.'
          : 'Fill in the connection. Attaching the API document in Basics and pressing Read with AI fills most of this for you.'}
      </p>
      {gaps.length > 0 && (
        <div style={s.warnBox}>
          <strong>The document did not say:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{gaps.map((g, i) => <li key={i}>{String(g)}</li>)}</ul>
        </div>
      )}
      {reading && (
        <div style={{ marginTop: 8 }}>
          <button style={btn('outline', { small: true })} onClick={resetToDraft}>Use the AI’s draft again</button>
        </div>
      )}

      <div style={grid}>
        {field('Base URL', input('baseUrl', { mono: true, placeholder: 'https://api.example.com/v2' }), 'https only. Requests, redirects and next pages never leave this address.')}
        {field('Endpoint path', input('path', { mono: true, placeholder: '/customers' }))}
        {field('Method', (
          <select style={s.input} value={f.method} onChange={(e) => setField('method', e.target.value)}>
            {API_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ), 'POST only for search endpoints that take a JSON body.')}
      </div>

      {field('Fixed query (one name=value per line)', (
        <textarea style={{ ...s.input, ...s.mono, minHeight: 48, resize: 'vertical' }} value={f.query} onChange={(e) => setField('query', e.target.value)} placeholder={'status=active\nfields=id,name'} spellCheck={false} />
      ))}
      {f.method === 'POST' && field('Request body (JSON object)', (
        <textarea style={{ ...s.input, ...s.mono, minHeight: 64, resize: 'vertical' }} value={f.body} onChange={(e) => setField('body', e.target.value)} placeholder={'{ "filter": {} }'} spellCheck={false} />
      ))}

      <div style={s.sectionTitle}>Sign-in</div>
      <div style={grid}>
        {field('How the API is signed in to', (
          <select style={s.input} value={f.authScheme} onChange={(e) => setField('authScheme', e.target.value)}>
            {AUTH_SCHEMES.map((a) => <option key={a} value={a}>{AUTH_LABELS[a]}</option>)}
          </select>
        ))}
        {f.authScheme === 'API_KEY' && field('Key header name', input('authHeaderName', { mono: true, placeholder: 'X-API-Key' }), 'Used unless a query parameter is named.')}
        {f.authScheme === 'API_KEY' && field('…or key query parameter', input('authQueryParam', { mono: true, placeholder: 'api_key' }), 'Set this only if the key goes in the URL.')}
      </div>
      {needsSecret(f.authScheme) && (
        <SecretField
          integ={integ}
          authScheme={f.authScheme}
          dirty={dirty}
          canSave={!errors.length}
          saveConnection={saveConnection}
          setInteg={setInteg}
          setMsg={setMsg}
          setResult={setResult}
        />
      )}

      <div style={s.sectionTitle}>The records</div>
      <div style={grid}>
        {field('Where the records are in the answer', input('recordsPath', { mono: true, placeholder: 'data.items' }), 'Dotted path to the list. Empty = the whole answer is the list.')}
        {field('Field that identifies a record', input('idField', { mono: true, placeholder: 'id' }), 'Keeps each knowledge page tied to its record.')}
        {field('Where the total count is (optional)', input('declaredTotalPath', { mono: true, placeholder: 'meta.total' }), 'Lets a run notice when it read fewer records than the API says exist.')}
      </div>

      <div style={s.sectionTitle}>Pages</div>
      <div style={grid}>
        {field('How pages work', (
          <select style={s.input} value={f.pageKind} onChange={(e) => setField('pageKind', e.target.value)}>
            {PAGINATION_KINDS.map((k) => <option key={k} value={k}>{PAGE_LABELS[k]}</option>)}
          </select>
        ))}
        {f.pageKind === 'page' && field('Page-number parameter', input('pageParam', { mono: true, placeholder: 'page' }))}
        {f.pageKind === 'page' && field('Page-size parameter (optional)', input('pageSizeParam', { mono: true, placeholder: 'per_page' }))}
        {f.pageKind === 'page' && field('First page (optional)', input('startPage', { numeric: true, placeholder: '1' }))}
        {f.pageKind === 'offset' && field('Offset parameter', input('offsetParam', { mono: true, placeholder: 'offset' }))}
        {f.pageKind === 'offset' && field('Limit parameter (optional)', input('limitParam', { mono: true, placeholder: 'limit' }))}
        {f.pageKind === 'next_url' && field('Where the next-page link is', input('nextUrlPath', { mono: true, placeholder: 'links.next' }), 'A link to another address ends the read as a failure.')}
        {(f.pageKind === 'page' || f.pageKind === 'offset') && field('Page size', input('pageSize', { numeric: true, placeholder: '100' }))}
        {f.pageKind !== 'none' && field('Max pages (optional)', input('maxPages', { numeric: true, placeholder: '50' }), 'Can only lower the system-wide limit, never raise it.')}
      </div>

      {errors.length > 0 && (
        <div style={s.warnBox}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/**
 * Write-only secret. Never pre-filled, never echoed, cleared from memory once sent.
 * The connection is saved first (when edited) because the server tests the candidate
 * secret against the SAVED connection before it stores anything.
 */
function SecretField({ integ, authScheme, dirty, canSave, saveConnection, setInteg, setMsg, setResult }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // {ok, text}

  async function save() {
    setBusy(true);
    setOutcome(null);
    const candidate = secret;
    setSecret('');
    try {
      if (dirty) await saveConnection();
      const res = await setIntegrationSecret(integ.id, candidate);
      if (res.integration) setInteg(res.integration);
      if (res.stored) {
        setResult(null); // a new credential is a new connection; the shown result is stale
        // A new credential is a new connection: the server clears the earlier pass, so the
        // mapping unlocks only after the test below (unless the server re-recorded it).
        const unlock = res.integration?.connectionOk ? '' : ' Press Test the connection to unlock the mapping.';
        setOutcome({ ok: true, text: `${res.verified ? 'Stored — the API answered with it.' : 'Stored.'}${unlock}` });
        setMsg('Secret stored.');
      } else {
        const why = res.reason || 'The API did not accept it.';
        setOutcome({
          ok: false,
          text: `Not stored. ${why}${integ.hasSecret ? ' The secret stored before is kept.' : ''}`,
        });
      }
    } catch (e) {
      setOutcome({ ok: false, text: `Not stored. ${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const canSend = !busy && secret.length > 0 && canSave;
  return (
    <div style={{ ...s.card, background: 'var(--bg-1)', marginTop: 10 }}>
      <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-secret">
        {authScheme === 'BASIC' ? 'Username and password (as username:password)' : authScheme === 'BEARER' ? 'Token' : 'API key'}
      </label>
      <div style={s.row}>
        <input
          id="integ-secret"
          type="password"
          style={{ ...s.input, maxWidth: 420 }}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={integ?.hasSecret ? 'Type a new one to replace it' : ''}
        />
        <button style={btn('primary', { small: true, disabled: !canSend })} disabled={!canSend} onClick={save}>
          {busy ? 'Checking…' : integ?.hasSecret ? 'Replace the secret' : 'Save the secret'}
        </button>
      </div>
      <p style={s.hint}>Stored encrypted, never shown again. It is sent only to the base URL above.</p>
      {integ?.hasSecret && <p style={{ ...s.hint, color: C.ok }}>A secret is stored.</p>}
      {outcome && <div style={outcome.ok ? s.success : s.error}>{outcome.text}</div>}
    </div>
  );
}
