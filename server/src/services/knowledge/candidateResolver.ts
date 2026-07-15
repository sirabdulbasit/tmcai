/**
 * candidateResolver — turns reasoning's emitted candidateId into a real
 * contact (email + phone + name), scoped to the current user's allowed
 * entity set.
 *
 * Per Basit 2026-05-23: actions involving humans MUST emit candidateIds
 * (entity row ids), not raw emails/phones. Eliminates hallucination
 * structurally — the LLM picks from data we provided; it cannot invent
 * a contact that isn't in the candidate pool.
 *
 * Filter mirrors contactResolver's user-scope rule:
 *   scope='tenant' OR ownerUserId=user OR (ownerUserId=null AND createdBy=user)
 *
 * Returns null when the candidateId doesn't exist or isn't visible to
 * this user. Callers should surface a bracketed marker on null.
 */
import prisma from '../../db/prisma';

export interface ResolvedContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export async function resolveCandidate(
  candidateId: string,
  userId: number,
  clientNumber: string,
): Promise<ResolvedContact | null> {
  if (!candidateId || typeof candidateId !== 'string') return null;
  const row = await prisma.entity.findFirst({
    where: {
      id: candidateId,
      clientNumber,
      entityType: 'contact',
      OR: [
        { scope: 'tenant' as any },
        { ownerUserId: userId } as any,
        { AND: [{ ownerUserId: null } as any, { createdBy: userId }] },
      ],
    } as any,
    select: { id: true, name: true, email: true, phone: true },
  }).catch(() => null);
  return row;
}

/** Resolve multiple candidate IDs. Returns a parallel array;
 *  null entries indicate unresolved ids. */
export async function resolveCandidates(
  candidateIds: string[],
  userId: number,
  clientNumber: string,
): Promise<Array<ResolvedContact | null>> {
  return Promise.all(candidateIds.map((id) => resolveCandidate(id, userId, clientNumber)));
}
