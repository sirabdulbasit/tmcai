/**
 * MyOS Entity Service
 *
 * Entity Knowledge Graph — every person, company, and project
 * mentioned across any feed is a unique entity.
 * Entities link to open items, decisions, and interactions.
 */

import prisma from '../db/prisma';
import { looksLikeLidDigits } from './whatsapp/waIdentity';
import createLogger from '../utils/logger';

const log = createLogger('entity');

// ─── Types ────────────────────────────────────────────────────────

export type EntityType = 'contact' | 'account' | 'project' | 'opportunity' | 'risk' | 'okr';

export interface CreateEntityInput {
  entityType: EntityType;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

// ─── CRUD ─────────────────────────────────────────────────────────

/**
 * A LID never enters `phone`. DEF-245, 2026-08-25.
 *
 * The owner sent three Contacts screenshots — two rows for Hamna, six for Muhammad Yousuf, two
 * for Asad — and the LID half of that is created HERE. `255043747987458@lid` arrived as
 * `+255043747987458` and sat in `phone`, so the WhatsApp identity could never match the real
 * number and the same human rendered twice. 26 rows were in that state.
 *
 * The migration relocated the existing ones; this stops new ones. It relocates rather than
 * rejects for the same reason: a value in `waLid` is visible and reversible, a discarded one is
 * neither. Both create and update go through it, because a row can acquire a LID on either path.
 */
function splitPhoneAndLid(phone: string | null | undefined): { phone: string | null; waLid: string | null } {
  if (!phone) return { phone: phone ?? null, waLid: null };
  if (!looksLikeLidDigits(phone)) return { phone, waLid: null };
  return { phone: null, waLid: String(phone).replace(/[^0-9]/g, '').slice(0, 32) };
}

export async function createEntity(clientNumber: string, createdBy: number, input: CreateEntityInput) {
  const split = splitPhoneAndLid(input.phone);
  if (split.waLid) {
    log.warn('contact phone looked like a WhatsApp LID — filed as waLid, not phone', {
      clientNumber, name: input.name, waLid: split.waLid,
    });
  }
  return prisma.entity.create({
    data: {
      entityType: input.entityType,
      name: input.name,
      email: input.email,
      phone: split.phone,
      waLid: split.waLid,
      company: input.company,
      role: input.role,
      metadata: (input.metadata as any) || undefined,
      clientNumber,
      createdBy,
    },
  });
}

export async function getEntity(id: string, clientNumber: string) {
  return prisma.entity.findFirst({
    where: { id, clientNumber },
    include: {
      linksFrom: { include: { linkedEntity: true } },
      linksTo: { include: { entity: true } },
    },
  });
}

export async function updateEntity(id: string, clientNumber: string, data: Partial<CreateEntityInput> & { sentimentScore?: number; relationshipStrength?: number }) {
  return prisma.entity.update({
    where: { id },
    data: {
      ...data,
      metadata: (data.metadata as any) || undefined,
      lastInteraction: new Date(),
    },
  });
}

export async function listEntities(
  clientNumber: string,
  filters?: { entityType?: EntityType; search?: string },
) {
  const where: Record<string, unknown> = { clientNumber };

  if (filters?.entityType) where.entityType = filters.entityType;
  if (filters?.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { email: { contains: filters.search, mode: 'insensitive' } },
      { company: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  return prisma.entity.findMany({
    where,
    orderBy: { lastInteraction: 'desc' },
    take: 100,
  });
}

// ─── Search / Match (for entity resolver) ─────────────────────────

export async function findByEmail(clientNumber: string, email: string) {
  return prisma.entity.findFirst({
    where: { clientNumber, email: { equals: email, mode: 'insensitive' } },
  });
}

export async function findByNameFuzzy(clientNumber: string, name: string, entityType?: EntityType) {
  const where: Record<string, unknown> = {
    clientNumber,
    name: { contains: name, mode: 'insensitive' },
  };
  if (entityType) where.entityType = entityType;

  return prisma.entity.findMany({
    where,
    take: 5,
    orderBy: { lastInteraction: 'desc' },
  });
}

// ─── Entity Links ─────────────────────────────────────────────────

export async function linkEntities(clientNumber: string, entityId: string, linkedEntityId: string, linkType: string) {
  return prisma.entityLink.upsert({
    where: {
      entityId_linkedEntityId_linkType: { entityId, linkedEntityId, linkType },
    },
    create: { entityId, linkedEntityId, linkType, clientNumber },
    update: {},
  });
}

export async function getEntityLinks(entityId: string) {
  const [from, to] = await Promise.all([
    prisma.entityLink.findMany({
      where: { entityId },
      include: { linkedEntity: true },
    }),
    prisma.entityLink.findMany({
      where: { linkedEntityId: entityId },
      include: { entity: true },
    }),
  ]);
  return { outgoing: from, incoming: to };
}

// ─── Sentiment & Interaction Update ───────────────────────────────

export async function updateSentiment(id: string, score: number) {
  return prisma.entity.update({
    where: { id },
    data: { sentimentScore: score, lastInteraction: new Date() },
  });
}

export async function touchInteraction(id: string) {
  return prisma.entity.update({
    where: { id },
    data: { lastInteraction: new Date() },
  });
}
