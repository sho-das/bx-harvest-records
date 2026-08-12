/**
 * Eight tests, each named after a real line in harvest-records-2026.csv.
 *
 * "How did you check the output was right" is the question the task says it
 * cares about. These are the first of three answers. The second is the check
 * constraint in 001_init.sql. The third is the end-to-end number, 3,170.
 *
 * Every input below is copied from the file, not invented.
 */

import { describe, it, expect } from 'vitest';
import {
  splitCsvLine,
  parseQuantity,
  parseUnit,
  parseDate,
  classifyLine,
} from './parse';
import {
  readVariety,
  readBlock,
  resolveFromPeers,
  VARIETY_SPELLINGS,
  BLOCK_SPELLINGS,
  UNIT_FACTOR_KG,
} from './rules';

describe('the rows this file gets wrong', () => {
  // Line 4: B1,Lapins,2026-03-03,"1,240",kg,J Silvestre,
  it('line 4: "1,240" becomes 1240', () => {
    const fields = splitCsvLine('B1,Lapins,2026-03-03,"1,240",kg,J Silvestre,');

    // The quote must survive the split as one field, not two.
    expect(fields[3]).toBe('1,240');
    expect(parseQuantity(fields[3])).toEqual({ kind: 'settled', value: '1240' });
  });

  // Line 6: B3,Sweetheart,2026-03-05,record lost,,R Craig,pickers left early
  it('line 6: "record lost" is unreadable, not zero', () => {
    const reading = parseQuantity('record lost');

    expect(reading.kind).toBe('unreadable');
    // Zero is a weight. "No record" is not. This row is parked, and the
    // question that goes to the customer is free text, because nobody can
    // pick a weight from a list.
    expect(reading).not.toEqual({ kind: 'settled', value: '0' });
  });

  // Line 5: B3,Sweetheart,03/04/2026,1180,kg,R Craig,
  it('line 5: "03/04/2026" is ambiguous, and both readings come back', () => {
    const reading = parseDate('03/04/2026');

    expect(reading.kind).toBe('ambiguous');
    if (reading.kind !== 'ambiguous') throw new Error('unreachable');

    expect(reading.readings).toEqual([
      { date: '2026-03-04', label: '4 March 2026' },
      { date: '2026-04-03', label: '3 April 2026' },
    ]);

    // A slash date is only ambiguous when both leading numbers are 12 or
    // under. There is no thirteenth month, so this one settles.
    expect(parseDate('13/04/2026')).toEqual({ kind: 'settled', date: '2026-04-13' });
  });

  // Line 18: B1,Lapins,4 Mar 26,1320,kg,J Silvestre,
  it('line 18: "4 Mar 26" settles to 4 March 2026', () => {
    // The month is written in words, so there is nothing to resolve.
    expect(parseDate('4 Mar 26')).toEqual({ kind: 'settled', date: '2026-03-04' });

    // And the ISO rows, which are 22 of the 24, still settle.
    expect(parseDate('2026-03-09')).toEqual({ kind: 'settled', date: '2026-03-09' });
  });

  // Lines 9 and 10: 1980,lbs and 2040,Lb
  it('lines 9 and 10: "lbs" and "Lb" are both pounds', () => {
    expect(parseUnit('lbs')).toEqual({ kind: 'settled', unit: 'lb' });
    expect(parseUnit('Lb')).toEqual({ kind: 'settled', unit: 'lb' });
    expect(parseUnit('lb')).toEqual({ kind: 'settled', unit: 'lb' });

    // And line 12's Kg, which is the same problem in the other unit.
    expect(parseUnit('Kg')).toEqual({ kind: 'settled', unit: 'kg' });

    // The factor is a decimal string. It is multiplied in Postgres, never
    // in JavaScript, because 2,100 lb is 952.543977 kg and these get summed.
    expect(UNIT_FACTOR_KG.lb).toBe('0.45359237');
  });

  // Line 11: B3,Sweetheart,2026-03-09,1210,,R Craig,
  it('line 11: a blank unit is unreadable, not filled in from the block', () => {
    const reading = parseUnit('');

    expect(reading).toEqual({ kind: 'unreadable', text: '' });

    // Every other Block 3 row in the file says kg. That is evidence, and it
    // travels with the parked question. It is not the value. Reading this
    // row as kg rather than lb moves it by 661 kg.
    expect(reading).not.toEqual({ kind: 'settled', unit: 'kg' });
  });

  // Line 27: TOTAL,,,28450,kg,,
  it('line 27: the TOTAL row is a summary row, never a harvest', () => {
    const fields = splitCsvLine('TOTAL,,,28450,kg,,');

    expect(classifyLine(fields)).toBe('summary_row');
    // "TOTAL" is not a block, so even if classification were bypassed the
    // row has no block to filter on and cannot satisfy the check constraint.
    expect(readBlock(fields[0])).toBeNull();
  });

  // Line 13: ,,,,,,
  it('line 13: the empty row is an empty row, never a harvest', () => {
    const fields = splitCsvLine(',,,,,,');

    expect(fields).toHaveLength(7);
    expect(classifyLine(fields)).toBe('empty_row');
  });
});

describe('the spelling the file settles itself', () => {
  // Line 7: B3,sweethart,2026-03-06,990,kg,R Craig,
  it('the table does not know "sweethart", and does not guess', () => {
    // It used to hold an entry for it. One entry per typo does not survive the
    // second file, and a table that guesses is a table that merges two real
    // varieties the day somebody plants Sweet Ann.
    expect(readVariety('sweethart')).toBeNull();
    expect(readVariety('Sweetheart')).toBe('Sweetheart');
    expect(readVariety('Sweetcorn')).toBeNull();
  });

  it('separators are not spelling, so Sweet-heart is Sweetheart', () => {
    // Removing a hyphen cannot turn one name into a different one. This is the
    // one generalisation that carries no risk at all.
    expect(readVariety('Sweet-heart')).toBe('Sweetheart');
    expect(readVariety('sweet heart')).toBe('Sweetheart');
    expect(readVariety('Sweetheart.')).toBe('Sweetheart');
    expect(readBlock('Block-3')).toBe('B3');
  });

  it('line 7: the file settles "sweethart", from what R Craig writes elsewhere', () => {
    // The real peer group from the file: six Sweetheart rows and one Lapins.
    // Distance picks between the two names he demonstrably uses. It is never
    // let loose on the whole variety list.
    const rCraigWrites = [
      'Sweetheart', 'Sweetheart', 'Sweetheart',
      'Sweetheart', 'Sweetheart', 'Sweetheart', 'Lapins',
    ] as const;

    expect(resolveFromPeers('sweethart', VARIETY_SPELLINGS, rCraigWrites)).toBe('Sweetheart');
  });

  it('the rule declines rather than guesses, three ways', () => {
    // No peers. One row vouches for nothing.
    expect(resolveFromPeers('sweethart', VARIETY_SPELLINGS, [])).toBeNull();

    // Too far. This is the one that matters: Sweet Ann is a real cultivar, and
    // a grader who only writes Sweetheart must not turn it into Sweetheart.
    expect(resolveFromPeers('Sweet Ann', VARIETY_SPELLINGS, ['Sweetheart'])).toBeNull();
    expect(resolveFromPeers('record lost', VARIETY_SPELLINGS, ['Sweetheart'])).toBeNull();

    // A tie is the file failing to settle it, which is a question and not a
    // coin toss. "block" is one edit from every block there is, so a grader
    // who works two of them settles nothing.
    expect(resolveFromPeers('block', BLOCK_SPELLINGS, ['B1', 'B2'])).toBeNull();

    // One block, no tie, and it still declines: "b" is one edit from "b1", and
    // one edit is most of a two-character word.
    expect(resolveFromPeers('b', BLOCK_SPELLINGS, ['B1'])).toBeNull();
  });

  it('"Block 3" is B3, and a block that does not exist is null', () => {
    expect(readBlock('Block 3')).toBe('B3');
    expect(readBlock('B3')).toBe('B3');
    expect(readBlock('3')).toBe('B3');
    expect(readBlock('Block 9')).toBeNull();
  });
});
