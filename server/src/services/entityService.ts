/**
 * MyOS Entity Service
 *
 * Entity Knowledge Graph — every person, company, and project
 * mentioned across any feed is a unique entity.
 * Entities link to open items, decisions, and interactions.
 */

import prisma from '../db/prisma';

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

export async function createEntity(clientNumber: string, createdBy: number, input: CreateEntityInput) {
  return prisma.entity.create({
    data: {
      entityType: input.entityType,
      name: input.name,
      email: input.email,
      phone: input.phone,
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
