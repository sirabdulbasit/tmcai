/**
 * agenticReader — read-only multi-step research agent.
 *
 * Quality Sprint 4 (2026-05-21). Closes the "Brain can't chain
 * reasoning across multiple data sources in one turn" gap.
 *
 * When the user asks a multi-step question — "what's my morning
 * tomorrow look like and who's chasing me on Phoenix?" / "check if
 * Asad is free Friday and remind me what's open with him" —
 * agenticReader iterates: pick a tool, call it, read result, pick
 * the next tool, etc., up to a bounded budget. The final response
 * is synthesized text only.
 *
 * Safety boundary:
 *   - Tools are READ-ONLY by definition. No tool here can send
 *     email, create calendar events, modify items, or change state.
 *   - For ACTIONS the user wants taken on the research findings,
 *     the conversation continues — the user's NEXT turn ("now email
 *     Asad about the Friday slot") runs through the linear-with-
 *     safety composer, which fires the preview gate and idempotency
 *     as normal.
 *   - This preserves: preview-by-default, validateBeforeRender,
 *     idempotency, empty-promise guard. None of the safety stack
 *     is bypassed because no write happens here.
 *
 * Bounded by:
 *   - 5 tool calls max per turn (prevents runaway tool-loops)
 *   - 30s total wall time (prevents hung calls)
 *   - 6000 max output tokens across the loop
 *
 * Falls through to linear composer on any error or budget overrun
 * — the user always gets an answer, even if it's the linear one.
 */
import { getGenAI } from '../genaiClient';
import { MODEL_GEMINI } from '../../config/models';

export interface AgenticReaderInput {
  question: string;
  userId: number;
  clientNumber: string;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'brain'; text: string }>;
}

export interface AgenticReaderResult {
  answer: string;
  toolCallsExecuted: number;
  toolsUsed: string[];
  budgetExceeded: boolean;
}

const MAX_TOOL_CALLS = 5;
const WALL_TIME_BUDGET_MS = 30_000;
const MAX_OUTPUT_TOKENS = 6000;

/** Tool definitions exposed to Gemini's function-calling layer.
 *  Each maps to a handler in TOOL_HANDLERS. */
const TOOL_DECLARATIONS = [
  {
    name: 'get_open_items',
    description: 'List the user\'s active open items (things they need to follow up on). Returns title, status, priority, due date, and delegatee (if any).',
    parameters: {
      type: 'object',
      properties: {
        priority_filter: {
          type: 'string',
          description: 'Optional: "high" / "medium" / "low" to filter by priority.',
        },
        status_filter: {
          type: 'string',
          description: 'Optional: "NEW" / "WORKING" / "DELEGATED" / "WAITING" — defaults to all active.',
        },
        limit: {
          type: 'integer',
          description: 'Max items to return (default 15).',
        },
      },
    },
  },
  {
    name: 'get_calendar_events',
    description: 'List the user\'s calendar events within a date window. Use this to check availability or summarize the day.',
    parameters: {
      type: 'object',
      properties: {
        day_offset_start: {
          type: 'integer',
          description: 'Day offset from today for the window start (0=today, 1=tomorrow, -1=yesterday).',
        },
        day_offset_end: {
          type: 'integer',
          description: 'Day offset from today for the window end (inclusive). Same value as start = single day.',
        },
      },
      required: ['day_offset_start', 'day_offset_end'],
    },
  },
  {
    name: 'search_recent_emails',
    description: 'Search the user\'s recent inbox for emails matching keywords or a sender name. Returns subject, sender, snippet, date.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords or a person\'s name. Required.',
        },
        limit: {
          type: 'integer',
          description: 'Max results (default 10).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'resolve_contact',
    description: 'Look up a contact by name, returning resolved email, phone, and confidence. Uses the alias memory layer.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name fragment to resolve (e.g., "Asad").',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_attention_surface',
    description: 'Get what is currently competing for the user\'s attention right now — high-priority emails, urgent WhatsApp threads, near-due open items. Use when the user asks "what should I focus on?" or "what\'s urgent?".',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

/** Tool implementations. All call existing services; no new write paths. */
const TOOL_HANDLERS: Record<string, (args: any, ctx: { userId: number; clientNumber: string }) => Promise<unknown>> = {
  async get_open_items(args, ctx) {
    const { listItems } = await import('../openItemsService');
    const items = await listItems(ctx.userId, ctx.clientNumber, {
      priority: args.priority_filter ? [args.priority_filter] : undefined,
      status: args.status_filter ? [args.status_filter] : undefined,
      excludeSmoke: false,
      limit: Math.min(50, args.limit ?? 15),
    });
    return items.map((i: any) => ({
      id: i.id,
      title: i.title,
      priority: i.priority,
      status: i.status,
      dueDate: i.dueDate?.toISOString?.().slice(0, 10) ?? null,
      delegatee: i.delegateeName ?? null,
    }));
  },
  async get_calendar_events(args, ctx) {
    const { getEvents } = await import('../calendarService');
    const startOffset = Number(args.day_offset_start ?? 0);
    const endOffset = Number(args.day_offset_end ?? startOffset);
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() + startOffset);
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    endDate.setDate(endDate.getDate() + endOffset);
    const r = await getEvents(ctx.userId, startDate, endDate, 30);
    if (r.error) return { error: r.error, events: [] };
    return r.events.map((e: any) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      attendees: e.attendees ?? [],
      location: e.location ?? null,
    }));
  },
  async search_recent_emails(args, ctx) {
    const { searchEmails } = await import('../gmailService');
    const limit = Math.min(20, args.limit ?? 10);
    const r = await searchEmails(ctx.userId, String(args.query ?? ''), limit);
    if (r.error) return { error: r.error, results: [] };
    return (r.emails ?? []).map((m: any) => ({
      subject: m.subject,
      from: m.from,
      snippet: m.snippet,
      date: m.date,
      id: m.id,
    }));
  },
  async resolve_contact(args, ctx) {
    const { resolveContact } = await import('./contactResolver');
    const candidates = await resolveContact(String(args.name ?? ''), {
      clientNumber: ctx.clientNumber, userId: ctx.userId, limit: 5,
    });
    return candidates.map((c: any) => ({
      displayName: c.displayName,
      email: c.email,
      relationship: c.relationship,
      score: c.score,
      reasons: c.signals.reasons,
    }));
  },
  async get_attention_surface(_args, ctx) {
    try {
      const { getAttentionSurface } = await import('../views/attention');
      const surface = await getAttentionSurface({ clientNumber: ctx.clientNumber, userId: ctx.userId });
      return surface;
    } catch {
      return { items: [], note: 'attention surface unavailable' };
    }
  },
};

/** Heuristic: does the user's message benefit from agentic
 *  multi-step reasoning? Triggers on conjunctions and conditionals
 *  that imply chained tool use. */
export function looksLikeAgenticTurn(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (q.length < 20) return false;  // short messages rarely need chaining
  // Conjunctions or conditionals that imply multi-step.
  if (/\b(and then|then\s+(?:also|find|check|tell|do)|if so|if not|based on|depending on|after that|once you|before\s+(?:you|that))\b/.test(q)) return true;
  // Multi-clause with "check X and Y" pattern.
  if (/\bcheck\b.*\band\b.*\b(open\s+items?|calendar|email|attention|inbox|schedule|meetings?)\b/.test(q)) return true;
  // Research / investigation phrasing.
  if (/^(research|investigate|find\s+out|look\s+up|tell\s+me\s+about|summarize|what'?s\s+going\s+on\s+with)\b/.test(q)) return true;
  return false;
}

/** Run the agentic loop. Returns the final answer + telemetry.
 *  Caller is responsible for putting the result through
 *  validateBeforeRender + channel rendering. */
export async function runAgenticReader(input: AgenticReaderInput): Promise<AgenticReaderResult> {
  const ai = getGenAI();
  const startedAt = Date.now();
  const toolsUsed: string[] = [];
  let toolCallsExecuted = 0;
  let budgetExceeded = false;

  // Build conversation: system + history + current question. Gemini's
  // function-calling expects role:'user'/'model' alternation.
  const contents: any[] = [];
  for (const h of input.history.slice(-6)) {
    contents.push({
      role: h.role === 'brain' ? 'model' : 'user',
      parts: [{ text: h.text }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: input.question }] });

  const systemPrompt = `${input.systemPrompt}

You are running in AGENTIC RESEARCH MODE. The user has asked a question that requires gathering data from multiple sources. You have these read-only tools available — call them as needed to gather the information you need, then synthesize a complete answer.

Tools available: get_open_items, get_calendar_events, search_recent_emails, resolve_contact, get_attention_surface

Iterate as needed (max 5 tool calls). When you have enough data, respond with a final synthesized answer (no more tool calls). Do NOT propose actions — if the user wants something done with the findings, they'll ask in a follow-up turn.`;

  for (let iter = 0; iter < MAX_TOOL_CALLS + 1; iter++) {
    if (Date.now() - startedAt > WALL_TIME_BUDGET_MS) {
      budgetExceeded = true;
      break;
    }
    const resp: any = await ai.models.generateContent({
      model: MODEL_GEMINI,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 128 } as any,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS } as any],
      } as any,
    });

    // Extract function calls (if any) and text from the response.
    const cand = resp?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const fnCalls: any[] = [];
    let textChunk = '';
    for (const p of parts) {
      if (p.functionCall) fnCalls.push(p.functionCall);
      if (typeof p.text === 'string') textChunk += p.text;
    }

    if (fnCalls.length === 0) {
      // Model emitted plain text — this is the final answer.
      return {
        answer: textChunk.trim() || '(no response from agentic reader)',
        toolCallsExecuted, toolsUsed, budgetExceeded,
      };
    }

    if (toolCallsExecuted >= MAX_TOOL_CALLS) {
      budgetExceeded = true;
      break;
    }

    // Append the model's tool-call request to the conversation.
    contents.push({ role: 'model', parts });

    // Execute all tool calls in parallel, append responses.
    const responses = await Promise.all(fnCalls.map(async (fc) => {
      const name = String(fc.name ?? '');
      const args = fc.args ?? {};
      toolsUsed.push(name);
      toolCallsExecuted++;
      const handler = TOOL_HANDLERS[name];
      if (!handler) return { name, response: { error: `unknown tool: ${name}` } };
      try {
        const out = await handler(args, { userId: input.userId, clientNumber: input.clientNumber });
        return { name, response: out };
      } catch (e: any) {
        return { name, response: { error: e?.message ?? 'tool failed' } };
      }
    }));

    contents.push({
      role: 'user',
      parts: responses.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.response } },
      })),
    });
  }

  // Budget exhausted without a final text response. Force one more
  // call without tools to get a synthesis.
  try {
    const finalResp: any = await ai.models.generateContent({
      model: MODEL_GEMINI,
      contents: [
        ...contents,
        { role: 'user', parts: [{ text: 'Synthesize what you have. No more tool calls — give the final answer based on the data gathered so far.' }] },
      ],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 128 } as any,
      } as any,
    });
    const text = (finalResp?.text ?? '').trim();
    return {
      answer: text || '[Agentic reader ran out of budget before producing a final answer.]',
      toolCallsExecuted, toolsUsed, budgetExceeded: true,
    };
  } catch (e: any) {
    return {
      answer: `[Agentic reader failed: ${e?.message ?? 'unknown'}]`,
      toolCallsExecuted, toolsUsed, budgetExceeded: true,
    };
  }
}
