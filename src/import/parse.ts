/**
 * Readers for the four columns the file gets wrong.
 *
 * Every reader returns one of three shapes:
 *
 *   settled     the file has one reading, and this is it
 *   ambiguous   the file has more than one reading, and here they are
 *   unreadable  the file has no reading at all
 *
 * `settled` becomes a value. `ambiguous` and `unreadable` become a parked
 * question. Nothing here ever guesses (see "The line between the two groups"
 * in 02-decisions.md).
 */

import { readUnit, type Unit } from './rules';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Splits one CSV line into fields, honouring double quotes.
 *
 * Written by hand rather than pulling in a parser: the file has exactly one
 * quoted field, `"1,240"` on line 4, and the quoting rule is four lines long.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'; // an escaped quote inside a quoted field
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields.map((f) => f.trim());
}

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

export type QuantityReading =
  | { kind: 'settled'; value: string }
  | { kind: 'unreadable'; text: string };

/**
 * `"1,240"` becomes 1240. A quoted thousands separator has one reading (B8).
 * `record lost` is unreadable. It is not zero, and it must never be read as
 * zero, because zero is a weight and "no record" is not.
 *
 * Returns the number as a string. It goes to Postgres as NUMERIC and is never
 * a JavaScript number on the way (A6).
 */
export function parseQuantity(raw: string | null | undefined): QuantityReading {
  const text = (raw ?? '').trim();
  if (text === '') return { kind: 'unreadable', text: '' };

  const stripped = text.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(stripped)) {
    return { kind: 'settled', value: stripped };
  }
  return { kind: 'unreadable', text };
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export type UnitReading =
  | { kind: 'settled'; unit: Unit }
  | { kind: 'unreadable'; text: string };

/**
 * `kg`, `Kg`, `lb`, `lbs` and `Lb` all settle. Casing and plurals are
 * spelling, not meaning (B8).
 *
 * A blank unit is unreadable, never filled in. A wrong unit moves a row by
 * 2.2x (lb) or 1000x (g), and nothing in the row itself says which (B2).
 */
export function parseUnit(raw: string | null | undefined): UnitReading {
  const text = (raw ?? '').trim();
  if (text === '') return { kind: 'unreadable', text: '' };

  const unit = readUnit(text);
  if (unit) return { kind: 'settled', unit };
  return { kind: 'unreadable', text };
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

export type DateReading =
  | { kind: 'settled'; date: string }
  | { kind: 'ambiguous'; readings: { date: string; label: string }[] }
  | { kind: 'unreadable'; text: string };

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function label(year: number, month: number, day: number): string {
  return `${day} ${MONTH_LABELS[month - 1]} ${year}`;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Three formats appear in the file.
 *
 *   2026-03-09   settled. 22 rows.
 *   4 Mar 26     settled. The month is written in words, so there is nothing
 *                to resolve (B8). A two-digit year means 2000 + YY.
 *   03/04/2026   ambiguous. Both 4 March and 3 April are valid readings, so
 *                there is no correct value hiding in the file (B3).
 *
 * A slash date is only ambiguous when both leading numbers are 12 or under.
 * `13/04/2026` has one reading, because there is no thirteenth month.
 *
 * Row position was tested as evidence and rejected: line 18 (`4 Mar 26`) sits
 * between 12 and 13 March, so this file demonstrably misplaces rows.
 */
export function parseDate(raw: string | null | undefined): DateReading {
  const text = (raw ?? '').trim();
  if (text === '') return { kind: 'unreadable', text: '' };

  // 2026-03-09
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const year = Number(y), month = Number(m), day = Number(d);
    if (isRealDate(year, month, day)) {
      return { kind: 'settled', date: iso(year, month, day) };
    }
    return { kind: 'unreadable', text };
  }

  // 4 Mar 26  /  4 March 2026
  const wordMatch = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{2}|\d{4})$/.exec(text);
  if (wordMatch) {
    const [, d, monthWord, y] = wordMatch;
    const month = MONTH_NAMES[monthWord.slice(0, 3).toLowerCase()];
    if (month) {
      const day = Number(d);
      const year = y.length === 2 ? 2000 + Number(y) : Number(y);
      if (isRealDate(year, month, day)) {
        return { kind: 'settled', date: iso(year, month, day) };
      }
    }
    return { kind: 'unreadable', text };
  }

  // 03/04/2026
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (slashMatch) {
    const [, first, second, y] = slashMatch;
    const a = Number(first), b = Number(second);
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);

    const dayMonth = isRealDate(year, b, a) ? { day: a, month: b } : null; // DD/MM
    const monthDay = isRealDate(year, a, b) ? { day: b, month: a } : null; // MM/DD

    if (dayMonth && monthDay) {
      // Listed month-first then day-first, so the earlier calendar date for
      // this file's one case (4 March) is offered first.
      return {
        kind: 'ambiguous',
        readings: [
          { date: iso(year, monthDay.month, monthDay.day), label: label(year, monthDay.month, monthDay.day) },
          { date: iso(year, dayMonth.month, dayMonth.day), label: label(year, dayMonth.month, dayMonth.day) },
        ],
      };
    }
    const only = dayMonth ?? monthDay;
    if (only) return { kind: 'settled', date: iso(year, only.month, only.day) };
    return { kind: 'unreadable', text };
  }

  return { kind: 'unreadable', text };
}

// ---------------------------------------------------------------------------
// Is this line a harvest record at all?
// ---------------------------------------------------------------------------

export type LineKind = 'record' | 'empty_row' | 'summary_row';

/**
 * Line 13 is `,,,,,,` and line 27 is `TOTAL,,,28450,kg,,`.
 *
 * Both get stored, both are `not_a_record`, neither is ever countable (A4).
 * If TOTAL is counted as a harvest, every number after it is wrong. Deleting
 * it means nobody can later prove what the file contained.
 */
export function classifyLine(fields: string[]): LineKind {
  const nonEmpty = fields.filter((f) => f.trim() !== '');
  if (nonEmpty.length === 0) return 'empty_row';

  const block = (fields[0] ?? '').trim().toLowerCase();
  if (block === 'total' || block === 'totals' || block === 'sum') {
    return 'summary_row';
  }
  return 'record';
}
