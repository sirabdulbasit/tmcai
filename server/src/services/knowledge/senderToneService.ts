/**
 * senderToneService — read the user's recent sent emails to a specific
 * recipient so Brain can MIRROR their writing voice when drafting.
 *
 * Per Basit 2026-05-25: "before drafting or any suggestion to any
 * email, will brain read sent item related to that sender and see how
 * i do email or reply him? so brain should learn and reply in the
 * same tone this is very important".
 *
 * CHANNEL SEPARATION RULE (Basit 2026-05-25, locked):
 * Email tone samples are ONLY for send_email drafts.
 * WhatsApp tone samples are ONLY for notify_via_whatsapp drafts.
 * NEVER pool samples across channels — even for the same recipient,
 * the user's WhatsApp voice ≠ email voice. The dedicated functions
 * below all query Gmail's Sent folder; do NOT add a generic
 * "getSentSamples" that pools across channels. WhatsApp gets its own
 * service (whatsappToneService.ts when wired) with the SAME
 * channel-isolated rule.
 *
 * Why this exists: a generic "Hi {firstName}, hope this finds you
 * well…" drafted in textbook English doesn't sound like Basit. Basit's
 * actual emails to Asad might open "Asad bhai" or "Asad sb" and switch
 * registers / language mix mid-thread. Reasoning should see those
 * samples and write IN HIS VOICE for THAT recipient — not a generic
 * one.
 *
 * Costs: one Gmail API call per recipient per draft turn (capped at
 * 5 samples per recipient, ~250-line bodies trimmed). Cheap.
 *
 * Privacy: this is the user's OWN gmail.readonly scope — reading their
 * own sent folder is the same authority as the user reading it in
 * their browser. No persistence to DB.
 */
import { google } from 'googleapis';
import createLogger from '../../utils/logger';

const log = createLogger('sender-tone');

interface ToneSample {
  subject: string;
  body: string;
  to: string;
  sentAt: string | null;
}

export interface ToneSamplesForRecipient {
  recipientEmail: string;
  recipientName?: string;
  samples: ToneSample[];
}

/** Fetch up to `max` of the user's recent emails sent TO the given
 *  recipient email. Returns trimmed bodies for cheap prompt injection. */
export async function getToneSamplesForRecipient(
  userId: number,
  recipientEmail: string,
  max = 5,
): Promise<ToneSamplesForRecipient | null> {
  if (!recipientEmail || typeof recipientEmail !== 'string') return null;
  const normalised = recipientEmail.trim().toLowerCase();
  if (!normalised.includes('@')) return null;

  try {
    const { getAuthenticatedClient } = await import('../integrationService');
    const { client } = await getAuthenticatedClient(userId);
    if (!client) return { recipientEmail: normalised, samples: [] };
    const gmail = google.gmail({ version: 'v1', auth: client });
    const list = await gmail.users.messages.list({
      userId: 'me',
      // `to:` matches the To header; `in:sent` constrains to sent folder
      // so we only pull messages the user actually wrote, not received.
      q: `to:${normalised} in:sent`,
      maxResults: max,
    });
    const samples: ToneSample[] = [];
    for (const m of list.data.messages ?? []) {
      const d = await gmail.users.messages.get({
        userId: 'me', id: m.id!, format: 'full',
      }).catch(() => null);
      if (!d?.data) continue;
      const headers = d.data.payload?.headers ?? [];
      const getH = (k: string) => headers.find((h) => h.name?.toLowerCase() === k.toLowerCase())?.value ?? '';
      const findText = (part: any): string => {
        if (!part) return '';
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          for (const p of part.parts) {
            const t = findText(p);
            if (t) return t;
          }
        }
        return '';
      };
      const rawBody = findText(d.data.payload) || (d.data.snippet ?? '');
      // Trim to ~600 chars per sample — opening + closing + a paragraph
      // is plenty for tone detection; full bodies bloat the prompt.
      // Also strip the Nexeo-disclosure footer if present (it's not
      // the user's voice, it's the system's).
      const trimmedBody = rawBody
        .replace(/\n?—\nSent by Nexeo,[^\n]*\.?\s*$/i, '')
        .slice(0, 600)
        .trim();
      const sentAt = d.data.internalDate
        ? new Date(parseInt(d.data.internalDate, 10)).toISOString()
        : null;
      samples.push({
        subject: getH('subject') || '(no subject)',
        body: trimmedBody,
        to: getH('to'),
        sentAt,
      });
    }
    return { recipientEmail: normalised, samples };
  } catch (e: any) {
    log.warn('tone fetch failed', { userId, recipientEmail: normalised, error: e?.message });
    return { recipientEmail: normalised, samples: [] };
  }
}

/** Fetch tone samples in parallel for multiple recipients. Returns one
 *  ToneSamplesForRecipient per input email; entries with samples=[]
 *  mean "no prior history with this person" — reasoning should treat
 *  it as a first-time draft with reasonable defaults. */
export async function getToneSamplesForRecipients(
  userId: number,
  recipientEmails: string[],
  maxPerRecipient = 5,
): Promise<ToneSamplesForRecipient[]> {
  if (recipientEmails.length === 0) return [];
  const unique = Array.from(new Set(recipientEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  return Promise.all(unique.map((e) => getToneSamplesForRecipient(userId, e, maxPerRecipient).then((r) => r ?? { recipientEmail: e, samples: [] })));
}

/** Render the tone samples into a compact dataBlock string for the
 *  reasoning prompt. Format is intentionally terse — opening + closing
 *  + 1-2 sentences per sample, grouped by recipient. */
export function renderToneBlock(
  samplesByRecipient: ToneSamplesForRecipient[],
): string {
  const usable = samplesByRecipient.filter((s) => s.samples.length > 0);
  if (usable.length === 0) return '';
  const lines: string[] = [];
  lines.push(`# Your writing voice — EMAIL samples (recent emails YOU sent). Use these ONLY when drafting send_email actions; DO NOT use them when drafting notify_via_whatsapp — WhatsApp voice is separate per the channel-separation rule.`);
  for (const rec of usable) {
    const who = rec.recipientName ? `${rec.recipientName} <${rec.recipientEmail}>` : rec.recipientEmail;
    lines.push(`\n## To: ${who} (${rec.samples.length} samples)`);
    rec.samples.forEach((s, i) => {
      const date = s.sentAt ? new Date(s.sentAt).toISOString().slice(0, 10) : '';
      lines.push(`\n### Sample ${i + 1}${date ? ` (${date})` : ''}`);
      lines.push(`Subject: ${s.subject}`);
      lines.push(`Body:\n${s.body}`);
    });
  }
  lines.push(`\n# How to use the samples above:
- When drafting send_email body, MATCH the opening, closing, formality, language mix, and idioms shown in samples for the SAME recipient.
- Do NOT invent generic openings ("Hope this finds you well") if the user never uses them with that person.
- If the user mixes English + Roman-Urdu / Urdu / another language with that recipient, mirror it.
- If there are no samples for the recipient, use a neutral professional voice but err on the side of brevity.`);
  return lines.join('\n');
}
