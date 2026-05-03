/**
 * tenant_log — append-only chronology. One page per (clientNumber, userId).
 * Entries: `## [YYYY-MM-DD HH:MM PKT] <kind> | <title> — <detail>`
 *
 * Brain checks this to know what's been happening recently. Humans can
 * `grep "^## \[" ` to scan the timeline.
 *
 * Capped at 2000 lines; oldest entries rotate out (kept in
 * metadata.rotatedCount so we know we've dropped some).
 */
import prisma from '../../db/prisma';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const LOG_TITLE = 'Tenant Log';
const LOG_PAGE_TYPE = 'tenant_log';
const MAX_LINES = 2000;

export type LogKind = 'ingest' | 'query' | 'lint' | 'decision' | 'gap_opened' | 'answer_filed' | 'instruction_match' | 'instruction_veto';

export interface LogEntry {
  kind: LogKind;
  title: string;
  detail?: string;
  at?: Date;
}

export async function appendTenantLog(
  clientNumber: string,
  userId: number,
  entry: LogEntry,
): Promise<void> {
  const line = formatLine(entry);
  const existing = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: LOG_PAGE_TYPE, title: LOG_TITLE },
    select: { id: true, bodyMarkdown: true, metadata: true },
  }).catch(() => null);

  let body = existing?.bodyMarkdown ?? logHeader();
  body = body + '\n' + line;

  // Rotate oldest lines if cap exceeded. Header stays; entry lines start after blank line.
  const lines = body.split('\n');
  let rotated = 0;
  if (lines.length > MAX_LINES + 20) {
    const header: string[] = [];
    let i = 0;
    while (i < lines.length && !lines[i].startsWith('## [')) {
      header.push(lines[i]);
      i++;
    }
    const entries = lines.slice(i).filter((l) => l.length > 0);
    const keep = entries.slice(-MAX_LINES);
    rotated = entries.length - keep.length;
    body = [...header, ...keep].join('\n');
  }

  const metadata = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: 'user',
    authoredBy: 'tenant_logger',
    rotatedCount: ((existing?.metadata as any)?.rotatedCount ?? 0) + rotated,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { bodyMarkdown: body, metadata, lastUpdatedAt: new Date(), lastUpdatedBy: 'tenant_logger' },
    }).catch(() => {});
  } else {
    await prisma.wikiPage.create({
      data: {
        clientNumber, userId,
        pageType: LOG_PAGE_TYPE, title: LOG_TITLE,
        bodyMarkdown: body, metadata,
        storage: 'postgres', status: 'active', lastUpdatedBy: 'tenant_logger',
      },
    }).catch(() => {});
  }
}

function formatLine(entry: LogEntry): string {
  const at = entry.at ?? new Date();
  const ts = formatPKT(at);
  const detail = entry.detail ? ` — ${entry.detail}` : '';
  return `## [${ts}] ${entry.kind} | ${entry.title}${detail}`;
}

function formatPKT(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} PKT`;
}

function logHeader(): string {
  return [
    '# Tenant Log',
    '',
    '_Append-only chronology of what Brain has done in this tenant. Entries are tail-appended; oldest rotate out after 2000 lines._',
    '',
  ].join('\n');
}

/** Return recent log lines (for Brain to read at query time). */
export async function getRecentTenantLog(clientNumber: string, userId: number, n = 30): Promise<string> {
  const page = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: LOG_PAGE_TYPE, title: LOG_TITLE },
    select: { bodyMarkdown: true },
  }).catch(() => null);
  const body = String(page?.bodyMarkdown ?? '');
  const lines = body.split('\n').filter((l) => l.startsWith('## ['));
  return lines.slice(-n).join('\n');
}
