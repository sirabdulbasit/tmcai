/**
 * HaseebOS v15 L2.6 — Entity linking at promote time.
 *
 * When Feed Curator promotes a FeedEvent to an OpenItem, this helper maps
 * `senderEmail` → `contact entity`, attempts to resolve the associated
 * company, and returns the entity id to attach.
 *
 * Create-if-missing is intentional: a new contact seen via any channel is
 * immediately usable across the entity graph.
 */
import prisma from '../../db/prisma';
import { findByEmail, createEntity } from '../entityService';

export interface LinkInput {
  clientNumber: string;
  createdBy?: number;
  senderEmail?: string | null;
  senderName?: string | null;
  senderPhone?: string | null;
}

export interface LinkResult {
  entityId: string | null;
  created: boolean;
  companyDomain?: string | null;
}

export async function linkEntityAtPromote(input: LinkInput): Promise<LinkResult> {
  const email = (input.senderEmail ?? '').trim().toLowerCase();
  if (!email) return { entityId: null, created: false };

  const existing = await findByEmail(input.clientNumber, email);
  if (existing) {
    await prisma.entity.update({
      where: { id: existing.id },
      data: { lastInteraction: new Date() },
    }).catch(() => {});
    return { entityId: existing.id, created: false, companyDomain: existing.company ?? null };
  }

  const domain = email.split('@')[1] ?? null;
  const created = await createEntity(input.clientNumber, input.createdBy ?? 0, {
    entityType: 'contact',
    name: input.senderName ?? email,
    email,
    phone: input.senderPhone ?? undefined,
    company: domain ?? undefined,
  } as any);

  return { entityId: created.id, created: true, companyDomain: domain };
}
