/**
 * WhatsApp Web internal-module probe — turns `r: r` into a fact.
 *
 * WHY THIS EXISTS
 * whatsapp-web.js reaches into WhatsApp Web's own bundle by internal
 * module name (`window.require('WAWebCollections')` etc). Meta renames
 * those modules between builds. When a name is gone, `window.require`
 * throws from inside the minified bundle, and every layer above reports
 * the same opaque `r: r` — media download, chat state (typing/recording),
 * reactions. Six days were spent guessing at that string; the library's
 * `downloadQpl` fix was already present, and rotating the pinned build was
 * rejected on archive evidence. What was never done was ASKING THE PAGE.
 *
 * This probe is READ-ONLY: it resolves module names and reports which
 * exist, plus the real error text for the ones that don't. It sends
 * nothing, mutates nothing, and never throws into the caller.
 *
 * Once we know which names moved, the fix is a surgical override of the
 * affected library method using the correct names — no node_modules edit
 * and no dependency bump.
 */
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:module-probe');

/** Modules whatsapp-web.js@1.34.7 depends on for the broken paths. */
export const PROBED_MODULES = [
  // media download (Message.downloadMedia)
  'WAWebCollections',
  'WAWebDownloadManager',
  // chat presence / typing + recording state
  'WAWebChatPresence',
  'WAWebSendPresenceJob',
  // reactions + generic send
  'WAWebSendReactionMsgAction',
  'WAWebSendMsgChatAction',
  // identity / lid mapping (already working — control group)
  'WAWebApiContact',
  'WAWebWidFactory',
] as const;

export interface ModuleProbeResult {
  ok: boolean;
  /** True when window.require itself is reachable. */
  requireAvailable: boolean;
  resolved: string[];
  missing: Array<{ name: string; error: string }>;
  /** Candidate names discovered by scanning the module registry. */
  suggestions?: Record<string, string[]>;
  error?: string;
}

/**
 * Probe the live page. `client` must be an initialized webjs client
 * (its `pupPage` is used). Never throws.
 */
export async function probeWebjsModules(client: any): Promise<ModuleProbeResult> {
  const empty: ModuleProbeResult = {
    ok: false, requireAvailable: false, resolved: [], missing: [],
  };
  const page = client?.pupPage;
  if (!page || typeof page.evaluate !== 'function') {
    return { ...empty, error: 'no pupPage on client (not initialized?)' };
  }

  try {
    const result = await page.evaluate(async (names: string[]) => {
      const out: {
        requireAvailable: boolean;
        resolved: string[];
        missing: Array<{ name: string; error: string }>;
        suggestions: Record<string, string[]>;
      } = { requireAvailable: false, resolved: [], missing: [], suggestions: {} };

      const req = (window as any).require;
      out.requireAvailable = typeof req === 'function';
      if (!out.requireAvailable) return out;

      for (const name of names) {
        try {
          const mod = req(name);
          if (mod) out.resolved.push(name);
          else out.missing.push({ name, error: 'resolved to a falsy value' });
        } catch (err: any) {
          // The real reason, not the minified rethrow the callers see.
          out.missing.push({
            name,
            error: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`.slice(0, 200),
          });
        }
      }

      // For each missing module, look for renamed candidates in the
      // module registry so the fix has concrete names to target.
      try {
        const registry = (window as any).__debug?.modulesMap
          ?? (window as any).require?.('__debug')?.modulesMap;
        if (registry && typeof registry === 'object') {
          const allNames = Object.keys(registry);
          for (const { name } of out.missing) {
            // Match on the distinctive tail, e.g. 'DownloadManager'.
            const stem = name.replace(/^WAWeb/, '');
            out.suggestions[name] = allNames
              .filter((k) => k !== name && k.includes(stem))
              .slice(0, 8);
          }
        }
      } catch { /* registry introspection is best-effort */ }

      return out;
    }, [...PROBED_MODULES]);

    const out: ModuleProbeResult = {
      // `ok` requires BOTH a reachable require AND nothing missing. Without
      // that first clause an absent window.require yields an empty `missing`
      // list and would report healthy while every path is broken — the same
      // false-green shape as the connector status that lied for six days.
      ok: result.requireAvailable && result.missing.length === 0,
      requireAvailable: result.requireAvailable,
      resolved: result.resolved,
      missing: result.missing,
      suggestions: Object.keys(result.suggestions ?? {}).length ? result.suggestions : undefined,
    };
    log.info('module probe complete', {
      requireAvailable: out.requireAvailable,
      resolvedCount: out.resolved.length,
      missing: out.missing.map((m) => m.name),
    });
    return out;
  } catch (error: any) {
    log.warn('module probe failed', { error: error?.message });
    return { ...empty, error: String(error?.message ?? error).slice(0, 300) };
  }
}
