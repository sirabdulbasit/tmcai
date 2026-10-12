/**
 * DEF-336 — the stale GEMINI_API_KEY pre-gate that held the benchmark judge
 * at 0/12 (Codex it-79 directive #1: "the loop's central failure").
 *
 * Production runs the Vertex provider (no API key needed), but
 * `callGemini`/`streamGemini` threw `GEMINI_API_KEY not configured` BEFORE
 * consulting the configured provider — so in any keyless process (the
 * scorer's `env -u GEMINI_API_KEY` matrix path) both Gemini legs died at the
 * gate with Vertex fully configured and healthy, the Claude leg finished the
 * kill, and the judge "returned nothing" on every dark window — including
 * the early-September ones that PREDATE the billing outage. Billing
 * restoration could never have fixed this; the gate could only be removed.
 *
 * The decision moves to where the information lives (structural-mode rule):
 * `genaiClient.getGenAI` throws a clear, actionable error only when the
 * key-client branch is actually taken with no key.
 *
 * Under test:
 *  - a keyless env with the VERTEX provider configured gets a working client
 *    (THE gauge scenario — this resolving is the whole fix);
 *  - a keyless env with USE_VERTEX_AI=true gets a client (env-var mode);
 *  - a keyless env with NO vertex anywhere throws the clear error, naming
 *    both remedies — never a client that fails later with a cryptic message;
 *  - source-pin: the stale pre-gates are GONE from geminiService (mutation:
 *    restoring either gate fails this).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({
  provider: 'vertex' as string,
}));

vi.mock('../src/services/aiProviderConfig', () => ({
  getAiProviderConfig: async () => ({
    provider: state.provider,
    model: 'gemini-2.5-pro',
    region: 'us-central1',
    serviceAccount: null,
  }),
}));

import { getGenAI, getConfiguredGenAI, resetClient } from '../src/services/genaiClient';

const savedKey = process.env.GEMINI_API_KEY;
const savedVertex = process.env.USE_VERTEX_AI;

beforeEach(() => {
  resetClient();
  delete process.env.GEMINI_API_KEY;
  delete process.env.USE_VERTEX_AI;
  state.provider = 'vertex';
});

afterEach(() => {
  resetClient();
  if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey; else delete process.env.GEMINI_API_KEY;
  if (savedVertex !== undefined) process.env.USE_VERTEX_AI = savedVertex; else delete process.env.USE_VERTEX_AI;
});

describe('DEF-336 — a keyless process with Vertex configured can think', () => {
  it('THE GAUGE SCENARIO: no GEMINI_API_KEY + configured provider vertex → a working client, no throw', async () => {
    const client = await getConfiguredGenAI();
    expect(client).toBeTruthy();
  });

  it('no key + USE_VERTEX_AI=true → a client (env-var vertex mode)', () => {
    process.env.USE_VERTEX_AI = 'true';
    expect(getGenAI()).toBeTruthy();
  });

  it('no key + no vertex anywhere → the CLEAR error naming both remedies, at the branch that needs the key', () => {
    expect(() => getGenAI()).toThrow(/GEMINI_API_KEY is unset and the configured provider is not vertex/);
    expect(() => getGenAI()).toThrow(/Vertex provider.*or set GEMINI_API_KEY/);
  });

  it('the stale pre-gates are GONE from geminiService — the caller no longer decides what credentials the provider needs', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../src/services/geminiService.ts'), 'utf8',
    );
    expect(raw).not.toContain("throw new Error('GEMINI_API_KEY not configured')");
  });
});
