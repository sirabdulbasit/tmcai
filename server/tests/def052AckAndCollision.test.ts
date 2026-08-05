/**
 * DEF-052 · DEF-051(writer) · DEF-049 — three gaps the owner named directly.
 *
 * DEF-052. "there is a whatsapp standard function showing single tick mean
 * message has sent and double tick mean messages has received so why don't it
 * read it?" Nothing listened for `message_ack`, so every send ended with "did
 * not return a receipt ID" and "did you inform her?" stayed a guess forever.
 *
 * DEF-051 writer half. The two Hamna rows were created HERE: auto-discovery
 * correctly made a pushname row on 14 July, then update_contact wrote the same
 * number onto the other Hamna row on 05 Aug without checking. Merging cleans
 * the backlog; only this stops new ones.
 *
 * DEF-049. Two prompts instructed the model to hide that it is an assistant —
 * one of them on the AUTONOMOUS reply path — which contradicted the standing
 * rule that Brain never speaks as the user.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { statusForAck, ACK } from '../src/services/whatsapp/outboundAckService';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEF-052 — delivery ticks are read', () => {
  it('maps WhatsApp ack levels to the states a human recognises', () => {
    expect(statusForAck(ACK.SENT)).toBe('sent');        // ✓
    expect(statusForAck(ACK.DELIVERED)).toBe('delivered'); // ✓✓
    expect(statusForAck(ACK.READ)).toBe('read');        // blue ✓✓
    expect(statusForAck(ACK.PLAYED)).toBe('read');
  });

  it('pending and error carry no delivery information', () => {
    expect(statusForAck(ACK.PENDING)).toBeNull();
    expect(statusForAck(ACK.ERROR)).toBeNull();
  });

  it('the provider subscribes to message_ack', () => {
    const p = strip(read('services/whatsapp/WebjsProvider.ts'));
    expect(p, 'without this listener the ticks are invisible').toContain("client.on('message_ack'");
    expect(p).toContain('recordOutboundAck');
  });

  it('only our own outbound messages are tracked', () => {
    const p = strip(read('services/whatsapp/WebjsProvider.ts'));
    expect(p).toMatch(/msg\?\.fromMe/);
  });

  it('a late lower ack cannot downgrade a higher one', () => {
    // WhatsApp does not guarantee ordering; "read" must not regress to
    // "delivered" because an out-of-order event landed second.
    const svc = strip(read('services/whatsapp/outboundAckService.ts'));
    expect(svc).toMatch(/RANK\[row\.status\][\s\S]{0,40}>=[\s\S]{0,40}RANK\[status\]/);
  });

  it('recording an ack can never disturb the message pipeline', () => {
    const p = strip(read('services/whatsapp/WebjsProvider.ts'));
    expect(p).toMatch(/message_ack[\s\S]{0,900}catch/);
  });
});

describe('DEF-051 — the duplicate is refused at the writer', () => {
  const CODE = strip(read('services/knowledge/brainComposer.ts'));
  const fn = CODE.slice(CODE.indexOf('async function updateContactGuarded'));
  const body = fn.slice(0, fn.indexOf('\nasync function', 10));

  it('checks whether another contact already holds the identifier', () => {
    expect(body).toContain('collidingWith');
    expect(body).toMatch(/id: \{ not: ent\.id \}/);
  });

  it('names who holds it rather than merging unilaterally', () => {
    // The owner may genuinely have two people on one office line.
    expect(body).toMatch(/is already on \$\{collidingWith\.name\}/);
    expect(body).toMatch(/ok:\s*false/);
  });

  it('runs BEFORE the write, not after', () => {
    expect(body.indexOf('collidingWith')).toBeLessThan(body.indexOf('updateEntity'));
  });
});

describe('DEF-049 — Brain no longer instructed to pass as the user', () => {
  it('the "never mention AI" instructions are gone from both prompts', () => {
    for (const f of ['routes/briefRoutes.ts', 'services/triage/autonomousExecutor.ts']) {
      expect(read(f), `${f} must not tell the model to hide automation`)
        .not.toMatch(/NEVER mention[^`]*(?:AI|automation)/);
    }
  });

  it('and both now require a truthful answer if asked', () => {
    for (const f of ['routes/briefRoutes.ts', 'services/triage/autonomousExecutor.ts']) {
      expect(read(f)).toMatch(/answer truthfully/);
    }
  });
});
