/**
 * DEF-232 — `no-dispatcher-in-confirmed-plan`: the four immediate-internal
 * kinds, ONE implementation for BOTH dispatch paths.
 *
 * The owner's words (2026-08-19, S33): "delete all open items" → "confirm
 * delete all 7 items" → "step 1 (remove_open_item): no dispatcher for this
 * action in a confirmed plan." ~14 owner-facing hits over 11 days, and every
 * one terminal: the grant was given, the plan was confirmed, and a register
 * refused it.
 *
 * The mechanism was NOT a wrong gate. `DISPATCHABLE_PLAN_STEP_KINDS` mirrors
 * `dispatchPendingDirect`'s switch exactly (pinned both directions by
 * `tests/planStepDispatchability.test.ts` since DEF-023) — the switch itself
 * had no case for `remove_open_item`, `mark_open_item_done`,
 * `record_preference` or `set_brain_name`, while working implementations for
 * all four ran INLINE in `compose` the whole time. Same shape as DEF-023's
 * own words: "a working implementation existed inline in the composer the
 * whole time, unreachable from the confirmed path." DEF-023 fixed one kind
 * (`update_open_item`) by extracting `applyOpenItemUpdate`; the class stayed
 * open for its four siblings.
 *
 * So this module is the class fix, not a string patch: the inline branches
 * and the confirmed-plan cases now call the SAME functions. A kind that can
 * execute inline is plan-dispatchable by construction, and
 * `tests/def232ConfirmedPlanExecutesInternalKinds.test.ts` pins the invariant
 * that produced all fourteen failures:
 * IMMEDIATE_INTERNAL_ACTION_TYPES ⊆ DISPATCHABLE_PLAN_STEP_KINDS.
 *
 * Bodies are moved from the inline branches verbatim (messages included) —
 * behaviour on the inline path is unchanged by construction, except that
 * `remove_open_item` now reports its `artifactId` so a confirmed plan's
 * ledger can record what it removed.
 */
import prisma from '../../db/prisma';

export interface InternalActionResult {
  ok: boolean;
  artifactId?: string;
  message: string;
}

/**
 * DEF-106/DEF-129 — CANCELLED, not deleted, and not DONE. DONE would be a
 * lie: the work did not happen, the owner decided it should not exist.
 * CANCELLED is honest and reversible (CANCELLED → TRIAGED is the restore),
 * and the transition goes THROUGH the lifecycle matrix — guards, ledger and
 * event publish included.
 */
export async function executeRemoveOpenItem(
  clientNumber: string,
  userId: number,
  input: { openItemId?: string; titleRef?: string; reason?: string },
): Promise<InternalActionResult> {
  try {
    let target = input.openItemId
      ? await prisma.openItem.findFirst({
          where: { id: input.openItemId, clientNumber, userId },
          select: { id: true, title: true, status: true },
        })
      : null;

    // Same stale-id rescue as update_open_item (DEF-103): he named it, so use
    // the name rather than asking him to repeat himself.
    const lookup = input.titleRef;
    if (!target && lookup) {
      const matches = await prisma.openItem.findMany({
        where: {
          clientNumber, userId,
          status: { notIn: ['DONE', 'CANCELLED'] },
          title: { contains: lookup.trim(), mode: 'insensitive' },
        },
        select: { id: true, title: true, status: true },
        take: 5,
      }).catch(() => []);
      const exact = matches.filter(
        (m: any) => m.title.trim().toLowerCase() === lookup.trim().toLowerCase(),
      );
      if (exact.length === 1) target = exact[0];
      else if (matches.length === 1) target = matches[0];
      else if (matches.length > 1) {
        // Ambiguity is a question, never a guess — removing the wrong item is
        // not something the owner can easily notice.
        return {
          ok: false,
          message: `[remove_open_item: "${lookup}" matches ${matches.length} items — ${matches.map((m: any) => `"${m.title}"`).join(', ')}]`,
        };
      }
    }

    if (!target) {
      return {
        ok: false,
        message: `[remove_open_item: could not find an open item matching ${lookup ? `"${lookup}"` : 'that reference'}]`,
      };
    }

    const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
    const removeResult = await transitionStatus(target.id, 'CANCELLED', {
      clientNumber,
      actor: `user:${userId}`,
      reason: input.reason ? `${input.reason}`.slice(0, 500) : 'Removed via Brain Chat',
    });
    if (!removeResult.ok) {
      return { ok: false, message: `[remove_open_item: not removed — ${removeResult.error ?? 'transition refused'}]` };
    }
    return { ok: true, artifactId: target.id, message: `[removed: "${target.title}"]` };
  } catch (e: any) {
    console.warn('[brain-chat] remove_open_item failed', { error: e?.message, userId });
    return { ok: false, message: `[remove_open_item failed: ${e?.message ?? 'unknown'}]` };
  }
}

/**
 * Mark DONE + closure summary. If the item was DELEGATED with a follow-up
 * trail, the summary carries the accumulated trail (Basit 2026-05-23 spec
 * step 5). DEF-128 — the transition result is READ, never assumed: a refused
 * transition is reported as a refusal, not composed into "Marked … done".
 */
export async function executeMarkOpenItemDone(
  clientNumber: string,
  userId: number,
  input: { openItemId?: string; completionNote?: string },
): Promise<InternalActionResult> {
  try {
    const existing = await prisma.openItem.findFirst({
      where: { id: input.openItemId, clientNumber, userId },
      select: {
        id: true, title: true, status: true,
        delegateeName: true, delegateeEmail: true,
        delegationFollowupTrail: true, delegationFollowupCount: true,
      } as any,
    });
    if (!existing) {
      return { ok: false, message: `[mark_open_item_done: openItemId not found]` };
    }
    if ((existing as any).status === 'CLOSED' || (existing as any).status === 'INFORMED') {
      return { ok: false, message: `[mark_open_item_done: item already ${(existing as any).status.toLowerCase()}]` };
    }
    const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
    const closeResult = await transitionStatus((existing as any).id, 'CLOSED', {
      clientNumber,
      actor: `user:${userId}`,
      reason: input.completionNote || 'Marked done via Brain Chat',
    });
    if (!closeResult.ok) {
      return { ok: false, message: `[mark_open_item_done: not closed — ${closeResult.error ?? 'transition refused'}]` };
    }
    const wasDelegated = !!(existing as any).delegateeName;
    const trail = Array.isArray((existing as any).delegationFollowupTrail) ? (existing as any).delegationFollowupTrail as any[] : [];
    let summary = `Marked "${(existing as any).title}" done.`;
    if (input.completionNote) summary += ` ${input.completionNote}`;
    if (wasDelegated) {
      summary += `\n\n— Delegation summary —`;
      summary += `\nDelegated to: ${(existing as any).delegateeName} <${(existing as any).delegateeEmail}>`;
      summary += `\nFollow-ups sent: ${(existing as any).delegationFollowupCount ?? 0}`;
      if (trail.length > 0) {
        summary += `\nTrail:`;
        trail.slice(-5).forEach((t: any) => {
          const time = t.at ? new Date(t.at).toISOString().slice(0, 16).replace('T', ' ') : '?';
          summary += `\n  • [${time}] ${t.channel} ${t.direction}: ${String(t.content ?? '').slice(0, 80)}${(t.content?.length ?? 0) > 80 ? '…' : ''}`;
        });
      }
    }
    return { ok: true, artifactId: (existing as any).id, message: summary };
  } catch (e: any) {
    console.warn('[brain-chat] mark_open_item_done failed', { error: e?.message, openItemId: input.openItemId, userId });
    return { ok: false, message: `[mark_open_item_done failed: ${e?.message ?? 'unknown'}]` };
  }
}

/** Persisted via the SAME explicit-memory write the inline path used. */
export async function executeRecordPreference(
  clientNumber: string,
  userId: number,
  input: { key: string; value: unknown },
): Promise<InternalActionResult> {
  try {
    const { recordExplicitMemory } = await import('./userMemoryService');
    await recordExplicitMemory({
      clientNumber, userId,
      key: input.key,
      value: input.value,
    });
    const valStr = typeof input.value === 'string' ? input.value : JSON.stringify(input.value);
    const emailDays = input.key === 'email_max_age_days' ? Number(input.value) : NaN;
    const preferenceMessage = Number.isFinite(emailDays)
      ? `Got it — I'll limit normal email retrieval and briefing to the most recent ${Math.max(1, Math.round(emailDays))} days. If you explicitly ask for an older email, I'll treat that as a one-time override.`
      : `Got it — I'll remember "${input.key}" as ${valStr} going forward. You can change or remove this in Settings → Brain → Memories.`;
    return { ok: true, artifactId: `pref:${input.key}`, message: preferenceMessage };
  } catch (e: any) {
    return { ok: false, message: `Couldn't save preference: ${e?.message ?? 'unknown'}` };
  }
}

/** Same destination as Settings → Brain → Name — `setBrainName` also
 *  invalidates the persona cache so the very next turn uses the new name. */
export async function executeSetBrainName(
  userId: number,
  input: { name?: string | null },
): Promise<InternalActionResult> {
  try {
    const { setBrainName } = await import('./brainPersonaService');
    const saved = await setBrainName(userId, input.name || null);
    if (saved) {
      return { ok: true, message: `Got it — from now on you can call me ${saved}.` };
    }
    return {
      ok: true,
      message: `Cleared my custom name — I'll go by "your AI assistant" from here on. You can name me again any time.`,
    };
  } catch (e: any) {
    return { ok: false, message: `Couldn't save the name: ${e?.message ?? 'unknown'}` };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * DEF-234 — the same class DEF-232 closed for four kinds, closed for its last
 * four siblings, under the owner's governance ruling of 2026-08-19.
 *
 * `COMPOSER_DISPATCHED_TYPES` held 18 kinds the composer can execute inline.
 * `DISPATCHABLE_PLAN_STEP_KINDS` held 15. The four in the gap —
 * `set_contact_scope`, `mark_contact_inactive`, `archive_wiki_page`,
 * `delete_wiki_page` — worked when asked for directly and died with
 * "no dispatcher for this action in a confirmed plan" the moment they appeared
 * in a plan the owner had confirmed. Exactly the sentence he read 16 times.
 *
 * The ruling forbids the obvious patch: BRAIN_VISION.md now says a guardrail is
 * an invariant about any action, never a list of which actions are allowed, and
 * that adding a kind to an allow-list is not an accepted fix. So the gate is no
 * longer its own list — it is DERIVED from what can execute (see
 * `DISPATCHABLE_PLAN_STEP_KINDS` in brainComposer.ts). These four functions are
 * what make that derivation true rather than merely declared: a kind the
 * composer can execute is now executable from the confirmed path too, because
 * both paths call the same function.
 *
 * Bodies are moved VERBATIM from the inline branches, messages included, so
 * behaviour on the inline path is unchanged by construction.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The `entity_person` wiki page for a saved contact, matched on email or
 *  phone. Shared by the two contact executors, which located it with the same
 *  query duplicated — and a second copy of a lookup is how
 *  `protection-with-two-implementations` reached five recurrences. */
async function contactWikiPage(
  clientNumber: string,
  ent: { email: string | null; phone: string | null },
): Promise<{ id: string; metadata: unknown; user_id: number } | undefined> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, metadata, user_id FROM wiki_pages
     WHERE client_number = $1 AND page_type = 'entity_person'
       AND (
         ($2 <> '' AND lower(metadata->>'email') = $2)
         OR ($3 <> '' AND regexp_replace(COALESCE(metadata->>'phone',''),'[^0-9+]','','g') = $3)
       ) LIMIT 1`,
    clientNumber,
    (ent.email ?? '').toLowerCase(),
    (ent.phone ?? '').replace(/[^\d+]/g, ''),
  ).catch(() => []);
  return rows[0];
}

export async function executeSetContactScope(
  clientNumber: string,
  userId: number,
  args: { contactCandidateId: string; scope: 'tenant' | 'normal' | 'private' },
): Promise<InternalActionResult> {
  try {
    // contactCandidateId is the entities.id, but the visibility lives on
    // wiki_pages.metadata.scope for the corresponding entity_person page.
    const ent = await prisma.entity.findFirst({
      where: { id: args.contactCandidateId, clientNumber },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!ent) return { ok: false, message: `[set_contact_scope: contact not found in your contacts]` };
    const page = await contactWikiPage(clientNumber, ent);
    if (!page) return { ok: false, message: `[set_contact_scope: no wiki page for ${ent.name}]` };
    // GUARDRAIL, and one of the four the vision names: user scope. Not a list of
    // permitted kinds — a fact about who owns this record.
    if (page.user_id !== userId) {
      return { ok: false, message: `[set_contact_scope: only the owner can change scope]` };
    }
    const newMeta: any = { ...(page.metadata as object), scope: args.scope };
    if (args.scope === 'tenant') {
      newMeta.publicSince = new Date().toISOString();
      newMeta.publicSetBy = userId;
    }
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
      JSON.stringify(newMeta), page.id,
    );
    return { ok: true, artifactId: page.id, message: `Set "${ent.name}" scope to ${args.scope}.` };
  } catch (e: any) {
    return { ok: false, message: `[set_contact_scope failed: ${e?.message ?? 'unknown'}]` };
  }
}

export async function executeMarkContactInactive(
  clientNumber: string,
  userId: number,
  args: { contactCandidateId: string },
): Promise<InternalActionResult> {
  try {
    const ent = await prisma.entity.findFirst({
      where: { id: args.contactCandidateId, clientNumber },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!ent) return { ok: false, message: `[mark_contact_inactive: contact not found]` };
    const page = await contactWikiPage(clientNumber, ent);
    // The page update is best-effort and scoped to the owner; the contact is
    // still reported inactive either way, which is the inline behaviour.
    if (page && page.user_id === userId) {
      const newMeta = {
        ...(page.metadata as object),
        markedInactiveByUser: true,
        markedInactiveAt: new Date().toISOString(),
      };
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages SET metadata = $1::jsonb, status = 'inactive', last_updated_at = NOW() WHERE id = $2`,
        JSON.stringify(newMeta), page.id,
      );
    }
    return { ok: true, artifactId: ent.id, message: `Marked "${ent.name}" inactive. Brain will skip them.` };
  } catch (e: any) {
    return { ok: false, message: `[mark_contact_inactive failed: ${e?.message ?? 'unknown'}]` };
  }
}

export async function executeArchiveWikiPage(
  clientNumber: string,
  userId: number,
  args: { wikiPageId: string },
): Promise<InternalActionResult> {
  try {
    const existing = await prisma.wikiPage.findUnique({
      where: { id: args.wikiPageId },
      select: { id: true, clientNumber: true, userId: true, scope: true, title: true, status: true },
    });
    // GUARDRAIL: tenant scope, then user scope. Both are facts about the record,
    // not opinions about the verb.
    if (!existing || existing.clientNumber !== clientNumber) {
      return { ok: false, message: `[archive_wiki_page: page not found]` };
    }
    if (existing.scope === 'user' && existing.userId !== userId) {
      return { ok: false, message: `[archive_wiki_page: only the owner can archive this page]` };
    }
    if (existing.status === 'archived') {
      return { ok: true, artifactId: existing.id, message: `"${existing.title}" was already archived.` };
    }
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { status: 'archived' as any, lastUpdatedAt: new Date() } as any,
    });
    return {
      ok: true, artifactId: existing.id,
      message: `Archived wiki page "${existing.title}". Brain won't surface it until you restore it.`,
    };
  } catch (e: any) {
    return { ok: false, message: `[archive_wiki_page failed: ${e?.message ?? 'unknown'}]` };
  }
}

export async function executeDeleteWikiPage(
  clientNumber: string,
  userId: number,
  args: { wikiPageId: string },
): Promise<InternalActionResult> {
  try {
    const existing = await prisma.wikiPage.findUnique({
      where: { id: args.wikiPageId },
      select: { id: true, clientNumber: true, userId: true, scope: true, title: true, pageType: true },
    });
    if (!existing || existing.clientNumber !== clientNumber) {
      return { ok: false, message: `[delete_wiki_page: page not found]` };
    }
    if (existing.scope === 'user' && existing.userId !== userId) {
      return { ok: false, message: `[delete_wiki_page: only the owner can delete this page]` };
    }
    await prisma.wikiPage.delete({ where: { id: existing.id } });
    // A hard delete is the one action here with no undo, so it is logged with
    // the actor. The vision's third guardrail — irreversible needs confirmation
    // — is satisfied upstream: a plan step reaches here only after the owner
    // confirmed the rendered preview.
    console.warn('[brain-chat] wiki page hard-deleted via Brain', {
      id: existing.id, title: existing.title, pageType: existing.pageType,
      actor: userId, clientNumber,
    });
    return {
      ok: true, artifactId: existing.id,
      message: `Deleted wiki page "${existing.title}". Brain has forgotten it.`,
    };
  } catch (e: any) {
    return { ok: false, message: `[delete_wiki_page failed: ${e?.message ?? 'unknown'}]` };
  }
}
