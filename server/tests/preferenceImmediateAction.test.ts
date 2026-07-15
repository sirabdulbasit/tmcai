import { describe, expect, it } from 'vitest';
import {
  IMMEDIATE_INTERNAL_ACTION_TYPES,
  normaliseAction,
} from '../src/services/knowledge/brainComposer';
import { CANONICAL_KEYS } from '../src/services/knowledge/userMemoryService';

describe('preference actions are internal and immediate', () => {
  it('never routes record_preference through an outbound reply-send preview', () => {
    expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('record_preference')).toBe(true);
  });

  it('accepts the canonical two-week email-recency preference', () => {
    expect(normaliseAction({
      type: 'record_preference',
      key: CANONICAL_KEYS.EMAIL_MAX_AGE_DAYS,
      value: 14,
      description: 'Limit normal email retrieval and briefing to the most recent 14 days',
    })).toEqual({
      type: 'record_preference',
      key: 'email_max_age_days',
      value: 14,
      description: 'Limit normal email retrieval and briefing to the most recent 14 days',
    });
  });
});
