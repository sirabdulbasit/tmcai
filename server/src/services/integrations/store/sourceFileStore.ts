/**
 * DEF-368 — the uploaded spreadsheet of a 'file' integration.
 *
 * vm §7: "A spreadsheet attached in the document box is uploaded and kept;
 * every run reads the stored copy, so a newer version is uploaded the same
 * way." Here:
 *
 *  - ONE stored copy per integration (integration_source_files, primary key =
 *    integration id); an upload replaces it, in the same transaction that
 *    rewrites source_config {fileName, sheetName?, sha256}. Deleting the
 *    integration deletes the copy (FK ON DELETE CASCADE).
 *  - The file is opened BEFORE it is stored (fileReader.listTabs — magic-byte
 *    type, zip-size guard, the isolated worker), so a file that cannot be read
 *    is refused at upload, not discovered at the next run.
 *  - A new copy (different sha256) or another tab is a new connection: the
 *    connection test is cleared (same rule as a link or api_config edit). The
 *    same bytes uploaded again change nothing.
 *  - The chosen tab is kept across uploads, and a kept tab the new workbook
 *    does not have is NOT swapped for another one: the test then fails naming
 *    the tabs, and the admin chooses. A CSV has no tabs, so a CSV upload drops it.
 *  - Never on an ACTIVE integration — "the tested connection is the one runs
 *    use" (spec §3): pause, upload, test, turn on.
 *  - Tenant-scoped: every query names client_number (and the model is in
 *    TENANT_SCOPED_MODELS). The bytes are never returned.
 */
import { Prisma } from '@prisma/client';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { detectFileKind, listTabs, readFileConfig, sha256Hex, sourceFileTable } from '../sources/fileReader';
import { getIntegration, fileConnectionFingerprint } from './integrationStore';
import {
  IntegrationInputError,
  IntegrationNotFoundError,
  type FileSourceConfig,
  type IntegrationDTO,
  type SourceFileDTO,
} from '../types';

const log = createLogger('integrations-sourcefile');

export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  mime: string;
}

/** A display name: no path, no control characters, at most 255 characters. */
export function cleanFileName(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean || 'spreadsheet';
}

export async function storeSourceFile(
  cn: string, id: string, file: UploadedFile, actorId: number | null,
): Promise<{ file: SourceFileDTO; integration: IntegrationDTO }> {
  const row = await prisma.integrationSync.findFirst({
    where: { id, clientNumber: cn },
    select: { id: true, status: true, sourceKind: true, sourceConfig: true },
  });
  if (!row) throw new IntegrationNotFoundError(id);
  if (row.sourceKind !== 'file') {
    throw new IntegrationInputError('This integration does not read an uploaded file; choose "Excel or CSV file" as the source in Basics first.', 'sourceKind');
  }
  if (row.status === 'ACTIVE') {
    throw new IntegrationInputError('Pause this integration before uploading a newer file — a running integration keeps reading the file it was tested with.', 'file');
  }
  if (!file.buffer || file.buffer.length === 0) throw new IntegrationInputError('The file is empty.', 'file');

  // Type by the bytes; opened in the isolated worker BEFORE anything is stored.
  const kind = detectFileKind(file.buffer);
  const tabs = await listTabs(file.buffer);
  const sha256 = sha256Hex(file.buffer);
  const fileName = cleanFileName(file.filename);
  const old = readFileConfig(row.sourceConfig);
  const keepTab = kind !== 'csv' && old?.sheetName ? old.sheetName : undefined;
  const cfg: FileSourceConfig = { fileName, sha256, ...(keepTab ? { sheetName: keepTab } : {}) };
  const changed = !old || fileConnectionFingerprint(old) !== fileConnectionFingerprint(cfg);
  const uploadedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const files = sourceFileTable(tx);
    await files.deleteMany({ where: { integrationId: id, clientNumber: cn } });
    await files.create({
      data: {
        integrationId: id,
        clientNumber: cn,
        filename: fileName,
        mime: (file.mime || '').slice(0, 120) || null,
        bytes: file.buffer,
        sizeBytes: file.buffer.length,
        sha256,
        uploadedBy: actorId,
        uploadedAt,
      },
    });
    // status re-checked in the WHERE: an activation between the read above and
    // this write cannot get a new, untested file under it.
    const res = await tx.integrationSync.updateMany({
      where: { id, clientNumber: cn, sourceKind: 'file', status: { not: 'ACTIVE' } },
      data: {
        sourceConfig: cfg as unknown as Prisma.InputJsonValue,
        ...(changed ? { connectionTestedAt: null, connectionFingerprint: null } : {}),
      },
    });
    if (res.count === 0) {
      throw new IntegrationInputError('Pause this integration before uploading a newer file — a running integration keeps reading the file it was tested with.', 'file');
    }
  });
  log.info('integration source file stored', { cn, id, kind, bytes: file.buffer.length, tabs: tabs.length, testCleared: changed });

  const integration = await getIntegration(cn, id);
  if (!integration) throw new IntegrationNotFoundError(id);
  return {
    file: { fileName, sizeBytes: file.buffer.length, uploadedAt: uploadedAt.toISOString(), tabs },
    integration,
  };
}

/** The stored file of this tenant's integration with its tabs, or null. */
export async function sourceFileInfo(cn: string, id: string): Promise<SourceFileDTO | null> {
  const f = await sourceFileTable().findFirst({
    where: { integrationId: id, clientNumber: cn },
    select: { filename: true, sizeBytes: true, uploadedAt: true, bytes: true },
  });
  if (!f?.bytes) return null;
  const tabs = await listTabs(Buffer.from(f.bytes));
  return {
    fileName: f.filename ?? 'spreadsheet',
    sizeBytes: f.sizeBytes ?? f.bytes.length,
    uploadedAt: (f.uploadedAt ?? new Date(0)).toISOString(),
    tabs,
  };
}
