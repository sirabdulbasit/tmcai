/**
 * DEF-362 — Integrations Stage 1b: the API document, read by the AI.
 *
 * Spec INTEGRATIONS_DESIGN.md §2b (Basics, "AI reads the document"). Ported
 * from vm integrationDocReader.ts (prompt rules, placeholder rejection,
 * credential-named query params, redaction patterns) with ONE deliberate
 * difference: vm sent the RAW document to the model so it could lift the
 * token out of it. Here the model never sees, chooses or stores a secret —
 * the text is redacted BEFORE it is stored and before any prompt, the admin
 * types the credential into its own write-only field (secretStore), and every
 * value the model drafts is re-checked so a credential that slipped through
 * cannot ride into api_config.
 *
 *  - extractDocText: PDF (pdf-parse v2), DOCX (mammoth), TXT / MD / JSON /
 *    YAML as UTF-8. Over integrations.doc_max_bytes or another type ⇒
 *    IntegrationInputError, never a partial read.
 *  - redactSecrets: bearer/basic tokens, Authorization headers, JWTs, vendor
 *    key formats, key/token/secret/password = value pairs, long high-entropy
 *    strings ⇒ '[redacted]', counted.
 *  - readApiDocument: callLLM (purpose 'integration_doc_read') with the
 *    redacted text + the admin's remarks + filter words; strict JSON ending in
 *    "complete": true (callLLM reports no finish reason, so the sentinel is the
 *    only truncation guard — same contract as the mapping proposer). The draft
 *    is whitelisted field by field; what the document did not say comes back
 *    as `gaps`, shown to the admin verbatim (a guessed value is worse than an
 *    asked question).
 *
 * Design time only — the run engine never imports this module.
 */
import { Prisma } from '@prisma/client';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { callLLM } from '../../llmRouter';
import { getBehaviorValue } from '../../behaviorConfig';
import { readPagination } from './apiReader';
import {
  API_METHODS,
  AUTH_SCHEMES,
  IntegrationInputError,
  IntegrationNotFoundError,
  type ApiConfig,
  type ApiDocReading,
  type DocReaderModule,
} from '../types';

const log = createLogger('integrations-docreader');

export const DOC_READ_PURPOSE = 'integration_doc_read';
/** A document read takes longer than the router's 15 s default. */
export const DOC_READ_TIMEOUT_MS = 120_000;
/** Pro then Claude, never Flash: the draft must not silently change model. */
export const DOC_READ_PROVIDERS = ['gemini', 'claude'] as const;
/** ~50k tokens. A longer document is read from the start and the cut is
 *  named in `gaps`, never silent. */
export const DOC_PROMPT_MAX_CHARS = 200_000;
const MAX_GAPS = 30;
const MAX_GAP_CHARS = 400;
const MAX_SUMMARY_CHARS = 2000;
const MAX_NAME_CHARS = 255;

/** A reading that could not be produced, in admin words. `code` maps to a 400
 *  in the route's error table (same as the proposer's ProposalError). */
export class DocReadError extends Error {
  readonly code = 'INTEGRATION_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'DocReadError';
  }
}

// ── Text extraction ───────────────────────────────────────────────────────

type DocKind = 'pdf' | 'docx' | 'text';

function kindOf(filename: string, mime: string): DocKind | null {
  const name = (filename || '').toLowerCase();
  const mt = (mime || '').toLowerCase();
  if (name.endsWith('.pdf') || mt === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || mt.includes('wordprocessingml')) return 'docx';
  if (/\.(txt|md|markdown|json|ya?ml)$/.test(name)) return 'text';
  if (mt.startsWith('text/') || mt === 'application/json' || mt.includes('yaml')) return 'text';
  return null;
}

/** One plain-text form: LF line ends, no control characters, ≤ 2 blank lines. */
function normaliseText(t: string): string {
  return t
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const mb = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

/** DEF-362 review (decompression bomb): the byte cap above is on the COMPRESSED
 *  upload. A 4.9 MB .docx can declare GBs of XML, and mammoth / pdf.js inflate
 *  everything into this shared process (the box has lost services to OOM —
 *  DEF-360). Three bounds, each refusing rather than reading part-way:
 *   - DOCX: the zip's own declared uncompressed sizes, summed from the central
 *     directory BEFORE mammoth runs;
 *   - PDF: only the first DOC_MAX_PDF_PAGES pages are parsed;
 *   - any kind: the extracted text may not exceed DOC_MAX_TEXT_CHARS (that is
 *     also what is stored in api_doc_text). */
export const DOC_MAX_UNZIPPED_BYTES = 60 * 1024 * 1024;
export const DOC_MAX_PDF_PAGES = 400;
export const DOC_MAX_TEXT_CHARS = 2_000_000;

/**
 * Sum of the uncompressed sizes a zip's central directory declares, or null
 * when the archive cannot be walked (no end record, truncated directory, or a
 * ZIP64 marker — a ZIP64 API document is not plausible, so it is refused, not
 * trusted). Pure; exported for tests.
 */
export function declaredUnzippedBytes(buf: Buffer): number | null {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  // The end record is the last 22 bytes plus at most a 65,535-byte comment.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) return null;
  let p = cdOffset;
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return null;
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) return null;
    total += size;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}

/**
 * Plain text of the attached document. The optional `cn` makes the size cap
 * the tenant's (behavior integrations.doc_max_bytes); the contract signature
 * has none, so without it the global value applies.
 */
export const extractDocText = async (buf: Buffer, filename: string, mime: string, cn?: string): Promise<string> => {
  const max = await getBehaviorValue('integrations.doc_max_bytes', cn ? { clientNumber: cn } : {});
  if (buf.length > max) {
    throw new IntegrationInputError(`The document is ${mb(buf.length)}; the limit is ${mb(max)}. Attach the part that describes the endpoints.`, 'apiDoc');
  }
  const kind = kindOf(filename, mime);
  if (!kind) {
    throw new IntegrationInputError('That file type cannot be read. Attach a PDF, Word (.docx), text, Markdown, JSON or YAML file, or paste the text.', 'apiDoc');
  }
  let text: string;
  try {
    if (kind === 'pdf') {
      // pdf-parse v2: class API (same use as knowledge/attachmentExtractorService).
      const { PDFParse } = (await import('pdf-parse')) as unknown as {
        PDFParse: new (o: { data: Buffer | Uint8Array }) => { getText(p?: { first?: number }): Promise<{ text?: string }>; destroy?(): Promise<void> };
      };
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        // Bounded page count (decompression bomb, see DOC_MAX_PDF_PAGES).
        text = String((await parser.getText({ first: DOC_MAX_PDF_PAGES })).text ?? '');
      } finally {
        await parser.destroy?.().catch(() => {});
      }
    } else if (kind === 'docx') {
      const unzipped = declaredUnzippedBytes(buf);
      if (unzipped === null || unzipped > DOC_MAX_UNZIPPED_BYTES) {
        throw new IntegrationInputError('That Word document expands to far more than an API document could need, or its archive is malformed. Paste the part that describes the endpoints instead.', 'apiDoc');
      }
      const mammoth = await import('mammoth');
      text = String((await mammoth.extractRawText({ buffer: buf })).value ?? '');
    } else {
      // A NUL byte means it is not text, whatever its name says.
      if (buf.includes(0)) throw new IntegrationInputError('That file is not plain text. Attach a PDF, Word, text or JSON file.', 'apiDoc');
      text = new TextDecoder('utf-8').decode(buf);
    }
  } catch (err) {
    if (err instanceof IntegrationInputError) throw err;
    log.warn('api document extraction failed', { kind, filename, error: err instanceof Error ? err.message : String(err) });
    throw new IntegrationInputError(`The ${kind === 'pdf' ? 'PDF' : kind === 'docx' ? 'Word document' : 'file'} could not be read — it may be damaged or password-protected. Try another copy, or paste the text.`, 'apiDoc');
  }
  if (text.length > DOC_MAX_TEXT_CHARS) {
    throw new IntegrationInputError(`The document holds more than ${DOC_MAX_TEXT_CHARS.toLocaleString('en-US')} characters of text. Attach the part that describes the endpoints.`, 'apiDoc');
  }
  const out = normaliseText(text);
  if (!out) {
    throw new IntegrationInputError('No text was found in the document (a scanned PDF has no text layer). Paste the text instead.', 'apiDoc');
  }
  return out;
};

// ── Redaction ─────────────────────────────────────────────────────────────

const R = '[redacted]';

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Values a document shows in a key/value pair that are NOT a credential: a
 *  schema type, a placeholder or an obviously-fake marker. Redacting them would
 *  only make the document harder to read; the parameter NAME is what matters. */
const NOT_A_VALUE = /^(?:string|integer|number|boolean|object|array|true|false|null|none|required|optional|header|query|body|path|bearer|basic|apikey|api_key|oauth2?|http|https|<[^>]*>|\{[^}]*\}|\$\{[^}]*\}|x{3,}|\*{3,}|\.{3,}|your[-_ ]?\w*|example\w*|\[redacted\])$/i;

/**
 * Credential-looking strings ⇒ '[redacted]', BEFORE the text is stored or sent
 * to a model (spec §2b). Errs toward redacting: a lost example value costs the
 * reader nothing (the field NAME stays), a leaked key costs the tenant a
 * rotation. Idempotent: '[redacted]' never matches again.
 */
export const redactSecrets: DocReaderModule['redactSecrets'] = (input) => {
  let n = 0;
  let t = String(input ?? '');
  const sub = (re: RegExp, fn: (...m: string[]) => string) => {
    t = t.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2) as string[]; // drop offset + whole string
      const out = fn(...m);
      if (out !== m[0]) n++;
      return out;
    });
  };

  // 1. "Authorization: [scheme] <value to end of line>" — the value goes, the
  //    scheme word stays (the reader needs to know it is Bearer / Basic).
  sub(/\b(authorization\s*["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|apikey|api-key|digest)\s+)?([^\r\n"']+)/gi,
    (all, head, scheme, val) => {
      const v = (val ?? '').trim();
      if (!v || v.startsWith(R) || NOT_A_VALUE.test(v)) return all;
      return `${head}${scheme ? `${scheme} ` : ''}${R}`;
    });
  // 2. Bearer / Basic tokens wherever they appear.
  sub(/\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, (all, scheme, sp, tok) =>
    (NOT_A_VALUE.test(tok) ? all : `${scheme}${sp}${R}`));
  // 3. JWTs, labelled or not.
  sub(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => R);
  // 4. Vendor key formats that can appear with no label at all.
  sub(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, () => R);
  sub(/\bsk-[A-Za-z0-9_-]{16,}\b/g, () => R);
  sub(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, () => R);
  sub(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, () => R);
  sub(/\bglpat-[A-Za-z0-9_-]{16,}\b/g, () => R);
  sub(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, () => R);
  sub(/\bAIza[0-9A-Za-z_-]{35}\b/g, () => R);
  sub(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => R);
  // 5. name = value / "name": "value" where the name says credential. The
  //    name pattern is loose on purpose ("X-ESS-Key", "client_secret",
  //    "apiToken", "password") — vm redactSecretsForPrompt.
  sub(
    /((?:^|[^A-Za-z0-9])["']?[A-Za-z0-9_-]*(?:api[_-]?key|apikey|access[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|credential|auth[_-]?key|private[_-]?key|client[_-]?secret|signature)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(["']?)([^\s"',;&<>)}\]]{4,})\2/gi,
    (all, head, q, val) => (NOT_A_VALUE.test(val) || /^[[{(<]/.test(val) ? all : `${head}${q}${R}${q}`),
  );
  // 5b. DEF-362 review — forms rule 5 cannot see, each found leaking in a
  //     sample request a vendor document or Postman export carries:
  //   - URL userinfo "https://user:pass@host" (the whole userinfo goes);
  sub(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'<>]+:[^\s/@"'<>]+)@/gi, (_all, scheme) => `${scheme}${R}@`);
  //   - curl "-u user:pass" / "--user user:pass" / "--user=…";
  sub(/((?:^|\s)(?:-u|--user)(?:\s+|=))(["']?)([^\s"']{3,})\2/g,
    (all, head, q, val) => {
      // "<user>:<pass>", "$USER:$PASS", "{key}:" are instructions, not credentials.
      const parts = val.split(':').filter(Boolean);
      const placeholder = parts.length > 0 && parts.every((x) => NOT_A_VALUE.test(x) || /^\$\w+$/.test(x));
      return val.startsWith(R) || NOT_A_VALUE.test(val) || placeholder ? all : `${head}${q}${R}${q}`;
    });
  //   - query / form parameters named like a credential, the SAME names
  //     integrationStore's CREDENTIAL_PARAM_RE refuses in api_config (bare
  //     "key", "auth", "sig" included — rule 5 needs a longer name);
  sub(/([?&;](?:api[_-]?key|apikey|key|access[_-]?key|access[_-]?token|token|auth|auth[_-]?token|secret|client[_-]?secret|password|passwd|pwd|sig|signature|hapikey|app[_-]?key|subscription[_-]?key)=)([^\s&#"'<>]{3,})/gi,
    (all, head, val) => (val.startsWith(R) || NOT_A_VALUE.test(val) || /^[[{(<]/.test(val) ? all : `${head}${R}`));
  //   - a header whose name ends in Auth / Key / Token / Secret / Signature
  //     ("X-Auth: …", "X-Shop-Key: …"), which rule 5's word list misses.
  sub(/((?:^|[\s"'{,])x-[A-Za-z0-9-]*(?:auth|key|token|secret|signature)["']?\s*:\s*)(["']?)([^\s"',;]{4,})\2/gim,
    (all, head, q, val) => (val.startsWith(R) || NOT_A_VALUE.test(val) || /^[[{(<]/.test(val) ? all : `${head}${q}${R}${q}`));
  // 6. Long high-entropy tokens with no label: ≥ 32 chars, letters AND digits,
  //    > 3.5 bits/char. UUIDs (example record ids) and plain words are kept.
  const tokenLike = (tok: string): boolean => {
    if (tok.length < 32 || UUID_RE.test(tok)) return false;
    if (!/[A-Za-z]/.test(tok) || !/\d/.test(tok)) return false;
    if (/^[a-z]+(?:[_-][a-z0-9]+)+$/i.test(tok) && entropy(tok) < 4) return false; // snake/kebab identifiers
    return entropy(tok) > 3.5;
  };
  sub(/(?<![A-Za-z0-9_\-+/=.])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g, (tok) => {
    if (tokenLike(tok)) {
      // A path ("/v1/customer_records", always led by "/" — inside a full URL
      // the host's dots stop the match) is judged segment by segment, so an
      // endpoint survives while a token sitting in one segment does not.
      if (!tok.startsWith('/')) return R;
    }
    if (!tok.startsWith('/')) return tok;
    return tok.split('/').map((seg) => (tokenLike(seg) ? R : seg)).join('/');
  });

  return { text: t, redactions: n };
};

// ── Attaching the document ────────────────────────────────────────────────

export type AttachDocInput =
  | { buffer: Buffer; filename: string; mime: string }
  | { text: string; name?: string };

export interface AttachDocResult {
  name: string;
  chars: number;
  redactions: number;
}

/**
 * Extract, redact and store the API document on the integration
 * (api_doc_text / api_doc_name). The previous AI reading belongs to the
 * previous document, so it is cleared. Tenant-scoped; throws
 * IntegrationNotFoundError / IntegrationInputError.
 */
export async function attachApiDocument(cn: string, integrationId: string, input: AttachDocInput): Promise<AttachDocResult> {
  const exists = await prisma.integrationSync.findFirst({ where: { id: integrationId, clientNumber: cn }, select: { id: true } });
  if (!exists) throw new IntegrationNotFoundError(integrationId);

  let raw: string;
  let name: string;
  if ('buffer' in input) {
    raw = await extractDocText(input.buffer, input.filename, input.mime, cn);
    name = (input.filename || 'API document').slice(0, MAX_NAME_CHARS);
  } else {
    const buf = Buffer.from(String(input.text ?? ''), 'utf8');
    raw = await extractDocText(buf, 'pasted.txt', 'text/plain', cn);
    name = (input.name?.trim() || 'Pasted text').slice(0, MAX_NAME_CHARS);
  }
  // Redacted BEFORE storage: the plaintext credential never reaches the DB.
  const { text, redactions } = redactSecrets(raw);
  const res = await prisma.integrationSync.updateMany({
    where: { id: integrationId, clientNumber: cn },
    data: { apiDocText: text, apiDocName: name, apiDocReading: Prisma.DbNull },
  });
  if (res.count === 0) throw new IntegrationNotFoundError(integrationId);
  log.info('api document attached', { clientNumber: cn, integrationId, chars: text.length, redactions });
  return { name, chars: text.length, redactions };
}

// ── The AI reading ────────────────────────────────────────────────────────

export const DOC_READER_SYSTEM_PROMPT = `You read an API document for a business-data integration and draft how to connect to ONE endpoint that returns a list of records.

Return ONLY one JSON object:
{
  "draft": {
    "baseUrl": "https://host[/version prefix]" | null,
    "method": "GET" | "POST" | null,
    "path": "/resource" | null,
    "query": { "name": "fixed value" } | null,
    "body": { ... } | null,
    "authScheme": "NONE" | "BEARER" | "API_KEY" | "BASIC" | null,
    "authHeaderName": "X-API-Key" | null,
    "authQueryParam": "api_key" | null,
    "recordsPath": "data.items" | "" | null,
    "idField": "id" | null,
    "pagination": {"kind":"none"} | {"kind":"page","pageParam":"page","pageSizeParam":"per_page","pageSize":100,"startPage":1}
                | {"kind":"offset","offsetParam":"offset","limitParam":"limit","pageSize":100}
                | {"kind":"next_url","nextUrlPath":"links.next"} | null,
    "declaredTotalPath": "meta.total" | null
  },
  "gaps": ["what the document does not say, in plain words"],
  "summary": "2-5 plain sentences: what this API returns and how it is read",
  "complete": true
}

Rules:
- NEVER output a credential value: no token, key, password or secret, not even an example. Credentials in the document were replaced by [redacted]. The administrator types the credential into a separate secret field. You only say WHICH scheme is used and WHERE the key goes (header name or query parameter name).
- Use null for anything the document does not state, and add a line to "gaps" for it. Never guess, never use placeholders like "<your-token>".
- "baseUrl" must be https, scheme + host (+ version prefix) only; the resource goes in "path".
- Choose the endpoint that best serves the administrator's REMARKS and FILTERS below. If a filter can be expressed as a documented query parameter AND the filter words give its value, put it in "query"; otherwise leave it out (the filter is applied later, after reading).
- "query" = only parameters with a FIXED value. Never put paging parameters or the API key in "query".
- "recordsPath" = dot path to the ARRAY of records in the JSON answer ("" when the answer itself is the array). "idField" = the field that uniquely identifies one record (dot path inside a record). "declaredTotalPath" = dot path to the total count, if the answer states one.
- "pageSize" = the largest page size the document allows.
- "gaps" and "summary" are for a non-technical administrator: no code, no jargon.
- The last key MUST be "complete": true.`;

export interface DocReaderPromptInput {
  integration: { name: string; purpose: string | null; adminBrief: string | null; filterInstructions: string | null };
  docName: string | null;
  docText: string;
}

/** The user message, in a fixed order. Exported for tests. */
export function buildDocReaderUserMessage(input: DocReaderPromptInput): { message: string; cut: boolean } {
  const cut = input.docText.length > DOC_PROMPT_MAX_CHARS;
  const doc = cut ? input.docText.slice(0, DOC_PROMPT_MAX_CHARS) : input.docText;
  const parts = [
    `INTEGRATION: ${input.integration.name}`,
    input.integration.purpose ? `PURPOSE: ${input.integration.purpose}` : null,
    `ADMINISTRATOR'S REMARKS: ${input.integration.adminBrief?.trim() || '(none)'}`,
    `FILTERS ASKED FOR (plain words): ${input.integration.filterInstructions?.trim() || '(none)'}`,
    `API DOCUMENT${input.docName ? ` "${input.docName}"` : ''}${cut ? ` (first ${DOC_PROMPT_MAX_CHARS} characters of ${input.docText.length})` : ''}:`,
    '<<<DOCUMENT',
    doc,
    'DOCUMENT>>>',
  ].filter((x): x is string => x !== null);
  return { message: parts.join('\n'), cut };
}

/** Strip fences, take the outermost object. Null when there is none. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const v = JSON.parse(cleaned.slice(s, e + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const PLACEHOLDER = /^(?:<.*>|\{\{?.*\}?\}|your[-_ ]?\w*|x{3,}|\*{3,}|n\/?a|none|null|tbd|\[redacted\])$/i;
const str = (v: unknown, max = 500): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!s || s.length > max || PLACEHOLDER.test(s)) return null;
  return s;
};
/** Parameter names that carry a credential rather than a value (vm CREDENTIAL_PARAM). */
const CREDENTIAL_PARAM = /^(?:api[_-]?key|apikey|key|access[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|auth|sig(?:nature)?)$/i;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PARAM_NAME = /^[A-Za-z0-9_.\-[\]]{1,64}$/;
/** True when redactSecrets would touch the string — such a value never enters the draft. */
const looksSecret = (s: string): boolean => redactSecrets(s).redactions > 0;

/**
 * The model's draft, field by field through a closed whitelist. Anything
 * invalid is dropped and named in `gaps`; anything credential-shaped is dropped
 * (the model never stores a secret, even one that survived redaction).
 * Exported for tests.
 */
export function sanitiseDraft(raw: unknown): { draft: Partial<ApiConfig>; gaps: string[] } {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const draft: Partial<ApiConfig> = {};
  const gaps: string[] = [];

  const authScheme = str(d.authScheme, 20)?.toUpperCase();
  if (authScheme && (AUTH_SCHEMES as readonly string[]).includes(authScheme)) draft.authScheme = authScheme as ApiConfig['authScheme'];
  else if (authScheme) gaps.push(`The document describes a sign-in method Nexeo cannot use yet (${authScheme}); choose one of None, Bearer token, API key or Basic.`);

  const baseRaw = str(d.baseUrl, 500);
  if (baseRaw) {
    try {
      const u = new URL(baseRaw);
      if (u.protocol !== 'https:') {
        gaps.push(`The document gives an ${u.protocol.replace(':', '')}:// address; only https:// addresses can be used.`);
      } else {
        if (u.username || u.password) gaps.push('The address in the document carried a user name or password; it was removed — enter the credential in the secret field.');
        draft.baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
      }
    } catch {
      gaps.push('The base address in the document is not a valid web address.');
    }
  }

  const method = str(d.method, 10)?.toUpperCase();
  if (method && (API_METHODS as readonly string[]).includes(method)) draft.method = method as ApiConfig['method'];

  // Path: a query string inside it joins the query handling (and its checks).
  const queryIn: Record<string, unknown> = d.query && typeof d.query === 'object' && !Array.isArray(d.query) ? { ...d.query as Record<string, unknown> } : {};
  const pathRaw = str(d.path, 500);
  if (pathRaw) {
    let p = pathRaw;
    if (/^https?:\/\//i.test(p)) {
      try {
        const u = new URL(p);
        if (draft.baseUrl && u.origin !== new URL(draft.baseUrl).origin) {
          gaps.push('The endpoint in the document is on a different address than the base address; check both.');
          p = '';
        } else {
          p = `${u.pathname}${u.search}`;
        }
      } catch { p = ''; }
    }
    const [pathOnly, qs] = p.split('?', 2);
    if (qs) for (const [k, v] of new URLSearchParams(qs)) if (!(k in queryIn)) queryIn[k] = v;
    if (pathOnly && !looksSecret(pathOnly)) draft.path = pathOnly;
  }

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(queryIn)) {
    if (!PARAM_NAME.test(k)) continue;
    // Checked before the value: even "?key=<your key>" says WHERE the key goes.
    if (CREDENTIAL_PARAM.test(k)) {
      // The key rides in the URL: say WHERE, never keep the value (vm liftCredentialFromQuery,
      // minus the lifting — the admin types the key).
      if (!d.authQueryParam && (draft.authScheme === 'API_KEY' || !draft.authScheme)) {
        draft.authScheme = 'API_KEY';
        draft.authQueryParam = k;
      }
      gaps.push(`The API key goes in the URL parameter "${k}" — enter the key in the credential field; it is never stored with the connection.`);
      continue;
    }
    const val = str(v, 300);
    if (val === null) continue;
    if (looksSecret(val)) { gaps.push(`The value of "${k}" looked like a credential and was left out.`); continue; }
    query[k] = val;
  }
  draft.query = query;

  if (d.body && typeof d.body === 'object' && !Array.isArray(d.body)) {
    const text = JSON.stringify(d.body);
    if (text.length <= 10_000 && !looksSecret(text)) draft.body = d.body as Record<string, unknown>;
    else gaps.push('The request body in the document was left out (too large or it held a credential); fill it in by hand.');
  }

  const hdr = str(d.authHeaderName, 64);
  if (hdr && HEADER_NAME.test(hdr) && !looksSecret(hdr)) draft.authHeaderName = hdr;
  const qp = str(d.authQueryParam, 64);
  if (qp && PARAM_NAME.test(qp)) draft.authQueryParam = qp;
  if (draft.authQueryParam && query[draft.authQueryParam] !== undefined) delete query[draft.authQueryParam];

  if (typeof d.recordsPath === 'string' && d.recordsPath.length <= 200 && !PLACEHOLDER.test(d.recordsPath.trim())) {
    draft.recordsPath = d.recordsPath.trim();
  }
  const idField = str(d.idField, 200);
  if (idField) draft.idField = idField;
  const total = str(d.declaredTotalPath, 200);
  if (total) draft.declaredTotalPath = total;

  if (d.pagination !== undefined && d.pagination !== null) {
    const p = readPagination(d.pagination);
    if (p) draft.pagination = p;
    else gaps.push('The paging described in the document could not be understood; set how pages are read by hand.');
  }

  return { draft, gaps };
}

/** The reply as an ApiDocReading (without provider/readAt). Throws DocReadError
 *  when the JSON is missing or the "complete" sentinel is absent. Exported for tests. */
export function parseDocReaderAnswer(text: string): Pick<ApiDocReading, 'draft' | 'gaps' | 'summary'> {
  const obj = parseJsonObject(text);
  if (!obj) throw new DocReadError('The AI did not return a reading of the document. Try again.');
  if (obj.complete !== true) {
    throw new DocReadError('The AI\'s reading of the document was cut off before it finished, so nothing was saved. Try again.');
  }
  const { draft, gaps: draftGaps } = sanitiseDraft(obj.draft);
  const modelGaps = Array.isArray(obj.gaps)
    ? obj.gaps.filter((g): g is string => typeof g === 'string' && !!g.trim()).map((g) => redactSecrets(g.trim()).text.slice(0, MAX_GAP_CHARS))
    : [];
  const summary = typeof obj.summary === 'string' ? redactSecrets(obj.summary.trim()).text.slice(0, MAX_SUMMARY_CHARS) : '';
  const gaps = [...new Set([...modelGaps, ...draftGaps])].slice(0, MAX_GAPS);
  return { draft, gaps, summary };
}

export const readApiDocument: DocReaderModule['readApiDocument'] = async (cn, integrationId, actorId) => {
  const integ = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    select: { id: true, name: true, purpose: true, adminBrief: true, filterInstructions: true, apiDocName: true, apiDocText: true },
  });
  if (!integ) throw new IntegrationNotFoundError(integrationId);
  if (!integ.apiDocText?.trim()) {
    throw new IntegrationInputError('Attach the API document (or paste its text) before asking the AI to read it.', 'apiDoc');
  }
  // Belt and braces: the stored text was redacted on attach; redact again so a
  // row written by any other path still never reaches the model with a key.
  const again = redactSecrets(integ.apiDocText);
  const redactions = (again.text.match(/\[redacted\]/g) ?? []).length;

  const { message, cut } = buildDocReaderUserMessage({
    integration: { name: integ.name, purpose: integ.purpose, adminBrief: integ.adminBrief, filterInstructions: integ.filterInstructions },
    docName: integ.apiDocName,
    docText: again.text,
  });
  const reply = await callLLM(DOC_READER_SYSTEM_PROMPT, message, {
    purpose: DOC_READ_PURPOSE,
    clientNumber: cn,
    userId: actorId,
    timeoutMs: DOC_READ_TIMEOUT_MS,
    providers: [...DOC_READ_PROVIDERS],
    maxTokens: 8192,
  });
  const parsed = parseDocReaderAnswer(reply.text);
  if (cut) parsed.gaps.unshift(`The document is long; only its first ${DOC_PROMPT_MAX_CHARS.toLocaleString('en-US')} characters were read.`);

  const reading: ApiDocReading = {
    ...parsed,
    provider: reply.provider,
    readAt: new Date().toISOString(),
    redactions,
  };
  const res = await prisma.integrationSync.updateMany({
    where: { id: integrationId, clientNumber: cn },
    data: { apiDocReading: JSON.parse(JSON.stringify(reading)) },
  });
  if (res.count === 0) throw new IntegrationNotFoundError(integrationId);
  log.info('api document read', {
    clientNumber: cn, integrationId, provider: reply.provider, gaps: reading.gaps.length,
    drafted: Object.keys(reading.draft).length, redactions, cut,
  });
  return reading;
};

export const docReader: DocReaderModule = { extractDocText, redactSecrets, readApiDocument };
