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
import { renderToolCatalogue, executeBrainTool, BRAIN_TOOLS } from './brainTools';
import type { ComposerHistoryTurn } from './brainComposer';

export type ReasoningDecision = 'act' | 'ask' | 'answer' | 'decline' | 'tool_call';

/** Max sequential tool calls per turn. Reasoning that keeps requesting
 *  data without converging gets forced into a final answer with
 *  whatever was collected. Prevents runaway loops + budget blowouts. */
const MAX_TOOL_ITERATIONS = 3;

/** Tool invocation emitted by reasoning. The orchestrator executes
 *  the named tool, appends its output as a new dataBlock, and re-calls
 *  reasoning. Loops up to MAX_TOOL_ITERATIONS. */
export interface ReasoningToolCall {
  name: string;
  input: Record<string, unknown>;
  rationale?: string;
}

export interface ReasoningResult {
  decision: ReasoningDecision;
  toolCall?: ReasoningToolCall | null;
  /** Single-action emission (legacy/simple case). When the user says
   *  "add open item X" reasoning emits ONE action here and actionPlan
   *  stays empty. */
  action?: { type: string; payload: Record<string, unknown> } | null;
  /** Multi-action emission (2026-05-23). When the user says "create
   *  open item X AND delegate to Yousuf" reasoning emits a sequence
   *  here. Dispatcher runs them in order; stops on first failure
   *  (subsequent steps may depend on the previous succeeding).
   *  Each step can reference outputs from prior steps via
   *  `{previousStepArtifact}` template strings the dispatcher resolves. */
  actionPlan?: Array<{
    type: string;
    payload: Record<string, unknown>;
    description?: string;
    /** When true, subsequent steps still run even if this one fails. */
    optional?: boolean;
  }> | null;
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
    // 2026-05-25 — added so reasoning has actual recent inbox/WA data
    // instead of bridging gaps with fabrication (the Naveed "Ok sir"
    // failure). Each block lists real feed_events; if empty, reasoning
    // MUST say "no recent <X>" rather than inventing one.
    recentEmails?: string;
    recentWhatsApp?: string;
    contactProvenance?: string;   // origin trail for a specific contact
    // 2026-05-25 — canonical Day Brief data. When this is present, the
    // composer should NOT also inject openItems/calendar/recentEmails/
    // recentWhatsApp separately (the brief contains them all in a
    // single coherent block matching the Page surface byte-for-byte).
    // Reasoning is required to narrate IN ORDER, no re-ranking,
    // no drops, no additions.
    dayBrief?: string;
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

- **tool_call**: you need to fetch DATA (calendar / emails / WhatsApp thread / sent items / contact info / user profile / tenant users / open items by filter / recent messages) to ground your answer. Emit a tool_call. The orchestrator runs the tool and feeds the result back; you'll re-decide with real data. Use this BEFORE answer/act whenever the user's question references data you don't see in the existing dataBlocks. NEVER fabricate when you could tool_call instead.
- **act**: you have enough context to perform a structured action right now (one of the action types in the registry below). Emit the action JSON with payload that validates against its schema.
- **ask**: you need ONE specific piece of information from the user before you can act. Emit a clarifying question naming exactly what's missing. The question SHOULD include the actual options when there are 2-3 candidates (e.g., "Which Asad — Asad Ahmed Taj or Asad Shafique?"). Avoid open-ended questions when constrained ones work.
- **answer**: the user asked a question rather than requesting an action; just answer from the context.
- **decline**: the user asked for something genuinely impossible or unsafe (no capability, no integration, would violate policy). Decline honestly and offer the closest legitimate alternative.

Output strictly this JSON shape — no prose outside the object, no markdown fencing:

{
  "decision": "tool_call" | "act" | "ask" | "answer" | "decline",
  "tool_call": { "name": "<tool name>", "input": { ... }, "rationale": "<why this tool, one line>" } | null,
  "action": { "type": "<one of the registry types>", "payload": { ... } } | null,
  "action_plan": [
    { "type": "<registry type>", "payload": { ... }, "description": "<one-line>", "optional": false },
    ...
  ] | null,
  "question": { "text": "<the clarifying question>", "slotBeingFilled": "<canonical slot name>", "contextTokens": ["<tokens that identify what we're resolving>"] } | null,
  "answer_text": "<the user-visible reply>" | null,
  "decline_reason": "<one-line honest reason>" | null,
  "confidence": <0..1>,
  "rationale": "<one short sentence on how you decided>"
}

Rules:
- Exactly ONE of {action, action_plan, question, answer_text, decline_reason} is non-null, matching decision.
- Use action for single-step asks. Use action_plan ONLY when the user asked for multiple steps in one turn ("create open item AND delegate to Yousuf AND email him") AND each step is independently emissible. Steps run sequentially; later steps can reference {previousStepArtifact} in their payload (the dispatcher resolves).
- For action / action_plan: every payload MUST validate against the registry schema (required fields present, types correct).
- For ask: slotBeingFilled is a canonical name like "which_contact", "due_date", "which_thread"; contextTokens are stable identifiers future similar turns can match against (e.g., person name + topic + action_kind).
- Confidence: how sure you are about the decision. <0.5 → consider switching to ask.
- If you can't complete a plan step (e.g., recipient not in candidates), emit decision='ask' for the missing piece instead of guessing.

# Anti-fabrication rules (load-bearing — violating these = wrong action by Brain)

- When the user asks about a SPECIFIC message ("latest WhatsApp message", "what email came in", "any reply from X"), you may ONLY cite from the relevant dataBlock above (# Recent WhatsApp messages, # Recent emails). If the block is absent or empty, your answer MUST be one of:
  - "I don't see any <channel> messages in the last 24h." (when the block exists and is empty)
  - "I wasn't given <channel> data for this turn — I can check if you ask again." (when the block is absent)
  NEVER invent a sender, message body, or timestamp. NEVER bridge from a contact's existence to "they sent a message".
- When the user asks "where did X come from" / "why is X in my contacts", you may ONLY cite from the # Where this contact came from block. If absent, say "I don't have provenance info for this contact." Do NOT guess origin ("you probably emailed them"); do NOT confuse "contact exists" with "user corresponded with them".
- When the user names a person you don't see in the candidates block, say "I don't see <name> in your contacts" and stop. Do NOT pick the closest-sounding name and pretend it matched.
- When the user asks for a Day Brief and a relevant block (calendar / emails / WhatsApp / open items / attention) is empty, say so per channel — "no meetings today", "no new emails", etc. Do NOT collapse the whole brief to "I don't have access" when only some sources are empty.

# Exclusion-suggestion rule (locked per Basit 2026-05-25)

NEVER offer to "mark as inactive", "block this contact", "add to exclusion", "ignore messages from this person", or any variant. The exclusion list is user-managed; Brain provides only neutral provenance and observations. If a user says they don't recognize a contact, your answer reports what you know (provenance block, channels seen on) and stops — no suggested action.

# Tool catalogue (use these to FETCH data — read-only)

You may emit decision='tool_call' to retrieve data you don't see in the existing dataBlocks. The orchestrator will run the tool and call you again with the result. Tools are READ-ONLY — for any mutation use the action registry below.

When to tool_call:
- "any meetings tomorrow / this week" → fetch_calendar
- "any email from <X>" / "did <X> reply" → fetch_emails (with from=<X>)
- "what did I send <X>" / "did I email <X>" → fetch_sent_emails
- "what did <X> say last on WhatsApp" → fetch_whatsapp_thread
- "who is <X>" / "tell me about <X>" → fetch_contact_full
- "what's my phone / WhatsApp number" → fetch_user_profile
- "anything new" / "latest activity" → fetch_recent_messages
- "what items are due this week" → fetch_open_items (with filters)
- "who else is on Brain" / "who can I delegate to" → fetch_tenant_users

Limits: at most ${MAX_TOOL_ITERATIONS} tool calls per turn. After that, answer with whatever was collected. If a tool returns "(no … found)", report that truthfully — don't tool_call again hoping for different data.

${renderToolCatalogue()}

# Action registry (the only types you can emit for WRITES)

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
  // Day Brief is comprehensive — when present, it supersedes the
  // individual openItems/calendar/recentEmails/recentWhatsApp blocks
  // so the chat narration matches the Page surface exactly.
  if (input.dataBlocks.dayBrief) {
    parts.push(input.dataBlocks.dayBrief);
  } else {
    if (input.dataBlocks.openItems) parts.push(input.dataBlocks.openItems);
    if (input.dataBlocks.todayCalendar) parts.push(input.dataBlocks.todayCalendar);
    if (input.dataBlocks.recentEmails) parts.push(input.dataBlocks.recentEmails);
    if (input.dataBlocks.recentWhatsApp) parts.push(input.dataBlocks.recentWhatsApp);
  }
  if (input.dataBlocks.contactProvenance) parts.push(input.dataBlocks.contactProvenance);
  if (input.dataBlocks.artifacts) parts.push(input.dataBlocks.artifacts);
  if (input.dataBlocks.replyContext) parts.push(input.dataBlocks.replyContext);
  return parts.join('\n\n');
}

function parseReasoningOutput(raw: string): ReasoningResult | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const obj = JSON.parse(cleaned);
    const decision = String(obj.decision ?? '').toLowerCase();
    if (!['tool_call', 'act', 'ask', 'answer', 'decline'].includes(decision)) return null;
    const actionPlan = Array.isArray(obj.action_plan)
      ? obj.action_plan
          .filter((s: any) => s && typeof s.type === 'string' && s.payload && typeof s.payload === 'object')
          .map((s: any) => ({
            type: s.type,
            payload: s.payload,
            description: typeof s.description === 'string' ? s.description : undefined,
            optional: !!s.optional,
          }))
      : null;
    const toolCall = (obj.tool_call && typeof obj.tool_call.name === 'string')
      ? {
          name: String(obj.tool_call.name),
          input: (obj.tool_call.input && typeof obj.tool_call.input === 'object') ? obj.tool_call.input : {},
          rationale: typeof obj.tool_call.rationale === 'string' ? obj.tool_call.rationale : undefined,
        }
      : null;
    return {
      decision: decision as ReasoningDecision,
      toolCall,
      action: obj.action ?? null,
      actionPlan: actionPlan && actionPlan.length > 0 ? actionPlan : null,
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

/**
 * Wrapper around reasoningCompose that resolves any decision='tool_call'
 * by executing the named tool and re-calling reasoning with the result
 * appended as a new dataBlock. Loops up to MAX_TOOL_ITERATIONS.
 *
 * Returns the FINAL non-tool_call result (act/ask/answer/decline). If
 * reasoning keeps returning tool_calls past the limit, the final call
 * is made with a "no more tool calls — answer with what you have"
 * instruction and the result returned.
 *
 * Trace: every tool call is logged with name, input, byte size of
 * result, and elapsed ms.
 */
export async function reasoningComposeWithTools(input: ReasoningInput): Promise<ReasoningResult | null> {
  // Tool-call results accumulate into a private dataBlock slot so the
  // model sees them on the next iteration. We DON'T mutate the caller's
  // dataBlocks object — keep the function pure.
  let collected: string[] = [];
  let workingInput: ReasoningInput = input;

  for (let i = 0; i < MAX_TOOL_ITERATIONS + 1; i += 1) {
    const isFinal = i === MAX_TOOL_ITERATIONS;
    // On the final pass, blank out the tool catalogue so reasoning
    // can't keep emitting tool_calls. Easiest way: append a sentinel
    // to artifacts that the model can read.
    const blocksForThisPass: ReasoningInput['dataBlocks'] = { ...workingInput.dataBlocks };
    if (collected.length > 0) {
      const prev = blocksForThisPass.artifacts ?? '';
      blocksForThisPass.artifacts = `${prev}${prev ? '\n\n' : ''}# Tool call results (from prior steps this turn)\n${collected.join('\n\n')}`;
    }
    if (isFinal) {
      blocksForThisPass.artifacts = `${blocksForThisPass.artifacts ?? ''}\n\n# NO MORE TOOL CALLS\nYou've used the maximum of ${MAX_TOOL_ITERATIONS} tool calls this turn. Answer with the data you have — even if incomplete, report truthfully what you found and what's missing.`;
    }

    const result = await reasoningCompose({ ...workingInput, dataBlocks: blocksForThisPass });
    if (!result) return null;

    if (result.decision !== 'tool_call') {
      // Final answer — bubble up.
      if (collected.length > 0) {
        console.info('[reasoning.tools] loop ended', {
          userId: input.userId, iterations: i, finalDecision: result.decision,
        });
      }
      return result;
    }

    // Execute the tool call.
    if (isFinal || !result.toolCall) {
      // Reasoning emitted tool_call past the iteration cap OR no tool
      // specified. Don't fabricate a Brain reply — return null so the
      // caller falls through to the legacy composer (which will retry
      // the turn with the full context) OR surface a bracketed system
      // marker. We return null here because the upstream composer
      // already has a legacy fallback that produces a real LLM-generated
      // answer; we never want a hardcoded English sentence pretending
      // to be Brain. Per feedback_no_hardcoded_brain_replies.md.
      console.warn('[reasoning.tools] reasoning failed to converge — falling back to legacy composer', {
        userId: input.userId, iterations: i, lastDecision: result.decision,
        lastToolName: result.toolCall?.name,
      });
      return null;
    }

    const t0 = Date.now();
    const out = await executeBrainTool(
      result.toolCall.name,
      result.toolCall.input,
      { userId: input.userId, clientNumber: input.clientNumber },
    );
    const elapsed = Date.now() - t0;
    console.info('[reasoning.tools] tool ran', {
      userId: input.userId,
      tool: result.toolCall.name,
      inputKeys: Object.keys(result.toolCall.input ?? {}),
      outputBytes: out.length,
      elapsedMs: elapsed,
      rationale: result.toolCall.rationale,
    });
    collected.push(out);
  }
  // Unreachable in practice but TypeScript needs it.
  return null;
}
