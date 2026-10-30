/**
 * How several readings that land in one period become that period's figure.
 *
 * The host decides per target, because it depends on what the target measures:
 * a count of sales adds up (sum), a percentage held over the period averages
 * (mean), a rating or a balance takes the most recent value (latest).
 */
export type Aggregation = 'sum' | 'mean' | 'latest';

/** Items oldest first; `seq` orders them when given. null when nothing is a number. */
export const aggregate = (
  items: Array<{ seq?: number; value?: number | null }>,
  how: Aggregation,
): number | null => {
  const xs = items
    .map((it, i) => ({ seq: Number(it.seq ?? i + 1) || 0, value: it.value == null ? null : Number(it.value) }))
    .filter((it): it is { seq: number; value: number } => it.value !== null && Number.isFinite(it.value));
  if (!xs.length) return null;
  if (how === 'latest') return [...xs].sort((a, b) => b.seq - a.seq)[0]!.value;
  const total = xs.reduce((a, b) => a + b.value, 0);
  return how === 'mean' ? total / xs.length : total;
};
