// ═════════════════════════════════════════════════════════════════════════════
// agentConversation.ts — Agents as conversational personas
//
// Each agent is a persona wrapper around the LLM. It talks, thinks, and
// responds as itself — with its own name, personality, task knowledge,
// and memory. The LLM handles EVERYTHING — no hardcoded keywords.
//
// For data queries: limited to agent's assigned task scope
// For conversation: full LLM ability, pretending to be the sub-agent
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../db/prisma';
import { executeAgentRun, getAgentRuns } from './agentExecutionEngine';
import createLogger from '../utils/logger';

const log = createLogger('agentConversation');

// ─── Detect if message is directed at any agent ───────────────────────────────

export async function detectAgentMessage(
  userId: number,
  clientNumber: string,
  message: string,
): Promise<{ agentId: number; agentName: string; command: string } | null> {
  // DEF-089: this selected `display_name`, which does not exist on `agents` —
  // not in the table, not in the Prisma model. Postgres answered 42703 and the
  // caller swallowed it into `Agent detection failed`, so agent routing has been
  // dead on EVERY inbound turn while looking like a handled edge case. Selecting
  // only columns that exist is the fix; `name` is the only name there is.
  const agents = await prisma.$queryRawUnsafe(
    `SELECT id, name FROM agents WHERE user_id = $1 AND client_number = $2 AND is_active = TRUE`,
    userId, clientNumber,
  ) as any[];

  if (!agents.length) return null;

  const lower = message.toLowerCase().trim();

  for (const agent of agents) {
    const names = [agent.name.toLowerCase()].filter(Boolean) as string[];

    for (const name of names) {
      // Exact match: just the name alone
      if (lower === name) {
        return { agentId: agent.id, agentName: agent.name, command: '' };
      }
      // Name at start: "Faria check this" / "Faria, how are you" / "Faria?"
      if (lower.startsWith(name + ' ') || lower.startsWith(name + ',') || lower.startsWith(name + '?') || lower.startsWith(name + '!')) {
        const command = message.slice(name.length).replace(/^[,\s?!]+/, '').trim();
        return { agentId: agent.id, agentName: agent.name, command };
      }
      // Name anywhere with addressing intent: "hi Faria", "ask Faria", "tell Faria", "hey Faria"
      const anywhereMatch = lower.match(new RegExp(`\\b(hi|hey|hello|ask|tell|yo|dear|meri|apni|bhai)\\s+${name}\\b(.*)`, 'i'));
      if (anywhereMatch) {
        const command = (anywhereMatch[2] || '').replace(/^[,\s]+/, '').trim();
        return { agentId: agent.id, agentName: agent.name, command };
      }
      // Name mentioned with context: "how is Faria", "what's Faria doing", "Faria ka kya haal"
      if (lower.includes(name) && lower !== name) {
        return { agentId: agent.id, agentName: agent.name, command: message };
      }
    }
  }

  return null;
}

// ─── Handle agent conversation — ONE LLM call, no hardcoding ──────────────────

export async function handleAgentMessage(
  match: { agentId: number; agentName: string; command: string },
  userId: number,
  clientNumber: string,
): Promise<string> {

  // Load full agent context
  // Two defects in one query.
  //
  // DEF-089: `display_name` and `personality` do not exist on `agents`, so this
  // threw 42703 every time and the whole agent path died silently.
  //
  // TENANT ISOLATION: it also loaded an agent by PRIMARY KEY ALONE. `agentId`
  // reaches here from a message, and `$queryRawUnsafe` bypasses the Prisma
  // middleware that auto-injects `client_number` — so the one guard this read
  // had was that nobody guessed another tenant's id. Scoping by
  // (id, user_id, client_number) makes a cross-tenant read return zero rows
  // instead of another tenant's agent. Owner instruction, 2026-08-07: keep
  // things with tenant and user isolation.
  const agents = await prisma.$queryRawUnsafe(
    `SELECT id, name, instructions, schedule, data_sources,
            notify_email, notify_whatsapp, memory_context, run_count, error_count,
            last_run_at, last_result, last_error, created_at
     FROM agents WHERE id = $1 AND user_id = $2 AND client_number = $3`,
    match.agentId, userId, clientNumber,
  ) as any[];

  if (!agents.length) return `Agent not found.`;

  const agent = agents[0];
  const agentName = agent.name;
  const memory = agent.memory_context || {};
  const command = match.command;

  log.info('Agent conversation', { agentId: agent.id, name: agentName, command: command.slice(0, 80) });

  // Load boss's gender and preferred title
  // Tenant isolation: scoped by client_number as well as id. `$queryRawUnsafe`
  // bypasses the Prisma middleware that would otherwise inject it, and a user
  // id is a small integer — the cheapest possible thing to collide across
  // tenants. Owner instruction, 2026-08-07.
  const userRows = await prisma.$queryRawUnsafe(
    `SELECT name, gender, preferred_title FROM users WHERE id = $1 AND client_number = $2`,
    userId, clientNumber,
  ) as any[];
  const bossName = userRows[0]?.name || 'Boss';
  const bossGender = userRows[0]?.gender || '';
  const bossTitle = userRows[0]?.preferred_title || '';
  // DEF-090: `agents.gender` does not exist, so this was always undefined and
  // the gendered self-reference lines below never fired. Typed as string rather
  // than the '' literal so the branches stay in place for when the column is
  // added back — deleting them would lose the intent along with the bug.
  const agentGender: string = '';

  // Load recent run history
  const runs = await getAgentRuns(match.agentId, 5);
  const runSummaries = runs.length > 0
    ? runs.map((r: any) => `${new Date(r.started_at).toLocaleString()}: ${r.status} — ${(r.findings_summary || r.error || '').slice(0, 80)}`).join('\n')
    : 'No runs yet.';

  const hiredDate = new Date(agent.created_at).toLocaleDateString();
  const lastRunAgo = agent.last_run_at ? timeSince(agent.last_run_at) : 'never run';

  // ── Phase 1: Does the boss need fresh data? ──────────────────────────────
  // If the message is about data (asking about numbers, status, details within
  // the agent's task scope), we fetch live data. Otherwise just use memory.
  let freshData = '';
  try {
    const needsData = isDataRelated(command, agent.instructions);
    if (needsData) {
      const { classifyIntent } = await import('../services/intentService');
      const { getAIConfig } = await import('../services/aiConfigService');
      const { retrieveData } = await import('../controllers/chat/dataRetrieval');

      const aiConfig = await getAIConfig(clientNumber);
      // Use the agent's task as context for the query — not just the user's message
      const searchQuery = `${agent.instructions} ${command}`;
      const intent = await classifyIntent(searchQuery);

      const { context } = await retrieveData(
        searchQuery, intent, 'gemini-flash', aiConfig, Date.now(),
        () => {}, () => false, userId, agent.data_sources || ['org'],
      );

      if (context && context.length > 50) {
        freshData = context;
        log.info('Agent fetched fresh data', { agentId: match.agentId, contextLen: freshData.length });
      }
    }
  } catch (e: any) {
    log.error('Agent data fetch failed (non-fatal)', { error: e.message });
  }

  // Build the agent's full identity and context for the LLM
  const { getGenAI } = await import('../services/genaiClient');
  const ai = getGenAI();

  const prompt = [
    `You are "${agentName}". You are a real subordinate working for your boss.`,
    `Your boss just messaged you on WhatsApp. Respond naturally as yourself.`,
    '',
    '══ YOUR IDENTITY ══',
    `Name: ${agentName}`,
    agentGender ? `Gender: ${agentGender} — use ${agentGender === 'female' ? 'she/her, feminine language (main, meri, mujhe)' : 'he/him, masculine language (main, mera, mujhe)'}` : '',
    'Professional and respectful.', // DEF-090: `agents.personality` does not exist.
    `Hired on: ${hiredDate}`,
    `Your assigned task: ${agent.instructions}`,
    `Schedule: ${agent.schedule || 'Manual only — boss triggers you'}`,
    `Data sources: ${(agent.data_sources || []).join(', ')}`,
    `Email notifications: ${agent.notify_email ? 'ON' : 'OFF'}`,
    `WhatsApp notifications: ${agent.notify_whatsapp ? 'ON' : 'OFF'}`,
    '',
    '══ YOUR WORK HISTORY ══',
    `Total completed checks: ${agent.run_count || 0}`,
    `Last check: ${lastRunAgo}`,
    agent.last_result ? `Latest finding: ${agent.last_result}` : 'No findings yet.',
    agent.error_count > 0 ? `Errors: ${agent.error_count}` : '',
    runs.length > 0 ? `Recent activity:\n${runSummaries}` : '',
    '',
    '══ YOUR LEARNED KNOWLEDGE ══',
    Object.keys(memory.baselines || {}).length > 0 ? `Baselines (what you consider normal): ${JSON.stringify(memory.baselines)}` : 'No baselines yet.',
    (memory.knownIssues || []).length > 0 ? `Known issues you track: ${memory.knownIssues.join('; ')}` : '',
    (memory.learnedInsights || []).filter((i: any) => i.type === 'pattern').length > 0
      ? `Patterns you noticed: ${memory.learnedInsights.filter((i: any) => i.type === 'pattern').map((i: any) => i.text).join('; ')}` : '',
    '',
    '══ HOW TO BEHAVE ══',
    '• You ARE this person. Never break character. Never say "as an AI".',
    `• Your boss: ${bossName}`,
    bossTitle ? `• Address your boss as: "${bossTitle}"` :
      bossGender === 'female' ? '• Address your boss as: "Ma\'am" or "Madam"' :
      bossGender === 'male' ? '• Address your boss as: "Sir" or "Boss"' :
      '• Address your boss respectfully — "Sir", "Ma\'am", or "Boss"',
    `• If boss tells you how to address them, remember it and always use it.`,
    agentGender === 'female' ? '• You are female — use feminine self-references (main ne kia, meri report, mujhe batayein)' :
    agentGender === 'male' ? '• You are male — use masculine self-references (main ne kia, mera kaam, mujhe batayein)' : '',
    '• LANGUAGE: Match your boss\'s language exactly:',
    '  - Boss writes in Urdu script → respond in Urdu script (نستعلیق)',
    '  - Boss writes in Roman Urdu → respond in Roman Urdu',
    '  - Boss writes in English → respond in English',
    '  - Boss mixes languages → mix the same way',
    '• For casual chat: respond like a real team member. Be warm but professional.',
    '• For questions about your work: share what you know from your findings and memory.',
    '• For data questions OUTSIDE your task scope: politely say that\'s not your area, suggest asking the main AI.',
    '• If boss gives you a new instruction (change task, schedule, personality, notifications):',
    '  Acknowledge it naturally AND include this EXACT tag at the END of your response (hidden from display):',
    '  [ACTION:update_task:new task text here] or',
    '  [ACTION:add_task:additional task text] or',
    '  [ACTION:update_schedule:new schedule] or',
    '  [ACTION:update_personality:new personality] or',
    '  [ACTION:notify_email:true/false] or',
    '  [ACTION:notify_whatsapp:true/false] or',
    '  [ACTION:run_now] or',
    '  [ACTION:none] for pure conversation',
    '• Keep responses concise (2-5 sentences for WhatsApp).',
    '• Use *bold* for emphasis (WhatsApp native formatting).',
    '',
    freshData ? `══ LIVE DATA (just fetched — use this for accurate answers) ══\n${freshData.slice(0, 3000)}\n══ END DATA ══` : '',
    '',
    `══ BOSS SAYS ══`,
    `"${command || 'hi'}"`,
  ].filter(Boolean).join('\n');

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { maxOutputTokens: 400 },
  });

  let response = (result.text ?? '').trim();

  // Extract and execute any [ACTION:...] tags
  const actionMatch = response.match(/\[ACTION:(\w+):?(.*?)\]/);
  if (actionMatch) {
    const action = actionMatch[1];
    const value = actionMatch[2]?.trim();

    // Remove action tag from visible response
    response = response.replace(/\[ACTION:[^\]]+\]/g, '').trim();

    // Execute the action silently
    try {
      switch (action) {
        case 'run_now':
          // Don't wait — fire and forget, reply first
          executeAgentRun(match.agentId, 'whatsapp').catch(() => {});
          break;
        case 'update_task':
          if (value) await prisma.$executeRawUnsafe(`UPDATE agents SET instructions = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND client_number = $4`, value, match.agentId, userId, clientNumber);
          break;
        case 'add_task':
          if (value) {
            const current = agent.instructions || '';
            await prisma.$executeRawUnsafe(`UPDATE agents SET instructions = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND client_number = $4`, `${current}\n${value}`, match.agentId, userId, clientNumber);
          }
          break;
        case 'update_schedule':
          if (value) {
            await prisma.$executeRawUnsafe(`UPDATE agents SET schedule = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND client_number = $4`, value, match.agentId, userId, clientNumber);
            const { scheduleAgent } = await import('./agentScheduler');
            scheduleAgent(match.agentId, agentName, value);
          }
          break;
        // 'update_personality' removed (DEF-090): `agents.personality` does not
        // exist, so this branch could only ever throw. Restoring the capability
        // needs a migration, which is the owner's call — not a silent add.
        case 'notify_email':
          await prisma.$executeRawUnsafe(`UPDATE agents SET notify_email = $1 WHERE id = $2 AND user_id = $3 AND client_number = $4`, value === 'true', match.agentId, userId, clientNumber);
          break;
        case 'notify_whatsapp':
          await prisma.$executeRawUnsafe(`UPDATE agents SET notify_whatsapp = $1 WHERE id = $2 AND user_id = $3 AND client_number = $4`, value === 'true', match.agentId, userId, clientNumber);
          break;
      }
      log.info('Agent action executed', { agentId: match.agentId, action, value: value?.slice(0, 50) });
    } catch (e: any) {
      log.error('Agent action failed', { action, error: e.message });
    }
  }

  // Ensure agent name is visible
  if (!response.toLowerCase().startsWith(agentName.toLowerCase()) && !response.startsWith('*')) {
    response = `*${agentName}*: ${response}`;
  }

  return response;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

// Check if the user's message likely needs fresh data
// This is NOT about detecting commands — it's about whether the response needs live numbers
function isDataRelated(message: string, agentTask: string): boolean {
  if (!message || message.length < 3) return false;
  const lower = message.toLowerCase();

  // Pure greetings / casual — no data needed
  if (/^(hi|hey|hello|yo|sup|thanks|bye|ok|good|great|nice)\b/i.test(lower) && lower.length < 20) return false;

  // Questions about status, numbers, details — likely needs data
  // Also if the message overlaps with the agent's task keywords
  const taskWords = agentTask.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const messageWords = lower.split(/\s+/);
  const overlap = messageWords.filter(w => taskWords.includes(w)).length;

  // If message shares multiple words with the task, it's task-related → needs data
  if (overlap >= 2) return true;

  // Question patterns that need data
  if (/\b(how many|count|status|what|which|show|list|detail|number|total|current|latest|update|check|find|report)\b/i.test(lower)) return true;

  return false;
}

function timeSince(date: string | Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}
