import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fix 2 (2026-07-09) — riskRadarService.runForUser must pass the LLM
// `narrative` in the notify_user_risk dispatch payload, so the handler
// can render it as the user-facing question body (Rule 4: no hardcoded
// prose on Brain-surface replies).
//
// runForUser is large and its dispatch call sits deep inside a fire-and-
// forget void IIFE with many upstream dependencies (config resolver,
// rule engine, narrator, prisma writes). A behaviour test would need
// to mock a dozen collaborators just to reach the dispatch line — the
// cost outweighs the coverage gained.
//
// Instead: pin the two-line change with a source-content regression
// assertion. The RiskOutreachHandler tests already prove behaviour when
// narrative flows through the handler; THIS test proves the caller
// actually populates it.
const RISK_RADAR_PATH = join(__dirname, '..', 'src', 'services', 'brain', 'riskRadarService.ts');
const SRC = readFileSync(RISK_RADAR_PATH, 'utf-8');

describe('riskRadarService — notify_user_risk dispatch payload', () => {
  it('includes narrative in the dispatch payload (Rule 4 compliance)', () => {
    // Locate the block that calls executeViaRegistry with actionType
    // 'notify_user_risk' and inspect the payload object literal.
    const anchor = SRC.indexOf("actionType: 'notify_user_risk'");
    expect(anchor).toBeGreaterThan(-1);
    // Bounded window covers the payload object literal after the anchor.
    const window = SRC.slice(anchor, anchor + 800);
    // Payload must carry narrative alongside summary. Docid is orthogonal
    // (dedup key); highSeverityCount unchanged.
    expect(window).toMatch(/payload:\s*\{[^}]*narrative[^}]*\}/);
    expect(window).toMatch(/payload:\s*\{[^}]*summary[^}]*\}/);
  });

  it('the narrative local variable is passed through unchanged (no re-templating)', () => {
    // Guard against future refactors that stringify or reformat the
    // narrative before dispatch — the handler must receive the raw
    // LLM prose or a fully-bracketed fallback, nothing in between.
    const anchor = SRC.indexOf("actionType: 'notify_user_risk'");
    const window = SRC.slice(anchor, anchor + 800);
    // The block sets `narrative` from `r.text` and MUST pass it as-is.
    expect(window).not.toMatch(/narrative:\s*`\$\{narrative\}\s+[A-Za-z]/); // no "narrative: `${narrative} … more prose`"
    expect(window).not.toMatch(/narrative:\s*`[^`]*\bDay Brief\b/); // no hardcoded Day Brief trailer
  });
});
