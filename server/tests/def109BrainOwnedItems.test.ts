/**
 * DEF-109 — an item Brain owns must stop asking the owner about itself.
 *
 * Asked for three times, failed three different ways:
 *
 *   08-08 16:23  "the brain should take care and when done the brain itself
 *                 mark it done"          -> asked for confirmation, cancelled
 *   08-08 16:28  "delegate this ... to brain"
 *                -> wrote it into the EXIM item as a blocker, then invented a
 *                   delegatee called "Watcher" that had "declined to study
 *                   brain conversations" and escalated that fiction twice
 *   08-10 16:40  "this actionable item is for you delegated to brain"
 *                -> "Understood, Sir. I've updated the item", stored NOTHING.
 *                   delegatee_name and delegatee_email both null, and the item
 *                   moved DRAFT -> NEW/high, which nags MORE.
 *
 * And the behaviour he asked for, twice, in his own words:
 *   "you don't have to tell me about it repeatedly. When it's done, then you
 *    have to tell me that we have done it."
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  BRAIN_OWNER_NAME, isBrainOwnerName, canonicaliseDelegateeName, isBrainOwned,
} from '../src/services/openItems/brainOwnership';

describe('the phrasings the owner actually used', () => {
  it.each([
    ['this actionable item is for you', 'you'],
    ['delegated to brain', 'brain'],
    ['delegate to the brain', 'the brain'],
    ['nexeo', 'Nexeo'],
    ['brain itself', 'brain itself'],
    ['take care of it yourself', 'yourself'],
  ])('recognises %s', (_label, name) => {
    expect(isBrainOwnerName(name)).toBe(true);
  });

  it('canonicalises every alias to one stored value', () => {
    for (const alias of ['you', 'brain', 'the brain', 'NEXEO', ' Yourself ']) {
      expect(canonicaliseDelegateeName(alias)).toBe(BRAIN_OWNER_NAME);
    }
  });

  it('stores a readable name, never a sentinel the UI must translate', () => {
    // A value like __brain__ WILL be shown raw by some surface eventually.
    expect(BRAIN_OWNER_NAME).toBe('Nexeo');
    expect(BRAIN_OWNER_NAME).not.toMatch(/^__|_$/);
  });
});

describe('real people are never captured', () => {
  it.each(['Hamna Latif Bhutta', 'Muhammad Yousaf', 'Ali Haidar', 'Asad Ahmed Taj'])(
    'leaves %s untouched', (name) => {
      expect(isBrainOwnerName(name)).toBe(false);
      expect(canonicaliseDelegateeName(name)).toBe(name);
    });

  it('an item with a human email is a person\'s item whatever the name says', () => {
    // Defence against a mislabelled row putting real chasing on the skip path.
    expect(isBrainOwned({ delegateeName: 'brain', delegateeEmail: 'hamna@tmcltd.ai' })).toBe(false);
  });

  it('treats empty and null as not-Brain', () => {
    expect(isBrainOwnerName(null)).toBe(false);
    expect(isBrainOwnerName('')).toBe(false);
    expect(isBrainOwnerName('   ')).toBe(false);
    expect(canonicaliseDelegateeName(null)).toBeNull();
  });
});

describe('ownership decides whether the owner gets chased', () => {
  it('a Brain-owned item is identified for skipping', () => {
    expect(isBrainOwned({ delegateeName: 'Nexeo', delegateeEmail: null })).toBe(true);
  });

  it('an unassigned item is NOT Brain-owned — it still needs the owner', () => {
    // The 08-10 failure state: no delegatee at all. That must keep nagging,
    // because nobody owns it; it must not be silently swallowed as Brain's.
    expect(isBrainOwned({ delegateeName: null, delegateeEmail: null })).toBe(false);
  });
});

describe('the wiring — one definition, used at both ends', () => {
  const WORKER = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'actionLifecycleWorker.ts'), 'utf8');
  const GATE = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'openItems', 'openItemGate.ts'), 'utf8');

  it('the chase worker skips Brain-owned items', () => {
    expect(WORKER).toContain('isBrainOwned');
    expect(WORKER).toMatch(/filter\(\(item\) => !isBrainOwned\(item\)\)/);
  });

  it('the skip is counted and logged, not silent', () => {
    expect(WORKER).toContain('brainOwnedSkipped');
    expect(WORKER).toMatch(/skipped brain-owned items/);
  });

  it('the gate canonicalises so the instruction persists', () => {
    expect(GATE).toContain('canonicaliseDelegateeName');
    // Brain has no mailbox; an address would put it back on the chase path.
    expect(GATE).toMatch(/delegateeEmail = null/);
  });

  it('neither file re-implements the alias list', () => {
    for (const src of [WORKER, GATE]) {
      expect(src).not.toMatch(/BRAIN_OWNER_ALIASES\s*=/);
      expect(src).not.toMatch(/'brain'\s*,\s*'nexeo'/);
    }
  });
});
