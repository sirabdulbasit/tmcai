/**
 * DEF-367 — try the keys the API document printed, keep the one that works.
 *
 * Owner 10-30: "see how vision metric work". vm reads the key out of the
 * document and TESTS it before storing it (vm integrationDocReader
 * pickWorkingSecret): a document can print several keys — examples, an old one,
 * the real one — and vm's ESS document printed two. Nexeo stores the printed
 * keys encrypted when the document is attached (docReader.attachApiDocument,
 * the model never sees them) and this module is the testing half:
 *
 *   - only after the connection's OWN test failed — a credential that works is
 *     never replaced (vm: "a working credential is evidence; a guess is not");
 *   - each key gets one real request through the guarded reader (testApiWith),
 *     in the document's order; the first that returns records is stored through
 *     the normal secret path (encrypted, secret_set_at, test cleared);
 *   - never on an ACTIVE integration: a new credential is a new connection, and
 *     an active one must be paused first (secretStore.setSecret refuses too);
 *   - keys are never logged, returned or put in a reason.
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { decryptSecret, setSecret } from '../store/secretStore';
import { testApiWith, readApiConfig, placeholderHost } from './apiReader';
import type { TestResult } from '../types';

const log = createLogger('integrations-dockeys');

export interface DocumentKeyOutcome {
  /** A key from the document returned records and is now the stored credential. */
  adopted: boolean;
  /** How many printed keys were tried (0 = none tried, see `skipped`). */
  tried: number;
  /** Why no key was tried, in admin words, or null. */
  skipped: string | null;
  /** The last failing answer, for the admin's reason line (never contains a key). */
  lastReason: string | null;
}

/** The keys the document printed, decrypted, or [] (none kept / unreadable). */
export async function documentKeys(cn: string, integrationId: string): Promise<string[]> {
  const row = await prisma.integrationSync.findFirst({
    where: { id: integrationId, clientNumber: cn },
    select: { apiDocKeysEnc: true },
  });
  if (!row?.apiDocKeysEnc) return [];
  try {
    const parsed: unknown = JSON.parse(decryptSecret(row.apiDocKeysEnc));
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && k.length > 0) : [];
  } catch {
    // An unreadable copy (server key rotated) is "no printed keys", never an error:
    // the admin can still type the key.
    log.warn('api document keys unreadable', { clientNumber: cn, integrationId });
    return [];
  }
}

/**
 * Called after a FAILED Connect test of an API integration. Tries the printed
 * keys and stores the first that works. Never throws for a bad key.
 */
export async function tryDocumentKeys(
  cn: string,
  integ: { id: string; status: string; apiConfig: unknown },
): Promise<DocumentKeyOutcome> {
  const none = (skipped: string | null): DocumentKeyOutcome => ({ adopted: false, tried: 0, skipped, lastReason: null });
  const cfg = readApiConfig(integ.apiConfig);
  if (!cfg || cfg.authScheme === 'NONE') return none(null);
  // A placeholder host fails for every key alike; trying them would only send
  // the keys to a name that does not exist.
  if (placeholderHost(cfg.baseUrl)) return none(null);
  const keys = await documentKeys(cn, integ.id);
  if (keys.length === 0) return none(null);
  if (integ.status === 'ACTIVE') {
    return none('Your document has keys Nexeo could try, but this integration is turned on — pause it first.');
  }

  let lastReason: string | null = null;
  for (let i = 0; i < keys.length; i++) {
    const result: TestResult = await testApiWith(cn, cfg, keys[i]);
    if (!result.ok) {
      lastReason = result.reason ?? null;
      continue;
    }
    // Same path as a typed key: encrypted, secret_set_at moved, test cleared.
    const stored = await setSecret(cn, integ.id, keys[i]);
    if (!stored.stored) {
      return { adopted: false, tried: i + 1, skipped: stored.reason ?? 'The working key could not be stored.', lastReason };
    }
    log.info('api key from the document adopted', { clientNumber: cn, integrationId: integ.id, position: i + 1, of: keys.length });
    return { adopted: true, tried: i + 1, skipped: null, lastReason };
  }
  log.info('no api key from the document worked', { clientNumber: cn, integrationId: integ.id, tried: keys.length });
  return { adopted: false, tried: keys.length, skipped: null, lastReason };
}
