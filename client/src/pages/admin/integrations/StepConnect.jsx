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
 *   - API: the secret is typed here and sent ONCE to its own write-only call (by its own
 *     button, or first thing when the admin presses Test with a secret typed); it is never
 *     put in the form, the config or the DTO, and is never shown again. The server tests
 *     a new secret first and keeps a working one over a failing one.
 *   - The instructions box is not part of the connection: saving it never clears a test.
 *
 * Owner 10-30: Connect looks and reads like Vision Metric's (vm IntegrationSyncTab.tsx
 * step 2, 06_INTEGRATION.md §7 Connect): one card headed "Connection" with a "filled
 * from …" pill, the AI's notes, the fields in vm order (web address, sign-in, endpoint,
 * records/identity), then the test panel under a divider — the verdict, the first
 * record as read — "What your document didn't say", the token box, the
 * "How should this be mapped?" box, and Back · ✨ Suggest the mapping.
 */
import { useMemo, useState } from 'react';
import {
  updateIntegration, checkConnection, proposeAndWait, setIntegrationSecret, errorText,
} from '../../../services/integrationsApi';
import { proposalStageText } from './WorkingOverlay';
import { C, s, vm, btn, pill, formatPkt, stageHasMapping, OneRecord } from './integrationUi';
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
  // The token box sits below the test (vm's order), so the typed secret is held HERE: the
  // test sends it first, instead of silently testing the old stored one (vm's test uses
  // the draft it saves). Never pre-filled, never echoed, cleared from memory once sent.
  const [secret, setSecret] = useState('');
  const [secretOutcome, setSecretOutcome] = useState(null); // {ok, text}

  const built = useMemo(() => (isApi ? configFromForm(form) : null), [isApi, form]);
  const dirty = isApi
    ? isConfigDirty(form, integ?.apiConfig)
    : link.trim() !== savedLink || tabLabel.trim() !== savedTab;
  const instrDirty = instructions.trim() !== savedInstr.trim();
  const tested = !!integ?.connectionOk && !dirty;
  const hasMapping = stageHasMapping(integ?.stage);
  const canTest = !busy && (isApi ? !!built?.config : !!link.trim());
  const secretTyped = isApi && needsSecret(form.authScheme) && secret.length > 0;

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

  /**
   * Sends the typed secret to its own write-only call. The connection is saved first
   * (when edited) because the server tests the candidate secret against the SAVED
   * connection before it stores anything. Resolves true when it was stored.
   */
  async function submitSecret({ fromTest = false } = {}) {
    setSecretOutcome(null);
    const candidate = secret;
    setSecret('');
    try {
      if (dirty) await saveConnection();
      const res = await setIntegrationSecret(integ.id, candidate);
      if (res.integration) setInteg(res.integration);
      if (res.stored) {
        setResult(null); // a new credential is a new connection; the shown result is stale
        // A new credential is a new connection: the server clears the earlier pass, so the
        // mapping unlocks only after the test (unless the server re-recorded it).
        const unlock = fromTest || res.integration?.connectionOk ? '' : ' Press Test the connection to unlock the mapping.';
        setSecretOutcome({ ok: true, text: `${res.verified ? 'Stored — the API answered with it.' : 'Stored.'}${unlock}` });
        setMsg('Secret stored.');
        return true;
      }
      const why = res.reason || 'The API did not accept it.';
      setSecretOutcome({
        ok: false,
        text: `Not stored. ${why}${integ.hasSecret ? ' The secret stored before is kept.' : ''}`,
      });
      return false;
    } catch (e) {
      setSecretOutcome({ ok: false, text: `Not stored. ${errorText(e)}` });
      return false;
    }
  }

  async function saveSecretOnly() {
    setBusy(true);
    try { await submitSecret(); } finally { setBusy(false); }
  }

  async function test() {
    setBusy(true);
    setError('');
    try {
      if (secretTyped) {
        // The typed secret is what the admin means to test; it is stored first (it saves
        // an edited connection itself). A refused one stops here: testing the old secret
        // instead would answer a question nobody asked.
        const stored = await submitSecret({ fromTest: true });
        if (!stored) {
          setError('The test was not run: the secret you typed was not stored (see under the secret box). Correct it and test again.');
          return;
        }
      } else if (dirty) await saveConnection();
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

  const reading = integ?.apiDocReading;
  const gaps = isApi && Array.isArray(reading?.gaps) ? reading.gaps : [];

  // No card of its own: the wizard already draws the one card every step sits in (vm: one card).
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <strong style={{ flex: 1, color: 'var(--text)' }}>Connection</strong>
        {isApi && reading && integ?.apiDocName && <span style={pill('acc')}>filled from {integ.apiDocName}</span>}
        {!isApi && <span style={pill('acc')}>Google Sheet</span>}
      </div>
      <p style={{ ...s.hint, marginTop: 0 }}>
        {isApi
          ? (reading
            ? 'Filled in from your document where it said enough. Correct anything that is wrong, then test it — a document can be out of date or describe a different deployment.'
            : 'Fill in the connection, then test it. Attaching the API document in Basics and pressing Read with AI fills most of this for you.')
          : 'Paste the link to the Google Sheet tab that holds the data, then test it — the test reads the sheet for real.'}
      </p>

      {/* DEF-362 (owner 10-26, "it stuck here"): Basics' "Save and continue" skips past the
          API document panel, so an admin landed here with an empty form and no idea the AI
          could fill it. Say so where they are, with the way back. */}
      {isApi && !integ?.apiDocReading && !integ?.apiConfig?.baseUrl && (
        <div style={{ ...vm.amber, marginTop: 10 }}>
          <div style={{ fontWeight: 600 }}>
            {integ?.apiDocName ? 'The API document is attached but not read yet.' : 'No API document has been attached yet.'}
          </div>
          <div style={{ marginTop: 4 }}>
            Go back to Basics, {integ?.apiDocName ? '' : 'attach the API document under “The system’s API / integration document”, then '}press <strong>Read with AI</strong> — it fills in this form for you. Or fill the fields below by hand.
          </div>
          {onBackToBasics && (
            <button type="button" style={{ ...btn('primary', { small: true }), marginTop: 8 }} onClick={onBackToBasics}>
              {integ?.apiDocName ? 'Back to Basics to read it' : 'Back to Basics to attach it'}
            </button>
          )}
        </div>
      )}

      {isApi && reading?.summary && <div style={vm.notes}>{reading.summary}</div>}

      {isApi ? (
        <ApiConnectionForm
          form={form}
          setField={setField}
          hasReading={!!reading}
          resetToDraft={() => { setForm(formFromConfig(integ.apiDocReading?.draft ?? null)); setResult(null); }}
          errors={built?.errors ?? []}
        />
      ) : (
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <div>
            <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-link">Google Sheet link</label>
            <input
              id="integ-link"
              style={{ ...s.input, ...s.mono }}
              value={link}
              onChange={(e) => { setLink(e.target.value); setResult(null); }}
              placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0"
            />
            <div style={s.hint}>Open the tab you want, then copy the link from the address bar — it names the tab, so the right one is read.</div>
          </div>
          <div>
            <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-tab">Tab name (optional, for your own reference)</label>
            <input id="integ-tab" style={{ ...s.input, maxWidth: 320 }} value={tabLabel} maxLength={120} onChange={(e) => { setTabLabel(e.target.value); setResult(null); }} />
          </div>
          <div style={vm.notes}>
            <strong>Who can read the sheet.</strong> A public sheet must be shared as <strong>“Anyone with the link”</strong> (Viewer is enough).
            A private sheet stays private: it is read through your organisation’s designated Google account — the one chosen in Admin → Client Connectors.
            If no account is designated, or it has no access to this sheet, the test below says so.
          </div>
        </div>
      )}

      {/* The verdict, and the ONLY thing on this screen that says whether the connection
          works (vm: fixed copy asserting success stayed green against a dead host). */}
      <div style={vm.divider}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" style={btn(tested || result?.ok ? 'outline' : 'primary', { disabled: !canTest })} disabled={!canTest} onClick={test}>
            {busy ? (isApi ? 'Calling the API…' : 'Reading the sheet…') : 'Test the connection'}
          </button>
          <span style={{ ...s.hint, marginTop: 0 }}>
            {dirty && (isApi ? !!integ?.apiConfig : !!savedLink)
              ? <span style={{ color: C.warn }}>The {isApi ? 'connection' : 'link'} changed — test it again before the mapping.</span>
              : result || tested ? 'Re-test after any change above.' : 'Nothing has been called yet.'}
          </span>
        </div>

        {error && <div style={s.error}>{error}</div>}

        {result && result.ok && (
          <div style={vm.ok}>
            <strong>Working.</strong>{' '}
            {isApi
              ? pageCountText(result)
              : `Read ${result.rows} ${result.rows === 1 ? 'row' : 'rows'}, ${result.columns.length} ${result.columns.length === 1 ? 'column' : 'columns'}.`}
            {result.sampleRow && (
              <div style={{ marginTop: 10, color: 'var(--text)' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {isApi ? 'The first record, as we read it' : 'The first data row, as we read it'}
                </div>
                <OneRecord record={result.sampleRow} columns={result.columns} />
                {isApi && <div style={{ ...s.hint, marginTop: 4 }}>Nested fields are shown with dots.</div>}
              </div>
            )}
          </div>
        )}
        {result && !result.ok && (
          <div style={vm.bad}><strong>Not working.</strong> {result.reason || (isApi ? 'The API could not be read.' : 'The sheet could not be read.')}</div>
        )}
        {!result && tested && (
          <div style={vm.ok}><strong>Working</strong> — last tested {formatPkt(integ.connectionTestedAt)}.</div>
        )}
      </div>

      {gaps.length > 0 && (
        <div style={vm.amber}>
          {/* Observations about the DOCUMENT. They say nothing about whether the
              connection works — the test above answers that. */}
          <strong>What your document didn't say</strong> — fill these in above if they are still blank:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{gaps.map((g, i) => <li key={i}>{String(g)}</li>)}</ul>
        </div>
      )}

      {isApi && needsSecret(form.authScheme) && (
        <SecretField
          integ={integ}
          authScheme={form.authScheme}
          secret={secret}
          setSecret={setSecret}
          outcome={secretOutcome}
          busy={busy}
          canSave={!(built?.errors ?? []).length}
          onSave={saveSecretOnly}
        />
      )}

      {/* How it should be mapped, asked where the mapping is asked for (vm). */}
      <div style={{ ...vm.divider, marginTop: 18 }}>
        <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-connect-instr">How should this data be mapped? Tell the AI in your own words</label>
        <textarea
          id="integ-connect-instr"
          style={{ ...s.input, minHeight: 84, resize: 'vertical' }}
          value={instructions}
          maxLength={4000}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={isApi
            ? 'e.g. Each record is a customer: make one knowledge page per customer titled by “name”. “total_spend” is a KPI by month.'
            : 'e.g. “Net revenue” is revenue; the Region column is the breakdown.'}
        />
        <div style={s.hint}>
          Plain English is fine — the AI follows this, with your remarks and filter words on{' '}
          {onBackToBasics
            ? <button type="button" style={{ ...btn('outline', { small: true }), border: 0, padding: '0 2px', textDecoration: 'underline' }} onClick={onBackToBasics}>Basics</button>
            : 'Basics'}
          , when it suggests the mapping. Say what each field means and what to leave alone. Saving it does not touch the connection test.
        </div>
        {instrDirty && (
          <div style={{ ...s.row, marginTop: 6 }}>
            <button
              type="button"
              style={btn('outline', { small: true, disabled: busy })}
              disabled={busy}
              onClick={async () => {
                try { await saveInstructions(); setMsg('Instructions saved.'); } catch (e) { setError(errorText(e)); }
              }}
            >Save the instructions</button>
            <span style={{ ...s.hint, marginTop: 0 }}>Also saved when you test or suggest the mapping.</span>
          </div>
        )}
      </div>

      {/* Proposing reads every record from this connection, so it waits for a real read. */}
      <div style={vm.footer}>
        {!tested && (
          <span style={{ ...s.hint, marginTop: 0, flex: 1 }}>Test the connection first — the mapping is built from records read through it.</span>
        )}
        {hasMapping && tested && (
          <span style={{ ...s.hint, marginTop: 0, flex: 1 }}>A new suggestion keeps every field you already approved.</span>
        )}
        {onBackToBasics && <button type="button" style={btn('outline')} onClick={onBackToBasics}>Back</button>}
        <button type="button" style={btn('primary', { disabled: !tested || busy })} disabled={!tested || busy} onClick={suggest}>
          {hasMapping ? '✨ Suggest the mapping again' : '✨ Suggest the mapping'}
        </button>
      </div>
    </div>
  );
}

/**
 * The API connection, every value editable, in vm's order: web address, how we sign in,
 * the endpoint we will read, where the records are / how one is identified, then pages.
 * The AI's draft only pre-fills it; "Use the AI's draft again" refills it on request.
 */
function ApiConnectionForm({ form, setField, hasReading, resetToDraft, errors }) {
  const f = form;
  const input = (k, props = {}) => (
    <input
      id={`c-${k}`}
      style={{ ...s.input, ...(props.mono ? s.mono : null), ...(props.maxWidth ? { maxWidth: props.maxWidth } : null) }}
      value={f[k]}
      onChange={(e) => setField(k, e.target.value)}
      placeholder={props.placeholder}
      inputMode={props.numeric ? 'numeric' : undefined}
      autoComplete="off"
      spellCheck={false}
    />
  );
  const field = (label, el, hint, k) => (
    <div>
      <label style={{ ...s.label, marginTop: 0 }} htmlFor={k ? `c-${k}` : undefined}>{label}</label>
      {el}
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  );
  const grid = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' };

  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      {hasReading && (
        <div><button type="button" style={btn('outline', { small: true })} onClick={resetToDraft}>Use the AI’s draft again</button></div>
      )}

      {field('Web address', input('baseUrl', { mono: true, placeholder: 'https://api.example.com/v2' }),
        'The host Nexeo calls — https only. Requests, redirects and next pages never leave this address.', 'baseUrl')}

      <div style={grid}>
        {field('How we sign in', (
          <select id="c-authScheme" style={s.input} value={f.authScheme} onChange={(e) => setField('authScheme', e.target.value)}>
            {AUTH_SCHEMES.map((a) => <option key={a} value={a}>{AUTH_LABELS[a]}</option>)}
          </select>
        ), null, 'authScheme')}
        {f.authScheme === 'API_KEY' && field('Key header name', input('authHeaderName', { mono: true, placeholder: 'X-API-Key' }), 'Used unless a query parameter is named.', 'authHeaderName')}
        {f.authScheme === 'API_KEY' && field('…or key query parameter', input('authQueryParam', { mono: true, placeholder: 'api_key' }), 'Set this only if the key goes in the URL.', 'authQueryParam')}
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr) 120px' }}>
        {field('Endpoint we will read', input('path', { mono: true, placeholder: '/customers' }), null, 'path')}
        {field('Method', (
          <select id="c-method" style={s.input} value={f.method} onChange={(e) => setField('method', e.target.value)}>
            {API_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ), null, 'method')}
      </div>
      {field('Fixed query (one name=value per line)', (
        <textarea id="c-query" style={{ ...s.input, ...s.mono, minHeight: 48, resize: 'vertical' }} value={f.query} onChange={(e) => setField('query', e.target.value)} placeholder={'status=active\nfields=id,name'} spellCheck={false} />
      ), 'Include any query the endpoint requires — many return an error without one. POST only for search endpoints that take a JSON body.', 'query')}
      {f.method === 'POST' && field('Request body (JSON object)', (
        <textarea id="c-body" style={{ ...s.input, ...s.mono, minHeight: 64, resize: 'vertical' }} value={f.body} onChange={(e) => setField('body', e.target.value)} placeholder={'{ "filter": {} }'} spellCheck={false} />
      ), null, 'body')}

      <div style={grid}>
        {field('Where the records are', input('recordsPath', { mono: true, placeholder: 'data.items' }), 'Field holding the list of records. Blank means the whole answer is the list.', 'recordsPath')}
        {field('How a record is identified', input('idField', { mono: true, placeholder: 'id' }), 'Keeps each knowledge page tied to its record.', 'idField')}
        {field('Where the total count is (optional)', input('declaredTotalPath', { mono: true, placeholder: 'meta.total' }), 'Lets a run notice when it read fewer records than the API says exist.', 'declaredTotalPath')}
      </div>

      <div style={grid}>
        {field('How pages work', (
          <select id="c-pageKind" style={s.input} value={f.pageKind} onChange={(e) => setField('pageKind', e.target.value)}>
            {PAGINATION_KINDS.map((k) => <option key={k} value={k}>{PAGE_LABELS[k]}</option>)}
          </select>
        ), null, 'pageKind')}
        {f.pageKind === 'page' && field('Page-number parameter', input('pageParam', { mono: true, placeholder: 'page' }), null, 'pageParam')}
        {f.pageKind === 'page' && field('Page-size parameter (optional)', input('pageSizeParam', { mono: true, placeholder: 'per_page' }), null, 'pageSizeParam')}
        {f.pageKind === 'page' && field('First page (optional)', input('startPage', { numeric: true, placeholder: '1' }), null, 'startPage')}
        {f.pageKind === 'offset' && field('Offset parameter', input('offsetParam', { mono: true, placeholder: 'offset' }), null, 'offsetParam')}
        {f.pageKind === 'offset' && field('Limit parameter (optional)', input('limitParam', { mono: true, placeholder: 'limit' }), null, 'limitParam')}
        {f.pageKind === 'next_url' && field('Where the next-page link is', input('nextUrlPath', { mono: true, placeholder: 'links.next' }), 'A link to another address ends the read as a failure.', 'nextUrlPath')}
        {(f.pageKind === 'page' || f.pageKind === 'offset') && field('Page size', input('pageSize', { numeric: true, placeholder: '100' }), null, 'pageSize')}
        {f.pageKind !== 'none' && field('Max pages (optional)', input('maxPages', { numeric: true, placeholder: '50' }), 'Can only lower the system-wide limit, never raise it.', 'maxPages')}
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
 * Write-only secret box. Never pre-filled, never echoed; the value and the call that sends
 * it (submitSecret) live in StepConnect, so "Test the connection" above sends what is typed
 * here first. "Save the secret" sends it on its own.
 */
function SecretField({ integ, authScheme, secret, setSecret, outcome, busy, canSave, onSave }) {
  const canSend = !busy && secret.length > 0 && canSave;
  return (
    <div style={{ marginTop: 14 }}>
      <label style={{ ...s.label, marginTop: 0 }} htmlFor="integ-secret">
        {authScheme === 'BASIC' ? 'Username and password — paste it here as username:password' : authScheme === 'BEARER' ? 'Token — paste it here' : 'API key — paste it here'}
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
        <button style={btn('primary', { small: true, disabled: !canSend })} disabled={!canSend} onClick={onSave}>
          {busy ? 'Checking…' : integ?.hasSecret ? 'Replace the secret' : 'Save the secret'}
        </button>
      </div>
      <p style={s.hint}>Stored encrypted, never shown again. It is sent only to the web address above, and only kept if the API accepts it.</p>
      <p style={s.hint}>Test the connection above uses what you type here: it is stored first, then the test runs with it.</p>
      {integ?.hasSecret && <p style={{ ...s.hint, color: C.ok }}>A secret is stored.</p>}
      {outcome && <div style={outcome.ok ? s.success : s.error}>{outcome.text}</div>}
    </div>
  );
}
