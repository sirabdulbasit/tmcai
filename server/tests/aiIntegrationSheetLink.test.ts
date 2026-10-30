/**
 * Vendored from @tmc/ai-integration c0a6ebe test/integrationSheetLink.test.ts — imports re-pointed at
 * src/vendor/ai-integration (see src/vendor/ai-integration/VENDORED.md).
 * Only the parseSheetLink / nameFromDisposition cases are copied: those are the
 * functions Nexeo calls. The xlsx download / workbook / token-read cases are NOT
 * copied because Nexeo does not route anything through them (xlsx 0.18.5 CVEs).
 */
import { describe, it, expect } from 'vitest';
import {
  parseSheetLink, isOnlySheetLink,
  nameFromDisposition,
} from '../src/vendor/ai-integration/sources/sheetLink';

const ID = '1JrYos_Evg0U3wCXEg4C_2VAKh6PmZbg-SANXX2o06mM';

describe('parseSheetLink', () => {
  it('finds the id and the tab of an edit link', () => {
    expect(parseSheetLink(`see https://docs.google.com/spreadsheets/d/${ID}/edit?gid=42#gid=42 please`))
      .toMatchObject({ id: ID, gid: '42', published: false });
  });
  it('reads a published link', () => {
    expect(parseSheetLink('https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml'))
      .toMatchObject({ id: '2PACX-1vQabcdefghijklmnopqrstuvwxyz', published: true, gid: null });
  });
  it('reads a link opened from a second Google account', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit#gid=0`)).toMatchObject({ id: ID, gid: '0' });
  });
  it('is null for any other address', () => {
    expect(parseSheetLink('https://evil.example.com/spreadsheets/d/' + ID)).toBeNull();
    expect(parseSheetLink('GET /api/object-data?objectId=1')).toBeNull();
  });
  it('tells a bare link from a document that mentions one', () => {
    expect(isOnlySheetLink(`  https://docs.google.com/spreadsheets/d/${ID}/edit  `)).toBe(true);
    expect(isOnlySheetLink(`Base URL: https://x.com — data also in https://docs.google.com/spreadsheets/d/${ID}`)).toBe(false);
  });
});

describe('nameFromDisposition', () => {
  it('reads Google\'s file name', () => {
    expect(nameFromDisposition('attachment; filename="Bench Data.xlsx"')).toBe('Bench Data.xlsx');
    expect(nameFromDisposition(null)).toBeNull();
  });
});
