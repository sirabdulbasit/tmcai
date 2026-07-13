import { describe, it, expect } from 'vitest';
import { normaliseAction } from '../src/services/knowledge/brainComposer';

// Chat 5 (2026-07-13) — RECURRENCE of capability-fabrication:
// "update his email with asad.ahmed@tmcltd.com" → "Sir, I can't directly
// update a contact's email address" + offer to create a DUPLICATE contact.
// Root cause: the capability registry CLAIMED contact-edit (PATCH
// /entities/:id) but no emittable action backed it. The 59b63da "fix"
// only edited prompt text — it never built the action. This locks the
// real update_contact action's parser.

describe('normaliseAction — update_contact', () => {
  it('parses an email correction (the Asad .ai → .com case)', () => {
    const a = normaliseAction({
      type: 'update_contact',
      contactCandidateId: 'ent_asad',
      newEmail: 'asad.ahmed@tmcltd.com',
    });
    expect(a).not.toBeNull();
    expect(a!.type).toBe('update_contact');
    expect((a as any).newEmail).toBe('asad.ahmed@tmcltd.com');
  });

  it('normalises a phone into E.164', () => {
    const a = normaliseAction({ type: 'update_contact', contactCandidateId: 'e', newPhone: '0302 800 0553'.replace('0302', '923028') });
    // (923028000553 → +923028000553)
    expect(a).not.toBeNull();
    expect((a as any).newPhone).toMatch(/^\+\d{10,15}$/);
  });

  it('accepts a name change', () => {
    const a = normaliseAction({ type: 'update_contact', contactCandidateId: 'e', newName: 'Asad Ahmed Taj' });
    expect((a as any).newName).toBe('Asad Ahmed Taj');
  });

  it('REJECTS when no field is being changed (nothing to do)', () => {
    expect(normaliseAction({ type: 'update_contact', contactCandidateId: 'e' })).toBeNull();
  });

  it('REJECTS a malformed email rather than silently dropping it', () => {
    expect(normaliseAction({ type: 'update_contact', contactCandidateId: 'e', newEmail: 'not-an-email' })).toBeNull();
  });

  it('REJECTS when contactCandidateId is missing (no target to edit)', () => {
    expect(normaliseAction({ type: 'update_contact', newEmail: 'x@y.com' })).toBeNull();
  });
});
