/**
 * DEF-354 — Integrations Stage 1, sources/csv.ts (RFC 4180 parser).
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.2 "CSV, not xlsx"):
 *  - quotes, "" escapes, commas and newlines inside quotes, CRLF / LF / CR, BOM;
 *  - every record has a key for EVERY header, '' for an empty or missing cell
 *    (never undefined), cells trimmed;
 *  - blank / duplicate headers are made unique AND reported as anomalies —
 *    the reader reports oddities, it never silently corrects them;
 *  - row and byte caps produce a TRUNCATED result, never a silent short read.
 */
import { describe, it, expect } from 'vitest';
import { parseCsvRows, csvToRecords, uniqueHeaders } from '../src/services/integrations/sources/csv';

describe('DEF-354 parseCsvRows', () => {
  it('handles quoted commas, escaped quotes and newlines inside quotes', () => {
    const { rows, unterminated } = parseCsvRows('a,b,c\n"x, y","say ""hi""","line1\nline2"\n');
    expect(unterminated).toBe(false);
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2']]);
  });

  it('accepts CRLF, LF and lone CR line ends and strips a BOM', () => {
    expect(parseCsvRows('﻿h1,h2\r\n1,2\r3,4\n5,6').rows).toEqual([['h1', 'h2'], ['1', '2'], ['3', '4'], ['5', '6']]);
  });

  it('keeps trailing empty cells and does not invent a row from the final newline', () => {
    expect(parseCsvRows('a,b,\n1,,\n').rows).toEqual([['a', 'b', ''], ['1', '', '']]);
  });

  it('flags an unterminated quote', () => {
    expect(parseCsvRows('a\n"open').unterminated).toBe(true);
  });
});

describe('DEF-354 uniqueHeaders', () => {
  it('renames duplicates (case-insensitive) and blanks, reporting each', () => {
    const { headers, anomalies } = uniqueHeaders(['Revenue', 'revenue', '', 'Revenue']);
    expect(headers).toEqual(['Revenue', 'revenue (2)', 'Column 3', 'Revenue (3)']);
    expect(anomalies.some((a) => /repeats the header "revenue"/.test(a))).toBe(true);
    expect(anomalies.some((a) => /no header \(column 3\)/.test(a))).toBe(true);
  });
});

describe('DEF-354 csvToRecords', () => {
  it('builds header-keyed records with every key present, trimmed, short rows padded with ""', () => {
    const r = csvToRecords('Month , Revenue,Region\n Jan 2026 , 1,200 ,North\nFeb 2026,"1,300"\n');
    expect(r.headers).toEqual(['Month', 'Revenue', 'Region']);
    // " 1,200 " splits on the unquoted comma: Revenue=1, Region=200 — then
    // the third cell is beyond the last header and reported.
    expect(r.records[0]).toEqual({ Month: 'Jan 2026', Revenue: '1', Region: '200' });
    expect(r.records[1]).toEqual({ Month: 'Feb 2026', Revenue: '1,300', Region: '' });
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.anomalies.some((a) => /beyond the last headed column \(first at row 2\)/.test(a))).toBe(true);
  });

  it('skips blank rows above the header and between data, reporting both', () => {
    const r = csvToRecords(',,\n\nA,B\n1,2\n,\n3,4\n');
    expect(r.headers).toEqual(['A', 'B']);
    expect(r.records).toEqual([{ A: '1', B: '2' }, { A: '3', B: '4' }]);
    expect(r.anomalies).toContain('2 blank row(s) above the header row were skipped.');
    expect(r.anomalies).toContain('1 blank row(s) were skipped.');
  });

  it('an empty text has no headers and no rows', () => {
    expect(csvToRecords('')).toMatchObject({ headers: [], records: [], rowCount: 0, truncated: false });
  });

  it('a row cap truncates and says so', () => {
    const r = csvToRecords('A\n1\n2\n3\n', { maxRows: 2 });
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/more than 2 data rows/);
  });

  it('exactly maxRows rows is NOT truncated', () => {
    expect(csvToRecords('A\n1\n2\n', { maxRows: 2 }).truncated).toBe(false);
  });

  it('a byte cut drops the possibly-partial last row and marks truncated', () => {
    const r = csvToRecords('A,B\n1,2\n3,4\n5,', { cutByBytes: true, bytesReason: 'cut at 1 MB' });
    expect(r.records).toEqual([{ A: '1', B: '2' }, { A: '3', B: '4' }]);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe('cut at 1 MB');
  });

  it('an unterminated quote is reported, not silently absorbed', () => {
    const r = csvToRecords('A\n"never closed\n2\n');
    expect(r.anomalies.some((a) => /never closed/.test(a))).toBe(true);
  });
});
