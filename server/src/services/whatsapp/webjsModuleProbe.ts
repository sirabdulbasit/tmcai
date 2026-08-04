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

/**
 * Modules whatsapp-web.js@1.34.7 ACTUALLY requires on the broken paths.
 *
 * Verified against the installed library, not guessed — an earlier version
 * of this list probed 'WAWebChatPresence' and 'WAWebSendPresenceJob',
 * which the library never calls, and duly reported them missing. That was
 * a self-inflicted false lead. Every name below is grep-confirmed:
 *   Message.js:519,531       → WAWebCollections
 *   Message.js:559           → WAWebDownloadManager
 *   Injected/Utils.js:1202   → WAWebWidFactory
 *   Injected/Utils.js:1204   → WAWebChatStateBridge   (typing/recording)
 */
export const PROBED_MODULES = [
  // media download (Message.downloadMedia)
  'WAWebCollections',
  'WAWebDownloadManager',
  // chat state: typing + recording + stop (WWebJS.sendChatstate)
  'WAWebChatStateBridge',
  // reactions + generic send
  'WAWebSendReactionMsgAction',
  'WAWebSendMsgChatAction',
  // identity / lid mapping (working — control group)
  'WAWebApiContact',
  'WAWebWidFactory',
] as const;

/**
 * The exact call surfaces the two broken paths touch. Module resolution is
 * not enough: both media modules resolve on this build, so the media
 * failure lives in a property or method INSIDE them (a renamed field, a
 * changed signature, or a missing injected helper). Each entry is
 * evaluated as a dotted path and reported as present / missing / throwing.
 */
export const PROBED_SURFACES = [
  // media chain, in call order
  "require('WAWebCollections').Msg",
  "require('WAWebCollections').Msg.get",
  "require('WAWebCollections').Msg.getMessagesById",
  "require('WAWebDownloadManager').downloadManager",
  "require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt",
  'WWebJS.arrayBufferToBase64Async',
  // chat-state chain
  "require('WAWebChatStateBridge').sendChatStateComposing",
  "require('WAWebChatStateBridge').sendChatStateRecording",
  "require('WAWebChatStateBridge').sendChatStatePaused",
  "require('WAWebWidFactory').createWid",
  // the injected entry point the Chat methods call
  'WWebJS.sendChatstate',
] as const;

export interface ModuleProbeResult {
  ok: boolean;
  /** True when window.require itself is reachable. */
  requireAvailable: boolean;
  resolved: string[];
  missing: Array<{ name: string; error: string }>;
  /** Candidate names discovered by scanning the module registry. */
  suggestions?: Record<string, string[]>;
  /**
   * Per-call-surface verdict: 'function' | 'object' | 'undefined' |
   * 'error: …'. A module can resolve while the method inside it is gone —
   * that is where the media failure must live on this build.
   */
  surfaces?: Record<string, string>;
  error?: string;
}

export interface CallProbeResult {
  ok: boolean;
  steps: Record<string, string>;
  error?: string;
}

/**
 * ARGUMENT probe — the step past existence checks.
 *
 * The surface probe came back entirely healthy on production: every module
 * and every method the broken paths call is present. So `r: r` is thrown
 * when those methods run against REAL arguments, and the most likely
 * suspect is the identity itself: chats arrive as `<digits>@lid`, and
 * `WidFactory.createWid` may reject that domain outright — which would
 * break typing/recording exactly where the archive says it breaks, on
 * @lid chats, while leaving `message.reply()` (no Wid construction) alive.
 *
 * This calls createWid on both spellings and reports the real error. It is
 * PURE: constructing a Wid sends nothing and mutates nothing. No presence
 * is emitted, no media fetched, no message sent.
 */
export async function probeWebjsCallArguments(
  client: any,
  args: { lidId?: string | null; phoneId?: string | null },
): Promise<CallProbeResult> {
  const page = client?.pupPage;
  if (!page || typeof page.evaluate !== 'function') {
    return { ok: false, steps: {}, error: 'no pupPage on client (not initialized?)' };
  }
  try {
    const steps = await page.evaluate((lidId: string | null, phoneId: string | null) => {
      const out: Record<string, string> = {};
      const req = (window as any).require;
      const tryCall = (label: string, fn: () => any) => {
        try {
          const v = fn();
          out[label] = v == null ? 'returned null/undefined' : `ok: ${typeof v}`;
        } catch (err: any) {
          out[label] = `THROWS ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`.slice(0, 200);
        }
      };
      const WidFactory = (() => { try { return req('WAWebWidFactory'); } catch { return null; } })();
      out['WidFactory'] = WidFactory ? 'ok' : 'unavailable';
      if (WidFactory) {
        if (phoneId) tryCall(`createWid('${phoneId}')  [control]`, () => WidFactory.createWid(phoneId));
        if (lidId) tryCall(`createWid('${lidId}')  [lid]`, () => WidFactory.createWid(lidId));
        // Some builds expose a LID-aware constructor; report whether one exists.
        out['WidFactory keys'] = Object.keys(WidFactory).slice(0, 20).join(',');
      }
      return out;
    }, args.lidId ?? null, args.phoneId ?? null);
    const broken = Object.values<string>(steps).filter((v) => v.startsWith('THROWS'));
    log.info('call-argument probe complete', { brokenCount: broken.length });
    return { ok: broken.length === 0, steps };
  } catch (error: any) {
    log.warn('call-argument probe failed', { error: error?.message });
    return { ok: false, steps: {}, error: String(error?.message ?? error).slice(0, 300) };
  }
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
    const result = await page.evaluate(async (names: string[], surfaces: string[]) => {
      const out: {
        requireAvailable: boolean;
        resolved: string[];
        missing: Array<{ name: string; error: string }>;
        suggestions: Record<string, string[]>;
        surfaces: Record<string, string>;
      } = { requireAvailable: false, resolved: [], missing: [], suggestions: {}, surfaces: {} };

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

      // Walk each call surface. Resolution alone hides the real fault when
      // the module exists but the method inside it was renamed.
      for (const expr of surfaces) {
        try {
          const target = expr.startsWith('require(')
            ? (() => {
              const m = /^require\('([^']+)'\)(.*)$/.exec(expr)!;
              let v: any = req(m[1]);
              for (const key of m[2].split('.').filter(Boolean)) v = v?.[key];
              return v;
            })()
            : (() => {
              let v: any = window as any;
              for (const key of expr.split('.').filter(Boolean)) v = v?.[key];
              return v;
            })();
          out.surfaces[expr] = target === undefined || target === null
            ? 'undefined'
            : typeof target;
        } catch (err: any) {
          out.surfaces[expr] = `error: ${err?.message ?? String(err)}`.slice(0, 160);
        }
      }

      return out;
    }, [...PROBED_MODULES], [...PROBED_SURFACES]);

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
      surfaces: result.surfaces,
    };
    log.info('module probe complete', {
      requireAvailable: out.requireAvailable,
      resolvedCount: out.resolved.length,
      missing: out.missing.map((m) => m.name),
      brokenSurfaces: Object.entries<string>(result.surfaces ?? {})
        .filter(([, v]) => v === 'undefined' || v.startsWith('error:'))
        .map(([k]) => k),
    });
    return out;
  } catch (error: any) {
    log.warn('module probe failed', { error: error?.message });
    return { ...empty, error: String(error?.message ?? error).slice(0, 300) };
  }
}
