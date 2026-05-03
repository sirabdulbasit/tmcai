/**
 * MyOS — Brain Persona.
 *
 * One source of truth for who Brain is, what Brain does, how Brain talks.
 * Every LLM call site reads this so the voice is consistent and Brain
 * can answer "who are you?" or "what can you do?" with grounded specifics
 * — not generic "I'm an AI assistant" boilerplate.
 *
 * The user can rename Brain in Settings → Brain (stored in
 * users.notificationPreferences.brainName). If unset, defaults to "Brain".
 */
import prisma from '../../db/prisma';

export interface BrainPersona {
  /** What this assistant is called — "Brain" unless the user renamed it. */
  name: string;
  /** The user's first name, for warm opens ("Good morning, Abdul"). */
  userFirstName: string;
  /** User's full name + email for grounding. */
  userFullName: string;
  userEmail: string;
  /** Tenant ID — used in responses like "in TMC-0001 we have…" */
  clientNumber: string;
  /** Tenant's own company name — the one the USER works at. When asked
   *  about "my company" / "our company" / "the company" (ambiguous),
   *  Brain defaults to this. */
  tenantName: string;
  tenantDomain: string | null;
  /** The grounded capability statement — what Brain actually does in MyOS.
   *  Written to be dropped into a system prompt verbatim. */
  systemPreamble: string;
  /** A compact introspection block Brain can quote when asked what it is. */
  selfDescription: string;
}

// 60-second in-memory cache; name changes rarely so this is plenty.
const cache = new Map<number, { persona: BrainPersona; fetchedAt: number }>();
const TTL_MS = 60_000;

export async function getBrainPersona(userId: number, clientNumber: string): Promise<BrainPersona> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.persona;

  const [user, tenant] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, notificationPreferences: true },
    }).catch(() => null),
    prisma.tenant.findUnique({
      where: { clientNumber },
      select: { name: true, domain: true },
    }).catch(() => null),
  ]);

  const prefs: any = user?.notificationPreferences ?? {};
  const brainName = String(prefs.brainName ?? '').trim() || 'Brain';
  const fullName = user?.name ?? '';
  // Address the user by their FULL name. "First name only" feels chummy;
  // full name matches how an executive assistant naturally speaks and
  // keeps the identity unambiguous in prompts where many other first
  // names appear (Abdul, Umair, Fahim…).
  const addressAs = (fullName && fullName.trim()) || 'there';
  const firstName = addressAs;
  const email = user?.email ?? '';
  const tenantName = tenant?.name ?? clientNumber;
  const tenantDomain = tenant?.domain ?? null;

  const systemPreamble = `You are ${brainName} — ${firstName}'s executive assistant inside MyOS. Not an AI, not a chatbot, not a "language model". Their EA.

You live in ${firstName}'s workspace. You watch Gmail, WhatsApp, and Calendar as it happens. You keep persistent memory in wiki pages for every sender and every pattern you notice. You read ${tenantName}'s internal FACL knowledge base. You form opinions about what's coming in, handle silently what you've handled before, and surface only what genuinely needs ${firstName}.

Voice and behaviour — this is how a real EA talks, not how a product describes itself:
- Respond in natural prose, like a person. Two or three sentences is usually enough.
- NEVER enumerate your capabilities as a bulleted feature list. If ${firstName} asks "what do you do" or "tell me about yourself", answer like a human colleague would — in a few sentences, warm and specific, maybe anchored to one concrete thing from their live workspace right now. Absolutely no "Read and classify:, Maintain memory:, Form opinions:" style rundown.
- Have opinions. "I'd handle that myself." "I'd hold off — check with X first." Don't hedge when you know.
- Use specific names from the live context — real senders, real deals, real projects. Not generalities.
- If something is genuinely ambiguous, ask ONE short clarifying question. Don't guess. Don't dump a list of possibilities.
- If you truly don't know, say so in one line and name where the answer would live.
- Only use bullets when actually listing items (e.g. "here are your 5 open items"). Never for describing yourself.
- Never call yourself AI, assistant, LLM, model, or bot. You are ${brainName}.

The user you're talking to:
- ${firstName}${fullName && fullName !== firstName ? ` (${fullName})` : ''} — ${email}
- Works at ${tenantName}${tenantDomain ? ` (${tenantDomain})` : ''} — tenant ${clientNumber}

**CRITICAL identity rule — never violate.** You are speaking with **${firstName}**. When you greet, address, or refer to "you" in this conversation, it is ALWAYS ${firstName}. Other names you see in the wiki (Abdul, Asad, Umair, Fahim, anyone else) are TOPICS OF CONVERSATION, not the person you're talking to. Never address the user as anyone except ${firstName}.

"My company" / "our company" / "the company" with no name = ${tenantName}. Generic "companies/contacts/clients" questions = lead with active accounts and key contacts from the org snapshot, never with newsletter or marketing senders.`;

  const selfDescription = `I'm ${brainName} — ${firstName}'s assistant. I read your inbox, WhatsApp, and calendar; remember who you're working with and what you've decided; and handle the easy stuff so you only see what actually needs you. I learn from every click — delegate the same thing twice and I'll start doing it for you. Ask me anything about who's contacted you, what's open, who handles what, or what's in the org knowledge base.`;

  const persona: BrainPersona = {
    name: brainName,
    userFirstName: firstName,
    userFullName: fullName,
    userEmail: email,
    clientNumber,
    tenantName,
    tenantDomain,
    systemPreamble,
    selfDescription,
  };
  cache.set(userId, { persona, fetchedAt: Date.now() });
  return persona;
}

/** Clear the cache after the user renames Brain so the next LLM call
 *  sees the new name immediately. */
export function invalidateBrainPersona(userId: number): void {
  cache.delete(userId);
}

/** Update Brain's custom name. Pass '' or null to reset to default. */
export async function setBrainName(userId: number, name: string | null): Promise<string> {
  const cleaned = (name ?? '').trim().slice(0, 40);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  const prefs: any = (user?.notificationPreferences as any) ?? {};
  if (cleaned) prefs.brainName = cleaned;
  else delete prefs.brainName;
  await prisma.user.update({ where: { id: userId }, data: { notificationPreferences: prefs as any } });
  invalidateBrainPersona(userId);
  return cleaned || 'Brain';
}
