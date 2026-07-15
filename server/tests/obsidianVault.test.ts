import { describe, it, expect } from 'vitest';
import {
  renderContactMd,
  renderWikiPageMd,
  safeFileName,
  contentHash,
  EXPORTED_PAGE_TYPES,
} from '../src/services/knowledge/obsidianVaultService';

// Obsidian vault Phase 1 (2026-07-14) — the user's brain mirrored into
// THEIR OWN Google Drive as plain markdown. These tests lock the pure
// layer: renderers (frontmatter correctness — Phase 2 ingest will parse
// these back), filename safety, and the hash that drives incremental
// export + the Phase-2 loop-protection (user-edit detection).

describe('renderContactMd', () => {
  it('renders frontmatter with all identifiers including alternates', () => {
    const md = renderContactMd({
      id: 'ent_asad',
      name: 'Asad Ahmed Taj',
      email: 'asad.ahmed@tmcltd.com',
      phone: '+923474937298',
      company: 'TMC',
      metadata: { altEmails: ['asad.ahmed@tmcltd.ai'], altPhones: [] },
    });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('type: contact');
    expect(md).toContain('nexeo-id: ent_asad');
    expect(md).toContain('email: asad.ahmed@tmcltd.com');
    expect(md).toContain('phone: "+923474937298"'); // + forces quoting
    expect(md).toContain('alt-emails: [asad.ahmed@tmcltd.ai]');
    expect(md).not.toContain('alt-phones'); // empty list omitted
    expect(md).toContain('# Asad Ahmed Taj');
  });

  it('handles a minimal contact (name only) without empty fields', () => {
    const md = renderContactMd({ id: 'e1', name: 'Yousaf', email: null, phone: null, company: null, metadata: null });
    expect(md).toContain('# Yousaf');
    expect(md).not.toContain('email:');
    expect(md).not.toContain('phone:');
  });
});

describe('renderWikiPageMd', () => {
  it('prepends frontmatter to the existing markdown body', () => {
    const md = renderWikiPageMd({
      id: 'wp_1', pageType: 'decision', title: 'EXIM pricing',
      bodyMarkdown: '# EXIM pricing\n\nDecided to hold.',
      lastUpdatedAt: new Date('2026-07-10T10:00:00Z'),
    });
    expect(md.startsWith('---\ntype: decision\nnexeo-id: wp_1\nupdated: 2026-07-10\n---\n')).toBe(true);
    expect(md).toContain('Decided to hold.');
    expect(md.endsWith('\n')).toBe(true);
  });
});

describe('safeFileName', () => {
  it('strips path separators and Obsidian/Drive-hostile characters', () => {
    // '?' is Windows-illegal in filenames — vaults often live on
    // Windows, so it's stripped too.
    expect(safeFileName('Re: FACL/EXIM — Q3 "update"? [urgent] #1')).toBe("Re FACL EXIM — Q3 update urgent 1");
    expect(safeFileName('a\\b:c*d')).toBe('a b c d');
  });
  it('never returns empty; caps length', () => {
    expect(safeFileName('///')).toBe('Untitled');
    expect(safeFileName('x'.repeat(300)).length).toBe(120);
  });
});

describe('contentHash — incremental export + loop protection', () => {
  it('is stable for identical content and differs on any change', () => {
    const a = contentHash('hello world');
    expect(contentHash('hello world')).toBe(a);
    expect(contentHash('hello world!')).not.toBe(a);
    expect(a).toHaveLength(32);
  });
});

describe('exported page types', () => {
  it('mirrors knowledge types, never internal machinery', () => {
    expect(Object.keys(EXPORTED_PAGE_TYPES)).toEqual(
      expect.arrayContaining(['topic', 'decision', 'observation', 'instruction']),
    );
    // entity_person is represented via Contacts/, not duplicated as pages;
    // tenant_log and answer-cache types are machinery and stay out.
    expect(EXPORTED_PAGE_TYPES).not.toHaveProperty('entity_person');
    expect(EXPORTED_PAGE_TYPES).not.toHaveProperty('tenant_log');
    expect(EXPORTED_PAGE_TYPES).not.toHaveProperty('answer');
  });
});
