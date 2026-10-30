/**
 * Reducing external records to FIELD-WISE employee suggestions.
 * ============================================================
 *
 * An employee mapping is a decision about a FIELD, not about a person:
 * "departmentName → department" is approved once and applies to everyone it
 * matches, on every run. Earlier versions emitted one suggestion per person,
 * which put ~1,200 near-identical rows in front of an admin who only ever makes
 * one decision, and implied — wrongly — that each person was approved
 * separately.
 *
 * This module is where the whole record set collapses into one row per mapping.
 * It is deliberately PURE — no database, no network, no AI — so the invariant
 * "employee suggestions are field-wise" is enforced by tests rather than by
 * care. Reading the records and looking up the users happens in the caller.
 *
 * A working-profile attribute is the same shape of decision — "AAI → Function
 * Output" is approved once and applies to everyone the feed covers — so it
 * collapses here too, into its own kind of row.
 */


/** Read a dotted path out of a record ("profile.department"). */
export const digPath = (obj: unknown, path: string): unknown =>
  String(path ?? '')
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
      obj,
    );

/* ── source-field discovery (wizard step 3) ─────────────────────────────── */

/** One field the external system actually returns, as offered to the admin. */
export interface DiscoveredField {
  /** Dotted path into a record ("profile.department"). */
  path: string;
  /** What the values look like, judged from the data rather than the docs. */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'mixed' | 'empty';
  /** Records where this path carries a real (non-blank) value. */
  filled: number;
  /** Records examined. */
  total: number;
  /** A few distinct example values, so the admin can see what it really holds. */
  samples: string[];
  /** How many distinct non-blank values were seen. */
  distinct: number;
  /**
   * Every distinct value with the number of records carrying it, for a field
   * that holds a small set of them.
   *
   * Examples alone say what a field looks like; this says what the feed IS.
   * "index: AAI 250, ACI 250" over 500 records is two rows per person and a
   * column that decides what the figure means — the thing an admin has to see
   * before mapping, and the thing three example values hide. Absent for a
   * field that holds a different value every time, where a list of 500 codes
   * tells nobody anything.
   */
  values?: Array<{ value: string; count: number }>;
}

const MAX_DEPTH = 3;
const MAX_SAMPLES_PER_FIELD = 3;
/** Above this many distinct values, the list stops being a description. */
const MAX_LISTED_VALUES = 12;
/** Counting stops here: a field with this many distinct values is never listed. */
const MAX_COUNTED_VALUES = 500;

const typeOf = (v: unknown): DiscoveredField['type'] => {
  if (v === null || v === undefined || String(v).trim() === '') return 'empty';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'string';
  }
};

/**
 * Enumerate every field the source returns, with a fill rate and real examples.
 *
 * The admin picks from this list rather than trusting the documentation: a
 * document can describe a field the API never sends, and — as happened here —
 * name a field whose values mean something quite different from what the name
 * suggests ("businessUnit" holding a legal entity, not a team). Showing the
 * values is what makes that visible before anything is mapped.
 *
 * Nested objects are flattened to dotted paths up to MAX_DEPTH. Arrays are
 * reported as arrays rather than exploded — there is no single value to map.
 */
export const discoverSourceFields = (
  records: Array<Record<string, unknown>>,
): DiscoveredField[] => {
  const acc = new Map<string, {
    types: Set<string>; filled: number; samples: string[];
    counts: Map<string, number>; overflowed: boolean;
  }>();
  const total = records?.length ?? 0;

  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (
      depth < MAX_DEPTH
      && value && typeof value === 'object' && !Array.isArray(value)
    ) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, prefix ? `${prefix}.${k}` : k, depth + 1);
      }
      return;
    }
    if (!prefix) return;
    const entry = acc.get(prefix)
      ?? { types: new Set<string>(), filled: 0, samples: [], counts: new Map<string, number>(), overflowed: false };
    const t = typeOf(value);
    entry.types.add(t);
    if (t !== 'empty') {
      entry.filled++;
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;
      if (entry.samples.length < MAX_SAMPLES_PER_FIELD && !entry.samples.includes(short)) {
        entry.samples.push(short);
      }
      const seen = entry.counts.get(short);
      if (seen !== undefined) entry.counts.set(short, seen + 1);
      else if (entry.counts.size < MAX_COUNTED_VALUES) entry.counts.set(short, 1);
      else entry.overflowed = true;
    }
    acc.set(prefix, entry);
  };

  for (const rec of records ?? []) visit(rec, '', 0);

  return [...acc.entries()]
    .map(([path, e]) => {
      const real = [...e.types].filter((t) => t !== 'empty');
      const type: DiscoveredField['type'] =
        real.length === 0 ? 'empty'
          : real.length === 1 ? (real[0] as DiscoveredField['type'])
            : 'mixed';
      const distinct = e.counts.size;
      const values = !e.overflowed && distinct > 0 && distinct <= MAX_LISTED_VALUES
        ? [...e.counts.entries()]
          .map(([value, count]) => ({ value, count }))
          // Commonest first: the shape of the feed, not the alphabet.
          .sort((x, y) => y.count - x.count || x.value.localeCompare(y.value))
        : undefined;
      // Spread rather than `values: undefined` — the field is absent when there
      // is no list to give, not present and empty.
      return { path, type, filled: e.filled, total, samples: e.samples, distinct, ...(values ? { values } : {}) };
    })
    // Most-populated first: a field present on every record is the likeliest
    // thing to map, and an always-empty one should not head the list.
    .sort((a, b) => b.filled - a.filled || a.path.localeCompare(b.path));
};

/* ── coverage: every source field accounted for ─────────────────────────── */

export interface FieldCoverage {
  /** The field as the external system names it. */
  source: string;
  /** Records carrying a real value. */
  filled: number;
  total: number;
  /** One real value, so the meaning is visible rather than guessed from the name. */
  example: string | null;
  /** A few distinct examples, for a field holding too many values to list. */
  samples: string[];
  /** How many distinct non-blank values the field holds. */
  distinct: number;
  /** Every value with its count, for a field holding few — see DiscoveredField. */
  values?: Array<{ value: string; count: number }>;
  /** The the host application field it maps onto, or null when it maps nowhere. */
  target: string | null;
  /** Why it maps nowhere — 'blocked' is a rule, 'unmapped' is a choice. */
  status: 'mapped' | 'blocked' | 'unmapped';
  /** Plain-language reason, shown to the admin. */
  note: string;
}

/**
 * Account for EVERY field the system returns, not just the ones that were used.
 *
 * A proposal that lists only its own mappings cannot be checked: the admin has
 * no way to see that a field exists and was passed over, or that one is blocked
 * by a rule rather than overlooked. Showing all of them turns "did it read
 * everything?" into something answerable at a glance.
 */
/** What a field does in a feed, and the sentence that says so on screen. */
export interface RoleTarget { target: string; note: string }

/**
 * Which source field plays which part in a goal or working-profile feed.
 *
 * An employee feed maps a field onto a column, and its coverage says so. A goal
 * or working-profile feed maps fields too, only into roles rather than columns
 * — who the record is about, the figure, the period — and the field table was
 * built only for employee feeds, so Attendance and DAL showed the admin no
 * field table at all while the HR system showed one. Takes the connector's shape
 * structurally so this module stays a leaf.
 *
 * A working-profile feed's figure is per attribute (`ewpFieldMap`), so its
 * `valueField` is not claimed: saying "Written to each matched goal" about a
 * feed that writes no goal would be the exact disagreement this table is for.
 */
export const readRoleTargets = (
  connector: {
    identityField?: string | null; valueField?: string | null;
    periodField?: string | null; labelField?: string | null;
    ewpFieldMap?: Record<string, string> | null;
    goalTitleMap?: Record<string, string> | null;
  },
  target: 'goals' | 'ewp',
  attributeLabels: Map<string, string>,
): Record<string, RoleTarget> => {
  const out: Record<string, RoleTarget> = {};
  const put = (field: string | null | undefined, role: RoleTarget) => {
    if (field && String(field).trim()) out[String(field).trim()] = role;
  };
  put(connector.labelField, { target: 'label', note: 'Names the figure on the review rows.' });
  put(connector.periodField, { target: 'period', note: 'The period each figure belongs to.' });
  if (target === 'goals') {
    put(connector.valueField, { target: 'goal actual', note: 'Written to each matched goal as its actual.' });
    // Title → field, read the other way round: which titles each field feeds.
    const titlesByField = new Map<string, string[]>();
    for (const [title, field] of Object.entries(connector.goalTitleMap ?? {})) {
      titlesByField.set(field, [...(titlesByField.get(field) ?? []), title]);
    }
    for (const [field, titles] of titlesByField) {
      put(field, {
        target: `goal: ${titles.join(', ')}`,
        note: 'The actual of each person\'s goal with this title — written only to goals set to Integration.',
      });
    }
  } else {
    for (const [src, key] of Object.entries(connector.ewpFieldMap ?? {})) {
      const label = attributeLabels.get(key) ?? key;
      put(src, { target: label, note: `Recorded each month as ${label} on the working profile.` });
    }
  }
  // Last, so it wins: the field that names the person is that before anything.
  put(connector.identityField, { target: 'person', note: 'Identifies the person each record is about — never written.' });
  return out;
};

export const buildFieldCoverage = (
  discovered: DiscoveredField[],
  // A column name ("department") for an employee feed, or a role with its own
  // sentence for a goal or working-profile feed.
  fieldMap: Record<string, string | RoleTarget>,
  isBlocked: (sourceField: string) => string | null,
): FieldCoverage[] => {
  const mapped = new Map<string, RoleTarget>();
  for (const [src, vm] of Object.entries(fieldMap ?? {})) {
    mapped.set(src.toLowerCase(), typeof vm === 'string' ? { target: vm, note: `Updates ${vm}.` } : vm);
  }

  return discovered.map((d) => {
    // What the field holds travels with every row, whatever its status: the
    // breakdown is how an admin tells a discriminator column from a figure.
    const holds = {
      samples: d.samples, distinct: d.distinct, ...(d.values ? { values: d.values } : {}),
    };
    const role = mapped.get(d.path.toLowerCase()) ?? null;
    if (role) {
      return {
        source: d.path, filled: d.filled, total: d.total,
        example: d.samples[0] ?? null, ...holds, target: role.target, status: 'mapped' as const,
        note: role.note,
      };
    }
    const blocked = isBlocked(d.path);
    if (blocked) {
      return {
        source: d.path, filled: d.filled, total: d.total,
        example: d.samples[0] ?? null, ...holds, target: null, status: 'blocked' as const,
        note: blocked,
      };
    }
    return {
      source: d.path, filled: d.filled, total: d.total,
      example: d.samples[0] ?? null, ...holds, target: null, status: 'unmapped' as const,
      note: d.filled === 0
        ? 'Always empty in this system — nothing to copy.'
        : 'Not mapped. Ask for it in your brief if it should be.',
    };
  });
};

/* ── mapping risk: what the data itself reveals ─────────────────────────── */

export interface MappingShape {
  /** Distinct non-blank values the SOURCE field carries. */
  sourceDistinct: number;
  /** Mean character length of those values. */
  sourceAvgLength: number;
  /** Distinct values the the host application TARGET column holds today. */
  targetDistinct: number;
  /** Mean character length of the target's current values. */
  targetAvgLength: number;
  /** People whose value would be replaced (not filled from blank). */
  overwrites: number;
}

export type RiskSeverity = 'none' | 'warn' | 'block';

export interface MappingRisk {
  severity: RiskSeverity;
  /** Machine-readable so a future autonomy setting can gate on it. */
  code: 'collapses_taxonomy' | 'value_shape_mismatch' | 'never_populated' | 'none';
  /** One sentence an administrator can act on. */
  reason: string;
}

/**
 * Judge a proposed mapping from the DATA, not the field names.
 *
 * Every wrong mapping this system has produced was wrong in a way the values
 * showed plainly while the names looked right:
 *
 *   businessUnit → team   10 distinct values replacing 52 — every delivery team
 *                         collapsed into 8 legal-entity names, 924 people.
 *   location → city       values averaging 83 characters (full postal
 *                         addresses) into a field holding "Lahore".
 *
 * Both are arithmetic, so they belong in code rather than in a prompt or in an
 * administrator's vigilance. Returns a severity so the same check can warn a
 * human today and block an unattended mapping later.
 */
export const assessMappingRisk = (shape: MappingShape): MappingRisk => {
  const {
    sourceDistinct, sourceAvgLength, targetDistinct, targetAvgLength, overwrites,
  } = shape;

  if (sourceDistinct === 0) {
    return {
      severity: 'block',
      code: 'never_populated',
      reason: 'This field is empty in every record, so the mapping would do nothing.',
    };
  }

  // Replacing a richer taxonomy with a poorer one destroys information. Only a
  // concern when real values are being overwritten — filling blanks loses nothing.
  if (overwrites > 0 && targetDistinct >= 8 && sourceDistinct * 2 <= targetDistinct) {
    return {
      severity: 'block',
      code: 'collapses_taxonomy',
      reason: `The source has only ${sourceDistinct} distinct value(s) where the host application holds `
        + `${targetDistinct}. Applying it would collapse ${targetDistinct} values into `
        + `${sourceDistinct} for ${overwrites} people — usually a sign the two fields mean `
        + 'different things.',
    };
  }

  // A field holding sentences does not belong in one holding labels.
  if (targetAvgLength > 0 && sourceAvgLength > Math.max(40, targetAvgLength * 3)) {
    return {
      severity: 'block',
      code: 'value_shape_mismatch',
      reason: `Source values average ${Math.round(sourceAvgLength)} characters against `
        + `${Math.round(targetAvgLength)} in the host application — these look like different kinds of `
        + 'information, not the same one.',
    };
  }

  return { severity: 'none', code: 'none', reason: '' };
};

/** Distinct count and mean length of a set of raw values. */
export const profileValues = (values: Array<unknown>): { distinct: number; avgLength: number } => {
  const clean = (values ?? [])
    .map((v) => String(v ?? '').trim())
    .filter((v) => v !== '');
  if (clean.length === 0) return { distinct: 0, avgLength: 0 };
  return {
    distinct: new Set(clean).size,
    avgLength: clean.reduce((n, v) => n + v.length, 0) / clean.length,
  };
};
