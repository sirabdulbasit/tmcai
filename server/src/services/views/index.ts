/**
 * Canonical views — the only public entry point for reading user-facing
 * entities. See ./README.md for the contract.
 *
 * Callers should:
 *   import { getOpenItems, getTodayCalendar, getAttentionSurface } from '../views';
 *
 * Never import from the individual files. That keeps the module surface
 * stable so internal refactors (file moves, new helpers) don't ripple
 * to consumers.
 */
export { getOpenItems, countOpenItems } from './openItems';
export type { OpenItemRow, GetOpenItemsOpts } from './openItems';

export { getTodayCalendar } from './calendar';
export type { CalendarEventRow, GetTodayCalendarOpts } from './calendar';

export { getAttentionSurface, countAttentionSurface } from './attention';
export type { AttentionRow, GetAttentionSurfaceOpts } from './attention';
