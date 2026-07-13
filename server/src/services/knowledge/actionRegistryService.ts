/**
 * actionRegistryService — registry of action types Brain can dispatch.
 *
 * Phase 1 of data-driven refactor (2026-05-22). Replaces (in later
 * phases) the switch/case in instructionDispatcher and the per-type
 * branches in brainComposer's action handling.
 *
 * Each action type is a row with its JSON schema, handler module +
 * function name, preview template, required capability. The generic
 * dispatcher reads the row and:
 *   1. validates payload against schema
 *   2. checks capability_registry for the required capability
 *   3. dynamically imports handlerModule and invokes handlerFunction
 *
 * Brain can propose new action types via the register_action_type
 * meta-action. User approves in Settings → Brain → Actions.
 * Constrained to use existing handler patterns (e.g., webhook
 * adapter) — no arbitrary code execution.
 */
import prisma from '../../db/prisma';

/** Tiny JSON-schema-subset validator. We only need {type, required,
 *  properties} support — Ajv would work but adds a dependency. The
 *  schemas in action_definitions are author-controlled (seeded or
 *  user-proposed-then-approved); no untrusted input. */
function compileValidator(schema: any): (val: any) => string[] | null {
  return (val: any) => {
    const errs: string[] = [];
    walk(schema, val, '', errs);
    return errs.length === 0 ? null : errs;
  };
}

function walk(schema: any, val: any, path: string, errs: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  const t = schema.type;
  if (t === 'object') {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      errs.push(`${path || '/'} expected object, got ${val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val}`);
      return;
    }
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in val) || val[r] === undefined || val[r] === null) {
          errs.push(`${path}/${r} required`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const k of Object.keys(schema.properties)) {
        if (k in val && val[k] !== undefined && val[k] !== null) {
          walk(schema.properties[k], val[k], `${path}/${k}`, errs);
        }
      }
    }
  } else if (t === 'array') {
    if (!Array.isArray(val)) { errs.push(`${path} expected array`); return; }
    if (schema.items) for (let i = 0; i < val.length; i++) walk(schema.items, val[i], `${path}[${i}]`, errs);
  } else if (t === 'string') {
    if (typeof val !== 'string') errs.push(`${path} expected string`);
  } else if (t === 'number' || t === 'integer') {
    if (typeof val !== 'number') errs.push(`${path} expected number`);
    else if (t === 'integer' && !Number.isInteger(val)) errs.push(`${path} expected integer`);
  } else if (t === 'boolean') {
    if (typeof val !== 'boolean') errs.push(`${path} expected boolean`);
  }
}

const validatorCache = new Map<string, (v: any) => string[] | null>();

export interface ActionDefinitionRecord {
  id: string;
  type: string;
  displayName: string;
  description: string;
  schema: Record<string, unknown>;
  handlerModule: string;
  handlerFunction: string;
  previewTemplate: string | null;
  requiresCapability: string | null;
  isHumanFacing: boolean;
  isActive: boolean;
  scope: 'system' | 'tenant' | 'user';
  source: 'seeded' | 'user_proposed' | 'system';
  approvedAt: Date | null;
  /** E3/E5 tenant defense-in-depth: null = system/global action visible
   *  to every tenant; non-null pins the action to one tenant. */
  clientNumber: string | null;
  updatedAt: Date;
}

/** E3/E5 tenant filter for action_definitions reads. NULL rows must
 *  always pass: they are the seeded system actions every tenant uses
 *  (and any pre-backfill stragglers). Only rows explicitly tagged with
 *  a DIFFERENT tenant are excluded. When the caller has no tenant
 *  context (clientNumber undefined) we apply no filter — identical to
 *  pre-E3 behavior, so legacy call sites keep working unchanged. */
function tenantWhere(clientNumber?: string): Record<string, unknown> {
  return clientNumber
    ? { OR: [{ clientNumber: null }, { clientNumber }] }
    : {};
}

/** Look up an action definition by type. Returns null when not
 *  registered or inactive. Used by the generic dispatcher to route
 *  incoming actions. Pass the caller's clientNumber so tenant-pinned
 *  actions of OTHER tenants stay invisible (system rows always match). */
export async function getActionDefinition(type: string, clientNumber?: string): Promise<ActionDefinitionRecord | null> {
  const row = await (prisma as any).actionDefinition.findFirst({
    where: { type, isActive: true, ...tenantWhere(clientNumber) },
  });
  return row ? toRecord(row) : null;
}

/** List all active action definitions. Used by the composer to
 *  enumerate Brain's current capabilities and by Settings UI. With a
 *  clientNumber, another tenant's custom actions are filtered out;
 *  without one, behavior is unchanged (system + everything, legacy). */
export async function listActiveActions(
  scope?: 'system' | 'tenant' | 'user',
  clientNumber?: string,
): Promise<ActionDefinitionRecord[]> {
  const rows = await (prisma as any).actionDefinition.findMany({
    where: { isActive: true, ...(scope ? { scope } : {}), ...tenantWhere(clientNumber) },
    orderBy: { type: 'asc' },
  });
  return rows.map(toRecord);
}

/** Validate an action payload against its registered schema. Returns
 *  null on success; array of error messages on failure. The generic
 *  dispatcher calls this before invoking the handler. */
export function validateActionPayload(
  def: ActionDefinitionRecord,
  payload: unknown,
): string[] | null {
  let validate = validatorCache.get(def.type);
  if (!validate) {
    validate = compileValidator(def.schema);
    validatorCache.set(def.type, validate);
  }
  return validate(payload);
}

/** Register a new action definition. For user-proposed actions, leaves
 *  approvedAt=null so dispatch is blocked until user confirms. */
export async function registerAction(args: {
  type: string;
  displayName: string;
  description: string;
  schema: Record<string, unknown>;
  handlerModule: string;
  handlerFunction: string;
  previewTemplate?: string | null;
  requiresCapability?: string | null;
  isHumanFacing?: boolean;
  scope?: 'system' | 'tenant' | 'user';
  source?: 'seeded' | 'user_proposed' | 'system';
  preApproved?: boolean;
  /** E3/E5: tenant owning this action. Omit / null for system-global
   *  actions (the seeder passes nothing — seeded verbs serve everyone).
   *  User-proposed actions SHOULD pass the proposer's tenant so they
   *  never surface in another tenant's registry. */
  clientNumber?: string | null;
}): Promise<ActionDefinitionRecord> {
  // Upsert by type — re-running the seeder is idempotent.
  const row = await (prisma as any).actionDefinition.upsert({
    where: { type: args.type },
    create: {
      type: args.type,
      displayName: args.displayName,
      description: args.description,
      schema: args.schema as any,
      handlerModule: args.handlerModule,
      handlerFunction: args.handlerFunction,
      previewTemplate: args.previewTemplate ?? null,
      requiresCapability: args.requiresCapability ?? null,
      isHumanFacing: !!args.isHumanFacing,
      scope: args.scope ?? 'system',
      source: args.source ?? 'seeded',
      approvedAt: args.preApproved ? new Date() : null,
      clientNumber: args.clientNumber ?? null,
    },
    update: {
      displayName: args.displayName,
      description: args.description,
      schema: args.schema as any,
      handlerModule: args.handlerModule,
      handlerFunction: args.handlerFunction,
      previewTemplate: args.previewTemplate ?? null,
      requiresCapability: args.requiresCapability ?? null,
      isHumanFacing: !!args.isHumanFacing,
      scope: args.scope ?? 'system',
      source: args.source ?? 'seeded',
      approvedAt: args.preApproved ? new Date() : undefined,
      // Re-running the seeder must not accidentally re-tag a row: the
      // seeder always passes nothing, and null IS the seeder's intent
      // (system-global), so persisting the ?? null here is correct.
      clientNumber: args.clientNumber ?? null,
    },
  });
  validatorCache.delete(args.type);
  return toRecord(row);
}

/** Approve a previously-proposed action. Settings UI hook. */
export async function approveAction(type: string): Promise<void> {
  await (prisma as any).actionDefinition.update({
    where: { type },
    data: { approvedAt: new Date() },
  });
}

/** Disable an action (kill switch). */
export async function deactivateAction(type: string): Promise<void> {
  await (prisma as any).actionDefinition.update({
    where: { type },
    data: { isActive: false },
  });
}

function toRecord(row: any): ActionDefinitionRecord {
  return {
    id: row.id,
    type: row.type,
    displayName: row.displayName,
    description: row.description,
    schema: row.schema as Record<string, unknown>,
    handlerModule: row.handlerModule,
    handlerFunction: row.handlerFunction,
    previewTemplate: row.previewTemplate ?? null,
    requiresCapability: row.requiresCapability ?? null,
    isHumanFacing: row.isHumanFacing,
    isActive: row.isActive,
    scope: row.scope,
    source: row.source,
    approvedAt: row.approvedAt ?? null,
    clientNumber: row.clientNumber ?? null,
    updatedAt: row.updatedAt,
  };
}
