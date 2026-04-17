/**
 * MyOS Entity Resolver Service
 *
 * Runs on every incoming feed item. Extracts person/company/project
 * mentions via LLM, matches against existing entities, creates new
 * entities if no match found.
 *
 * Uses Gemini Flash for extraction (fast + cheap).
 */

import * as entityService from './entityService';
import type { EntityType } from './entityService';

// ─── Types ────────────────────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  entityType: EntityType;
}

interface ResolvedEntity {
  id: string;
  name: string;
  entityType: EntityType;
  isNew: boolean;
}

// ─── Main resolve function ────────────────────────────────────────

/**
 * Extract entities from text and resolve them against the knowledge graph.
 * Returns array of resolved entity IDs.
 */
export async function resolveEntities(
  clientNumber: string,
  userId: number,
  text: string,
  context?: { sourceFeed?: string; senderEmail?: string; senderName?: string },
): Promise<ResolvedEntity[]> {
  const resolved: ResolvedEntity[] = [];

  // Fast path: if we have a sender email, try direct match first
  if (context?.senderEmail) {
    const existing = await entityService.findByEmail(clientNumber, context.senderEmail);
    if (existing) {
      await entityService.touchInteraction(existing.id);
      resolved.push({
        id: existing.id,
        name: existing.name,
        entityType: existing.entityType as EntityType,
        isNew: false,
      });
      return resolved;
    }

    // Email exists but no entity — create one
    if (context.senderName) {
      const newEntity = await entityService.createEntity(clientNumber, userId, {
        entityType: 'contact',
        name: context.senderName,
        email: context.senderEmail,
      });
      resolved.push({
        id: newEntity.id,
        name: newEntity.name,
        entityType: 'contact',
        isNew: true,
      });
      return resolved;
    }
  }

  // LLM extraction for complex text
  const extracted = await extractEntitiesFromText(text);

  for (const entity of extracted) {
    // Try email match first
    if (entity.email) {
      const byEmail = await entityService.findByEmail(clientNumber, entity.email);
      if (byEmail) {
        await entityService.touchInteraction(byEmail.id);
        resolved.push({ id: byEmail.id, name: byEmail.name, entityType: byEmail.entityType as EntityType, isNew: false });
        continue;
      }
    }

    // Try name fuzzy match
    const byName = await entityService.findByNameFuzzy(clientNumber, entity.name, entity.entityType);
    if (byName.length > 0) {
      // Use first match (best match by recency)
      await entityService.touchInteraction(byName[0].id);
      resolved.push({ id: byName[0].id, name: byName[0].name, entityType: byName[0].entityType as EntityType, isNew: false });
      continue;
    }

    // No match — create new entity
    const newEntity = await entityService.createEntity(clientNumber, userId, {
      entityType: entity.entityType,
      name: entity.name,
      email: entity.email,
      phone: entity.phone,
      company: entity.company,
      role: entity.role,
    });
    resolved.push({ id: newEntity.id, name: newEntity.name, entityType: entity.entityType, isNew: true });
  }

  return resolved;
}

// ─── LLM Entity Extraction ───────────────────────────────────────

/**
 * Extract person/company/project mentions from text using LLM.
 * Uses Gemini Flash for speed. Falls back to simple regex if LLM unavailable.
 */
async function extractEntitiesFromText(text: string): Promise<ExtractedEntity[]> {
  // Skip very short or empty text
  if (!text || text.length < 10) return [];

  try {
    const { getGenAI } = await import('./genaiClient');
    const genai = getGenAI();

    const prompt = `Extract all people, companies, and projects mentioned in this text.
Return a JSON array of objects with fields: name, email (if visible), company (if mentioned), role (if mentioned), entityType ("contact" for people, "account" for companies, "project" for projects).
If no entities found, return [].
Only return the JSON array, nothing else.

Text: ${text.substring(0, 2000)}`;

    const response = await genai.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt });
    const result = response.text || '';

    // Parse JSON from response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.filter((e: ExtractedEntity) => e.name && e.entityType);
    }
  } catch {
    // LLM extraction failed — fall back to simple email extraction
  }

  // Fallback: extract emails from text
  const emailRegex = /[\w.+-]+@[\w-]+\.[\w.]+/g;
  const emails = text.match(emailRegex) || [];
  return emails.slice(0, 5).map(email => ({
    name: email.split('@')[0].replace(/[._-]/g, ' '),
    email,
    entityType: 'contact' as EntityType,
  }));
}
