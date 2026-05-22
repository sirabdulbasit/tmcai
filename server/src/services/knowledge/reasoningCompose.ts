/**
 * reasoningCompose — single-call reasoning composer.
 *
 * Phase 6 of the refactor (2026-05-22). Replaces the multi-call
 * dance (intent classifier + main compose + constrained
 * action-decider + post-guards) with ONE LLM call that gets the
 * full context and decides:
 *
 *   { decision: 'act' | 'ask' | 'answer' | 'decline',
 *     action?: { type, payload },
 *     question?: { text, slotBeingFilled, contextTokens },
 *     answer_text?: string,
 *     decline_reason?: string,
 *     confidence: number }
 *
 * Per Basit 2026-05-22: "i want brain to build itself, think and
 * analyze like a brain if not clear ask, and asking mean it is
 * learning, self building". The reasoning step decides whether
 * Brain has enough to act / answer, or needs to clarify. Asking
 * is the learning mechanism (clarification_memory persists the
 * resolution).
 *
 * This is OPT-IN initially — opts.useReasoning=true switches
 * compose() to this path. Once stable, becomes the default.
 *
 * What this DOES:
 *   - One LLM call (Gemini Pro) with structured JSON output.
 *   - Full context: history, persona, memories, recent emails (via
 *     pre-fetch when reply-intent detected by reasoning, not regex),
 *     pending action, candidates, artifacts, calendar.
 *   - Output validated against the action_definitions registry —
 *     unknown types or malformed payloads fail gracefully.
 *   - "ask" decisions write a clarification_memory row (Phase 7).
 *   - "act" decisions go through the same preview gate / idempotency
 *     wrapper / generic dispatcher as the legacy path.
 *
 * What this DOES NOT do:
 *   - Replace safety stack (preview, idempotency, validateBeforeRender,
 *     userScopeGuard — all stay).
 *   - Self-modify code (handler registry stays in code).
 */
import { callGemini } from '../geminiService';
import { listActiveActions, validateActionPayload, getActionDefinition } from './actionRegistryService';
import type { ComposerHistoryTurn } from './brainComposer';

export type ReasoningDecision = 'act' | 'ask' | 'answer' | 'decline';

export interface ReasoningResult {
  decision: ReasoningDecision;
  action?: { type: string; payload: Record<string, unknown> } | null;
  question?: {
    text: string;
    slotBeingFilled: string;
    contextTokens: string[];
  } | null;
  answerText?: string | null;
  declineReason?: string | null;
  confidence: number;
  rationale: string;
}

export interface ReasoningInput {
  userId: number;
  clientNumber: string;
  question: string;
  history: ComposerHistoryTurn[];
  channel: 'web' | 'whatsapp';
  systemPrompt: string;           // assembled by assembleSystemPrompt
  dataBlocks: {
    openItems?: string;
    todayCalendar?: string;
    candidates?: string;
    artifacts?: string;
    memories?: string;
    replyContext?: string;
    pendingAction?: string;       // serialized PendingAction summary if any
  };
}

/** Build the structured-output prompt + call Gemini. Returns the
 *  parsed decision or null on failure (caller falls back to legacy
 *  composer). */
export async function reasoningCompose(input: ReasoningInput): Promise<ReasoningResult | null> {
  // Enumerate the action types Brain can currently dispatch — these
  // come from action_definitions, the data-driven source of truth.
  const actions = await listActiveActions().catch(() => []);
  const actionsBlock = renderActionsBlock(actions);

  const systemPromptWithDecisionContract = `${input.systemPrompt}

# Reasoning decision contract (this turn)

Read the user's message + all the context above. Decide ONE of these:

- **act**: you have enough context to perform a structured action right now (one of the action types in the registry below). Emit the action JSON with payload that validates against its schema.
- **ask**: you need ONE specific piece of information from the user before you can act. Emit a clarifying question naming exactly what's missing. The question SHOULD include the actual options when there are 2-3 candidates (e.g., "Which Asad — Asad Ahmed Taj or Asad Shafique?"). Avoid open-ended questions when constrained ones work.
- **answer**: the user asked a question rather than requesting an action; just answer from the context.
- **decline**: the user asked for something genuinely impossible or unsafe (no capability, no integration, would violate policy). Decline honestly and offer the closest legitimate alternative.

Output strictly this JSON shape — no prose outside the object, no markdown fencing:

{
  "decision": "act" | "ask" | "answer" | "decline",
  "action": { "type": "<one of the registry types>", "payload": { ... } } | null,
  "question": { "text": "<the clarifying question>", "slotBeingFilled": "<canonical slot name>", "contextTokens": ["<tokens that identify what we're resolving>"] } | null,
  "answer_text": "<the user-visible reply>" | null,
  "decline_reason": "<one-line honest reason>" | null,
  "confidence": <0..1>,
  "rationale": "<one short sentence on how you decided>"
}

Rules:
- Exactly ONE of {action, question, answer_text, decline_reason} is non-null, matching decision.
- For action: payload MUST validate against the registry schema (required fields present, types correct).
- For ask: slotBeingFilled is a canonical name like "attendee_email", "due_date", "which_thread"; contextTokens are stable identifiers that future similar turns can match against (e.g., person name + topic + action_kind).
- Confidence: how sure you are about the decision. <0.5 → consider switching to ask.

# Action registry (the only types you can emit)

${actionsBlock}`;

  const userMessage = renderUserMessage(input);

  let raw: string;
  try {
    raw = await callGemini(systemPromptWithDecisionContract, userMessage, {
      maxTokens: 2048,
      flash: false, // Pro for full reasoning
      responseMimeType: 'application/json',
    });
  } catch (e: any) {
    console.warn('[reasoningCompose] LLM call failed', { userId: input.userId, error: e?.message });
    return null;
  }
  return parseReasoningOutput(raw);
}

// ─── Internal ────────────────────────────────────────────────────

function renderActionsBlock(actions: any[]): string {
  if (actions.length === 0) return '(no actions registered — decline action requests honestly)';
  const lines: string[] = [];
  for (const a of actions) {
    lines.push(`- **${a.type}**: ${a.description}`);
    const required = Array.isArray(a.schema?.required) ? a.schema.required : [];
    const props = a.schema?.properties ?? {};
    const slotLines = Object.keys(props).map((k) => {
      const isReq = required.includes(k);
      const t = (props as any)[k]?.type ?? 'any';
      return `    - ${k}${isReq ? ' (required)' : ''}: ${t}`;
    });
    if (slotLines.length > 0) lines.push(...slotLines);
  }
  return lines.join('\n');
}

function renderUserMessage(input: ReasoningInput): string {
  const parts: string[] = [];
  // Today's date + the user's timezone — needed so reasoning can
  // resolve relative phrases ("monday", "tomorrow at 6pm", "next
  // friday") to absolute ISO strings before emitting the action.
  // Without this anchor, reasoning has emitted literal "next Monday"
  // as the dueDate value, which downstream parsers reject.
  const nowIso = new Date().toISOString();
  const todayPkt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10); // default PKT
  parts.push(`Today (UTC): ${nowIso}\nToday (Asia/Karachi local date): ${todayPkt}\nUser timezone: Asia/Karachi (+05:00) unless the user's profile says otherwise.\nWhen emitting date/datetime fields, ALWAYS resolve relative phrases ("monday", "tomorrow", "next friday", "today 6pm") to absolute ISO 8601 using this anchor.`);
  parts.push(`User's current message: ${input.question}`);
  if (input.history.length > 0) {
    const recent = input.history.slice(-8).map((h) => {
      if (h.role === 'artifact') {
        try { return `[artifact] ${JSON.parse(h.text).summary ?? h.text}`; } catch { return `[artifact] ${h.text}`; }
      }
      return `[${h.role}] ${h.text.slice(0, 400)}`;
    });
    parts.push(`Recent conversation:\n${recent.join('\n')}`);
  }
  if (input.dataBlocks.pendingAction) parts.push(`Pending action: ${input.dataBlocks.pendingAction}`);
  if (input.dataBlocks.memories) parts.push(input.dataBlocks.memories);
  if (input.dataBlocks.candidates) parts.push(input.dataBlocks.candidates);
  if (input.dataBlocks.openItems) parts.push(input.dataBlocks.openItems);
  if (input.dataBlocks.todayCalendar) parts.push(input.dataBlocks.todayCalendar);
  if (input.dataBlocks.artifacts) parts.push(input.dataBlocks.artifacts);
  if (input.dataBlocks.replyContext) parts.push(input.dataBlocks.replyContext);
  return parts.join('\n\n');
}

function parseReasoningOutput(raw: string): ReasoningResult | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const obj = JSON.parse(cleaned);
    const decision = String(obj.decision ?? '').toLowerCase();
    if (!['act', 'ask', 'answer', 'decline'].includes(decision)) return null;
    return {
      decision: decision as ReasoningDecision,
      action: obj.action ?? null,
      question: obj.question ?? null,
      answerText: obj.answer_text ?? null,
      declineReason: obj.decline_reason ?? null,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    };
  } catch (e: any) {
    console.warn('[reasoningCompose] parse failed', { error: e?.message, head: raw.slice(0, 200) });
    return null;
  }
}

/** Validate that the reasoning step's emitted action matches the
 *  action_definitions registry. Returns array of validation errors
 *  or null on success. */
export async function validateReasoningAction(
  action: { type: string; payload: Record<string, unknown> },
): Promise<string[] | null> {
  const def = await getActionDefinition(action.type);
  if (!def) return [`Unknown action type: ${action.type}`];
  return validateActionPayload(def, action.payload);
}
