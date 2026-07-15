/**
 * brainCapabilityLive — live capability discovery (hardening audit
 * 2026-07-14, item #2).
 *
 * The old brainCapabilityRegistry hand-listed what Brain "can" do and
 * drifted from reality twice (2026-07-07 "I can't add contacts";
 * 2026-07-13 "I can't update a contact's email" — commit 59b63da was
 * prompt-text-only and the class RECURRED). This module generates the
 * CAN side of the truth-table from the systems that actually dispatch:
 *
 *   actionDefinition rows (active + approved, tenant-scoped)
 *     ∩ a real dispatch path (generic dispatcher allow-list OR the
 *       composer's COMPOSER_DISPATCHED_TYPES)
 *     × connector availability for the action's required connector
 *
 * Fail closed at every level: an action with no live handler is
 * UNSUPPORTED even if a row claims it; an unapproved row is
 * approval_required; a dead connector demotes to connector_unavailable
 * (Brain must say "temporarily unavailable — reconnect X", never
 * promise the send). If discovery itself fails, the rendered block
 * contains only the deterministic limitations plus an instruction to
 * verify before promising — never a stale CAN list.
 *
 * The deterministic CANNOT list (SMS, speaking as the user, bulk
 * blasts, …) stays hand-written in brainCapabilityRegistry — those are
 * safety policy, not wiring, and must not be generated.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { listActiveActions, type ActionDefinitionRecord } from './actionRegistryService';
import { isHandlerRegistered } from './genericActionDispatcher';
import { COMPOSER_DISPATCHED_TYPES } from './brainComposer';
import { listLimitations, CAPABILITY_HINTS, NON_ACTION_CAPABILITIES } from './brainCapabilityRegistry';
import { isConnectorHealthy } from '../connectorHealthService';

const log = createLogger('capability-live');

export type CapabilityState =
  | 'available'              // supported and ready right now
  | 'connector_unavailable'  // supported, but its connector is down/not connected
  | 'approval_required'      // registered but awaiting admin approval / capability grant
  | 'unsupported';           // no live dispatch path — never claim it

export interface LiveCapability {
  type: string;
  state: CapabilityState;
  label: string;
  what: string;
  /** For non-available states: one honest line Brain can relay. */
  reason?: string;
}

/** #7 rework (2026-07-14): operational requirements live IN the action
 *  registry (actionDefinition.operationalMetadata, seeded alongside
 *  the handler pointer) — the same source of truth that drives
 *  dispatch. A new action with complete metadata needs NO edit here.
 *
 *  LEGACY_OPERATIONAL is a transition fallback ONLY: rows written
 *  before the operational_metadata column existed (pre-migration /
 *  pre-reseed) fall back to these known requirements with a warning.
 *  An UNKNOWN type with no metadata fails closed to 'unsupported'. */
const LEGACY_OPERATIONAL: Record<string, { external: boolean; connectors?: { anyOf: string[] } }> = {
  send_email: { external: true, connectors: { anyOf: ['gmail', 'smtp'] } },
  schedule_meeting: { external: true, connectors: { anyOf: ['google_calendar'] } },
  cancel_meeting: { external: true, connectors: { anyOf: ['google_calendar'] } },
  reschedule_meeting: { external: true, connectors: { anyOf: ['google_calendar'] } },
  notify_via_whatsapp: { external: true, connectors: { anyOf: ['tenant_whatsapp'] } },
  add_open_item: { external: false }, update_open_item: { external: false },
  mark_open_item_done: { external: false }, delegate_open_item: { external: false },
  set_brain_name: { external: false }, set_contact_scope: { external: false },
  mark_contact_inactive: { external: false }, update_contact: { external: false },
  archive_wiki_page: { external: false }, delete_wiki_page: { external: false },
  record_preference: { external: false },
};

export interface ClassifyInput {
  def: Pick<ActionDefinitionRecord, 'type' | 'isActive' | 'approvedAt' | 'handlerModule' | 'handlerFunction' | 'operationalMetadata'>;
  /** Healthy provider ids available to this user right now: connector
   *  slugs with isConnectorHealthy === true, plus pseudo-providers
   *  'smtp' (platform fallback configured) and 'tenant_whatsapp'
   *  (tenant Meta notifier active). */
  availableProviders: ReadonlySet<string>;
}

/** Pure classification — exported for tests. */
export function classifyCapability(input: ClassifyInput): CapabilityState {
  const { def, availableProviders } = input;
  const dispatchable =
    isHandlerRegistered(def.handlerModule, def.handlerFunction) ||
    COMPOSER_DISPATCHED_TYPES.has(def.type);
  if (!def.isActive || !dispatchable) return 'unsupported';
  if (!def.approvedAt) return 'approval_required';

  const meta = def.operationalMetadata ?? LEGACY_OPERATIONAL[def.type] ?? null;
  if (!def.operationalMetadata && LEGACY_OPERATIONAL[def.type]) {
    log.warn('actionDefinition missing operational_metadata — using legacy fallback; re-run seedActionDefinitions', { type: def.type });
  }
  // Fail closed: an action whose operational requirements are UNKNOWN
  // must never be advertised as available.
  if (!meta) return 'unsupported';

  const anyOf = meta.connectors?.anyOf ?? [];
  if (anyOf.length > 0 && !anyOf.some((p) => availableProviders.has(p))) {
    return 'connector_unavailable';
  }
  return 'available';
}

function describe(type: string): { label: string; what: string } {
  return CAPABILITY_HINTS[type] ?? { label: type.replace(/_/g, ' '), what: '' };
}

function reasonFor(state: CapabilityState, def: { type: string; operationalMetadata?: any }): string | undefined {
  if (state === 'connector_unavailable') {
    const anyOf: string[] = (def.operationalMetadata ?? LEGACY_OPERATIONAL[def.type])?.connectors?.anyOf ?? [];
    const need = anyOf.length > 0 ? anyOf.join(' or ') : 'a required connector';
    return `temporarily unavailable — needs a healthy ${need} connection; offer to reconnect it, do NOT promise the action`;
  }
  if (state === 'approval_required') return 'registered but awaiting approval — say it needs enabling, do not attempt it';
  return undefined;
}

/** Discover the user's live capabilities. Tenant-scoped: system-global
 *  definitions plus THIS tenant's pinned ones only (another tenant's
 *  custom actions can never leak into this prompt). */
export async function getLiveCapabilities(clientNumber: string, userId: number): Promise<LiveCapability[]> {
  const [defs, connectors, waNotifier, smtpOk] = await Promise.all([
    listActiveActions(undefined, clientNumber),
    prisma.userConnector.findMany({
      where: { userId, clientNumber },
      select: { status: true, connectorType: { select: { slug: true } } },
    }).catch(() => [] as any[]),
    prisma.tenantWhatsappNotifier.findUnique({
      where: { clientNumber },
      select: { isActive: true },
    }).catch(() => null),
    import('../emailService').then((m) => m.smtpConfigured()).catch(() => false),
  ]);

  const availableProviders = new Set<string>(
    (connectors as any[])
      .filter((c) => isConnectorHealthy({ status: c.status }))
      .map((c) => c.connectorType?.slug)
      .filter(Boolean),
  );
  // Pseudo-providers: platform SMTP fallback + the tenant Meta notifier
  // (distinct from a user's PERSONAL whatsapp connector slug).
  if (smtpOk) availableProviders.add('smtp');
  if (waNotifier?.isActive) availableProviders.add('tenant_whatsapp');

  return defs.map((def) => {
    const state = classifyCapability({ def, availableProviders });
    const { label, what } = describe(def.type);
    return { type: def.type, state, label, what, reason: reasonFor(state, def) };
  });
}

// ── Prompt block (cached per user, 120s) ────────────────────────────

const blockCache = new Map<string, { block: string; at: number }>();
const BLOCK_TTL_MS = 120_000;

function limitationLines(): string {
  return listLimitations().map((l) => {
    const alt = l.offerInstead ? ` — offer instead: ${l.offerInstead}` : '';
    return `- ${l.label} (${l.why})${alt}`;
  }).join('\n');
}

/** The fail-closed block: no CAN claims at all. */
function conservativeBlock(): string {
  return `# Capability truth-table (LIVE LOOKUP FAILED — be conservative)

Capability discovery is temporarily unavailable. Do NOT claim any action is available; if the user asks for an action, say you'll attempt it and report the real outcome — never promise success in advance.

WHAT YOU CANNOT DO (hard limits — these never change):

${limitationLines()}`;
}

export async function renderCapabilityBlockLive(clientNumber: string, userId: number): Promise<string> {
  const key = `${clientNumber}:${userId}`;
  const hit = blockCache.get(key);
  if (hit && Date.now() - hit.at < BLOCK_TTL_MS) return hit.block;

  let caps: LiveCapability[];
  try {
    caps = await getLiveCapabilities(clientNumber, userId);
    if (caps.length === 0) {
      // Empty registry = seeding hasn't run; render fail-closed rather
      // than an empty CAN list that reads as "I can do nothing".
      log.warn('action registry returned 0 definitions — rendering conservative block', { clientNumber });
      return conservativeBlock();
    }
  } catch (e: any) {
    log.warn('live capability discovery failed — rendering conservative block', { clientNumber, error: e?.message });
    return conservativeBlock();
  }

  const avail = caps.filter((c) => c.state === 'available');
  const degraded = caps.filter((c) => c.state === 'connector_unavailable' || c.state === 'approval_required');

  const canLines = [
    ...avail.map((c) => `- ${c.label} → ${c.type}${c.what ? ` — ${c.what}` : ''}`),
    // Tool/REST-backed capabilities with no registry row (curated).
    ...NON_ACTION_CAPABILITIES.map((c) => `- ${c.label} → ${c.handle} — ${c.what}`),
  ].join('\n');
  const degradedLines = degraded.map((c) => `- ${c.label} (${c.reason})`).join('\n');

  const block = `# Capability truth-table (LIVE — generated from the action registry; never fabricate limitations or capabilities)

WHAT YOU CAN DO RIGHT NOW — if the user asks for one of these, DO IT. Never say "I can't do that yet" for anything on this list. If a required detail is missing (name, email, phone, time), ask for JUST that detail.

${canLines}
${degraded.length > 0 ? `
SUPPORTED BUT NOT AVAILABLE RIGHT NOW — say so honestly and offer the remedy; never promise these will succeed:

${degradedLines}
` : ''}
WHAT YOU CANNOT DO — say so plainly, and offer the closest supported alternative:

${limitationLines()}

For any user request that isn't clearly on either list, reason from first principles about which capability it maps to. Do NOT invent a new limitation. If genuinely unsure, ask a clarifying question rather than declining.`;

  blockCache.set(key, { block, at: Date.now() });
  return block;
}

/** Test/ops hook. */
export function clearCapabilityBlockCache(): void {
  blockCache.clear();
}
