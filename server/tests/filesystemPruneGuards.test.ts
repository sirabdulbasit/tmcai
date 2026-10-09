import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// ASPECT 1 OF SELF-PRUNING — the guards, which are the entire safety story.
//
// On 2026-10-04 a hand sweep nearly removed 2,733 "empty" /tmp/wa-mig-* dirs; 1,822
// of them held WhatsApp SESSION data (Class 4). A heuristic scoring paths by age and
// size would have deleted them. So nothing is removed unless its family's guard
// returns true for that exact path, and these tests pin that — including the case
// that matters most: a guard that THROWS must mean "no", never "assume yes".

import { planPrune, runFilesystemPrune } from '../src/services/selfpruning/filesystemPruneService';

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;

const mkAged = async (name: string, ageDays: number, withChild = false) => {
  const p = path.join(tmp, name);
  await fs.mkdir(p, { recursive: true });
  if (withChild) await fs.writeFile(path.join(p, 'session-u7'), 'x');
  const t = new Date(Date.now() - ageDays * DAY);
  await fs.utimes(p, t, t);
  return p;
};

const familyWith = (guard: any, over: any = {}) => ({
  id: 'test_family', description: 'test', parent: tmp,
  match: (n: string) => n.startsWith('cand-'),
  minAgeDays: 7, keepNewest: 0, guard, ...over,
});

beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prune-test-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('planPrune — the guard decides, nothing else', () => {
  it('a guard that returns false keeps the path', async () => {
    await mkAged('cand-a', 30);
    const [r] = await planPrune(Date.now(), [familyWith(async () => false)] as any);
    expect(r.candidates).toBe(1);
    expect(r.guardRefused).toBe(1);
    expect(r.paths).toEqual([]);
  });

  it('a guard that THROWS keeps the path — unanswerable is not consent', async () => {
    await mkAged('cand-a', 30);
    const [r] = await planPrune(Date.now(), [familyWith(async () => { throw new Error('find broke'); })] as any);
    expect(r.guardRefused).toBe(1);
    expect(r.paths).toEqual([]);
  });

  it('a guard that returns true lets the path through', async () => {
    await mkAged('cand-a', 30);
    const [r] = await planPrune(Date.now(), [familyWith(async () => true)] as any);
    expect(r.paths).toHaveLength(1);
  });
});

describe('planPrune — age and keepNewest bound it before the guard is consulted', () => {
  it('never offers a path younger than minAgeDays, even with a yes-guard', async () => {
    await mkAged('cand-young', 1);
    const [r] = await planPrune(Date.now(), [familyWith(async () => true)] as any);
    expect(r.candidates).toBe(0);
    expect(r.paths).toEqual([]);
  });

  it('keepNewest protects the NEWEST, not an arbitrary one', async () => {
    await mkAged('cand-old', 60);
    await mkAged('cand-newer', 30);
    const [r] = await planPrune(Date.now(), [familyWith(async () => true, { keepNewest: 1 })] as any);
    expect(r.paths.map((p) => path.basename(p))).toEqual(['cand-old']);
  });

  it('a match() that excludes a name means that name is never even considered', async () => {
    await mkAged('other-thing', 60);
    const [r] = await planPrune(Date.now(), [familyWith(async () => true)] as any);
    expect(r.candidates).toBe(0);
  });

  it('an absent parent directory is not an error — just nothing to do', async () => {
    const [r] = await planPrune(Date.now(), [familyWith(async () => true, { parent: '/nonexistent-xyz' })] as any);
    expect(r.candidates).toBe(0);
    expect(r.paths).toEqual([]);
  });
});

describe('runFilesystemPrune — dry by default', () => {
  it('apply=false removes NOTHING even when the guard says yes', async () => {
    const p = await mkAged('cand-a', 30);
    const r = await runFilesystemPrune({ now: Date.now(), apply: false, families: [familyWith(async () => true)] as any });
    expect(r.applied).toBe(false);
    expect(r.freedBytes).toBe(0);
    await expect(fs.stat(p)).resolves.toBeDefined();   // still there
  });

  it('apply=true removes only what the guard passed, and leaves the refused one', async () => {
    const keep = await mkAged('cand-keep', 30, true);
    const go = await mkAged('cand-go', 30);
    const r = await runFilesystemPrune({ now: Date.now(), apply: true, families: [familyWith(async (p: string) => path.basename(p) === 'cand-go')] as any });
    expect(r.applied).toBe(true);
    await expect(fs.stat(keep)).resolves.toBeDefined();      // refused -> survives
    await expect(fs.stat(go)).rejects.toThrow();             // passed  -> gone
  });
});
