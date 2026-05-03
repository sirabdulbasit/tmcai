/**
 * Drop-in replacement for empty `.catch(() => {})` blocks.
 *
 * The original code-review session flagged 36 silent catches across
 * the codebase that were swallowing errors with no observability. Some
 * are legitimate (fire-and-forget notification enqueue), but most
 * weren't — making it impossible to diagnose why background work
 * silently failed.
 *
 * Usage — replace:
 *
 *     await thing().catch(() => {});
 *
 * with:
 *
 *     await thing().catch(swallowedError('thing-context'));
 *
 * The label appears in the warn log so we can grep for which calls
 * are firing. Returns the original empty-catch behaviour (resolves to
 * undefined) so callers don't change.
 */
import createLogger from './logger';

const log = createLogger('swallowed');

export function swallowedError(context: string): (err: unknown) => void {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`swallowed at ${context}`, { error: msg.slice(0, 240) });
  };
}

/** Variant that returns a typed value (for use with `.catch(swallowedAndReturn(label, fallback))`). */
export function swallowedAndReturn<T>(context: string, fallback: T): (err: unknown) => T {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`swallowed at ${context}`, { error: msg.slice(0, 240) });
    return fallback;
  };
}
