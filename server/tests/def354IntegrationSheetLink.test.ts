/**
 * DEF-354 — Integrations Stage 1, sources/sheetLink.ts.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.2, ported from vm
 * integrationSheetLink.ts):
 *  1. The export URL is REBUILT from sheet id + gid only — whatever else the
 *     pasted link carried never reaches the address the server fetches.
 *  2. A tab is never silently swapped: gid is always explicit ('0' when the
 *     link names none) and a link naming two different tabs is refused.
 *  3. Anything that is not a docs.google.com spreadsheet link is an
 *     IntegrationInputError on field 'link'.
 */
import { describe, it, expect } from 'vitest';
import { parseSheetLink, sheetExportUrl } from '../src/services/integrations/sources/sheetLink';
import { parseSheetLink as moduleParse } from '../src/services/integrations/sources/gsheetReader';
import { IntegrationInputError } from '../src/services/integrations/types';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab';

function refused(link: string): IntegrationInputError {
  try { parseSheetLink(link); } catch (e) { return e as IntegrationInputError; }
  throw new Error(`expected ${link} to be refused`);
}

describe('DEF-354 parseSheetLink', () => {
  it('parses the ordinary edit link with #gid', () => {
    const link = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123456`;
    expect(parseSheetLink(link)).toEqual({ sheetId: ID, gid: '123456', link });
  });

  it('takes gid from the query too, and accepts the /u/N/ account form and no scheme', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit?gid=7`).gid).toBe('7');
    expect(parseSheetLink(`docs.google.com/spreadsheets/d/${ID}`).sheetId).toBe(ID);
  });

  it('defaults a link without a tab to gid "0" — explicit, never absent', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`).gid).toBe('0');
  });

  it('refuses a link whose query and fragment name different tabs (no silent tab swap)', () => {
    const e = refused(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1#gid=2`);
    expect(e).toBeInstanceOf(IntegrationInputError);
    expect(e.field).toBe('link');
    expect(e.message).toMatch(/two different tabs/);
    // Same tab in both places is fine.
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=4#gid=4`).gid).toBe('4');
  });

  it('refuses non-Google hosts, look-alike hosts, credentials and ports', () => {
    for (const l of [
      `https://evil.com/spreadsheets/d/${ID}`,
      `https://docs.google.com.evil.com/spreadsheets/d/${ID}`,
      `https://user:pw@docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com:8443/spreadsheets/d/${ID}`,
      `ftp://docs.google.com/spreadsheets/d/${ID}`,
      `file:///etc/passwd`,
    ]) {
      const e = refused(l);
      expect(e).toBeInstanceOf(IntegrationInputError);
      expect(e.field).toBe('link');
    }
  });

  it('refuses docs that are not spreadsheets, publish-to-web links, short ids, bad gids, blanks', () => {
    expect(refused(`https://docs.google.com/document/d/${ID}/edit`).message).toMatch(/not a spreadsheet/);
    expect(refused(`https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pubhtml`).message).toMatch(/Publish to web/);
    expect(refused('https://docs.google.com/spreadsheets/d/short/edit').message).toMatch(/incomplete/);
    expect(refused(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=abc`).message).toMatch(/gid/);
    expect(refused('   ').message).toMatch(/Paste/);
    expect(refused('x'.repeat(3000)).message).toMatch(/too long/);
  });

  it('the module contract export is the same parser', () => {
    expect(moduleParse).toBe(parseSheetLink);
  });
});

describe('DEF-354 sheetExportUrl — rebuilt from id + gid only', () => {
  it('ignores every other part of the pasted link', () => {
    const cfg = parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing&x=https://evil.com#gid=9`);
    expect(sheetExportUrl(cfg)).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=9`);
  });

  it('re-validates stored values so a tampered config never becomes a URL', () => {
    expect(() => sheetExportUrl({ sheetId: `${ID}/../../x`, gid: '0' })).toThrow(IntegrationInputError);
    expect(() => sheetExportUrl({ sheetId: ID, gid: '0&format=xlsx' })).toThrow(IntegrationInputError);
    expect(() => sheetExportUrl({ sheetId: ID, gid: '' })).toThrow(IntegrationInputError);
  });
});
