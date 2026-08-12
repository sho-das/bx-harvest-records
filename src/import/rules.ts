/**
 * Every lookup table in the project lives here.
 *
 * A year from now, changing how a spelling is read means opening this one
 * file. Nothing else decides what a value means.
 *
 * B1 and B7 in 02-decisions.md: lookup tables, not fuzzy matching. A lookup
 * table is explicit and a person can read it. Fuzzy matching would silently
 * merge two real varieties one day.
 */

export const SOURCE_FILE = 'harvest-records-2026.csv';

/** The blocks that exist. A filter naming anything else is rejected (C3). */
export const BLOCKS = ['B1', 'B2', 'B3', 'B4'] as const;
export type Block = (typeof BLOCKS)[number];

/** The varieties that exist. */
export const VARIETIES = ['Sweetheart', 'Lapins', 'Regina'] as const;
export type Variety = (typeof VARIETIES)[number];

/**
 * How a block can be written. The customer says "Block 3", the file says "B3".
 * Keys are compared lowercased with spaces collapsed.
 */
export const BLOCK_SPELLINGS: Record<string, Block> = {
  b1: 'B1',
  'block 1': 'B1',
  '1': 'B1',
  b2: 'B2',
  'block 2': 'B2',
  '2': 'B2',
  b3: 'B3',
  'block 3': 'B3',
  '3': 'B3',
  b4: 'B4',
  'block 4': 'B4',
  '4': 'B4',
};

/**
 * How a variety can be written.
 *
 * `sweethart` is deliberately not here. It used to be, and a hand-written entry
 * per typo does not survive the second file. It is resolved instead by
 * `resolveFromPeers` below, from what the grader who wrote it writes on their
 * other rows, which is the reason it was safe to accept in the first place.
 */
export const VARIETY_SPELLINGS: Record<string, Variety> = {
  sweetheart: 'Sweetheart',
  lapins: 'Lapins',
  regina: 'Regina',
};

export type Unit = 'kg' | 'lb' | 'g';

/**
 * How a unit can be written. The file uses kg, Kg, lb, lbs and Lb.
 * Casing and plurals are spelling, not meaning (B8).
 *
 * `g` never appears in the file. It is here because it is offered as an
 * option on the line 11 park, and an option needs a factor to be costed.
 */
export const UNIT_SPELLINGS: Record<string, Unit> = {
  kg: 'kg',
  kgs: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  g: 'g',
  gram: 'g',
  grams: 'g',
};

/**
 * Kilograms per unit, as decimal strings.
 *
 * These are handed to Postgres and multiplied there, never in JavaScript.
 * 2,100 lb is 952.543977 kg, which binary floating point cannot hold exactly,
 * and these values get summed (A6).
 */
export const UNIT_FACTOR_KG: Record<Unit, string> = {
  kg: '1',
  lb: '0.45359237',
  g: '0.001',
};

/**
 * What unit each block is habitually written in.
 *
 * This supplies the evidence sentence that travels with a park. It never
 * supplies the value (B2). The block-to-unit rule is strong evidence, and
 * strong evidence is not the same as the number the row carried.
 *
 * Derived from the file: J Silvestre works B1 in kg, R Craig works B3 in kg,
 * M Reid works B2 in pounds ("US buyer sheet") and B4 in kg. The unit follows
 * the block, not the person.
 */
export const BLOCK_UNIT_HABIT: Record<Block, Unit> = {
  B1: 'kg',
  B2: 'lb',
  B3: 'kg',
  B4: 'kg',
};

/**
 * How a written value is compared with the tables above.
 *
 * Lowercased, and everything that is not a letter or a digit becomes a space.
 * That is separator removal, not guessing: `Sweet-heart`, `Sweet heart` and
 * `Sweetheart.` all reduce to the same thing, and no separator can turn one
 * name into a different one. `Sweet Ann` reduces to `sweet ann`, which is
 * still not `sweetheart`.
 *
 * The spaces are then dropped for the lookup, so `sweet heart` matches
 * `sweetheart`. They are kept in `tokens()` below, where word boundaries are
 * the whole point.
 */
function key(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The lookup form: no separators at all. */
export function squashed(raw: string): string {
  return key(raw).replace(/ /g, '');
}

/** The same table, keyed by its squashed form, built once. */
function bySquashedKey<T extends string>(table: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [spelling, value] of Object.entries(table)) out[squashed(spelling)] = value;
  return out;
}

const BLOCK_BY_KEY = bySquashedKey(BLOCK_SPELLINGS);
const VARIETY_BY_KEY = bySquashedKey(VARIETY_SPELLINGS);
const UNIT_BY_KEY = bySquashedKey(UNIT_SPELLINGS);

export function readBlock(raw: string | null | undefined): Block | null {
  if (!raw) return null;
  return BLOCK_BY_KEY[squashed(raw)] ?? null;
}

export function readVariety(raw: string | null | undefined): Variety | null {
  if (!raw) return null;
  return VARIETY_BY_KEY[squashed(raw)] ?? null;
}

export function readUnit(raw: string | null | undefined): Unit | null {
  if (!raw) return null;
  return UNIT_BY_KEY[squashed(raw)] ?? null;
}

// ---------------------------------------------------------------------------
// Resolving a token the tables do not know, from the rest of the file
// ---------------------------------------------------------------------------

/**
 * Edit distance. Insertions, deletions and substitutions, one cost each.
 *
 * It is here to measure a typo, never to choose a meaning on its own. What it
 * chooses between is decided by `resolveFromPeers`, and that list never
 * contains a name the writer does not demonstrably use.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * What a value means when the tables do not know it, decided by the file.
 *
 * `sweethart` on line 7 is not resolved because it looks like `Sweetheart`.
 * Distance alone would fold `Sweet Ann`, a real cultivar, into a different real
 * cultivar the day somebody plants it. It is resolved because R Craig, who
 * wrote it, writes `Sweetheart` on his six other rows and nothing else. The
 * candidates are what the writer actually uses, and distance only picks between
 * those.
 *
 * Three ways to decline, and declining leaves the value unread so the row parks
 * or refuses as it would have anyway:
 *
 *   - No peers. A writer with one row vouches for nothing.
 *   - A tie. Two candidates equally close is the file failing to settle it,
 *     which is a question for the customer and not a coin toss.
 *   - Too far. A typo may change at most a quarter of the word, so a short
 *     name needs an exact-ish match and `record lost` never becomes a variety.
 */
export function resolveFromPeers<T extends string>(
  raw: string | null | undefined,
  table: Record<string, T>,
  peers: readonly T[],
): T | null {
  if (!raw) return null;
  const token = squashed(raw);
  if (!token) return null;

  const ranked = [...new Set(peers)]
    .map((value) => {
      // Measured against the spelling that actually matched, not the longest
      // one this value has. `b` is one edit from `b1`, and judging that against
      // the six characters of `block1` would let a single letter through.
      const scored = spellingsOf(table, value)
        .map((spelling) => squashed(spelling))
        .map((spelling) => ({ spelling, distance: editDistance(token, spelling) }))
        .sort((a, b) => a.distance - b.distance);
      return { value, ...scored[0] };
    })
    .sort((a, b) => a.distance - b.distance);

  const best = ranked[0];
  if (!best) return null;
  if (ranked[1] && ranked[1].distance === best.distance) return null;
  if (best.distance * 4 > Math.max(token.length, best.spelling.length)) return null;
  return best.value;
}

// ---------------------------------------------------------------------------
// Can the reading be traced back to the question?
// ---------------------------------------------------------------------------

/**
 * The tables above decide what a written value means. These two decide
 * something different: whether the value the filter ended up with is one the
 * customer's own words can account for.
 *
 * It is a different question from "does this variety exist", and the whitelist
 * cannot answer it. Ask "how many kilograms of Sweet Ann in Block 3 in March
 * 2026?" with the sentence "in our records Sweet Ann is stored under the name
 * Sweetheart" in front of it, and the model returns Sweetheart. Sweetheart is
 * real, so every guard passes, and the customer gets a true total of a variety
 * they did not ask about. Two of six probes in that shape got through.
 *
 * Nothing here blocks an answer. It says the reading is not traceable, and the
 * page prints that where the customer can see it, which is the cheapest form
 * of showing the reading back before it is trusted.
 */

/** Every way `value` can be written, per the table. */
export function spellingsOf<T extends string>(table: Record<string, T>, value: T): string[] {
  return Object.entries(table)
    .filter(([, mapped]) => mapped === value)
    .map(([spelling]) => spelling);
}

/**
 * True if `phrase` appears in `question` as whole words.
 *
 * Words, not a substring. `"3"` is a spelling of B3, and a raw substring test
 * would find it inside "2026-03-01" and inside "Q3". Separators are ignored on
 * both sides, so `Sweet-heart` and `sweet heart` both match `sweetheart`, and
 * `Block 3` matches `block3`.
 */
export function phraseIn(question: string, phrase: string): boolean {
  const wanted = squashed(phrase);
  if (!wanted) return false;

  const words = key(question).split(' ').filter(Boolean);
  const span = Math.max(4, key(phrase).split(' ').filter(Boolean).length);

  for (let start = 0; start < words.length; start++) {
    let run = '';
    for (let length = 0; length < span && start + length < words.length; length++) {
      run += words[start + length];
      if (run === wanted) return true;
    }
  }
  return false;
}

/** True if any spelling of `value` appears in `question` as whole words. */
export function appearsIn<T extends string>(
  question: string,
  table: Record<string, T>,
  value: T,
): boolean {
  return spellingsOf(table, value).some((spelling) => phraseIn(question, spelling));
}
