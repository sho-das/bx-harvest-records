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
 * `sweethart` is the one that matters: R Craig spells it correctly on his six
 * other Block 3 rows, so the file itself answers this one. It is a typo, not a
 * different variety.
 */
export const VARIETY_SPELLINGS: Record<string, Variety> = {
  sweetheart: 'Sweetheart',
  sweethart: 'Sweetheart',
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

function key(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function readBlock(raw: string | null | undefined): Block | null {
  if (!raw) return null;
  return BLOCK_SPELLINGS[key(raw)] ?? null;
}

export function readVariety(raw: string | null | undefined): Variety | null {
  if (!raw) return null;
  return VARIETY_SPELLINGS[key(raw)] ?? null;
}

export function readUnit(raw: string | null | undefined): Unit | null {
  if (!raw) return null;
  return UNIT_SPELLINGS[key(raw)] ?? null;
}
