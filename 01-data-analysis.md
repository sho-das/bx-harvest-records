# 01 - Data analysis: `harvest-records-2026.csv`

What the raw file contains, before any code exists. Line numbers count the header as line 1.

---

## 1. Line count

28 lines. The last one is empty (a trailing newline).

- Line 1 - header: `block,variety,harvest_date,quantity,unit,grader,notes`
- Lines 2-27 - 26 rows
- Of those 26: **24 are harvest records**, 1 is an empty row (line 13), 1 is a `TOTAL` summary row (line 27)

## 2. Values that do not fit their column

| Line | Column | Value as written | Problem |
|---|---|---|---|
| 4 | quantity | `"1,240"` | Comma as thousands separator, quoted |
| 5 | harvest_date | `03/04/2026` | 4 March or 3 April - both readings are valid |
| 6 | quantity | `record lost` | No number at all. Note: "pickers left early" |
| 6 | unit | *(blank)* | No unit written |
| 7 | variety | `sweethart` | Misspelling of `Sweetheart` |
| 11 | unit | *(blank)* | No unit written |
| 18 | harvest_date | `4 Mar 26` | A standard date parser will not read this |
| 20 | quantity | `-120` | Negative. Note: "correction to 12/03 overcount" |

## 3. Rows that are not records

- **Line 13** - `,,,,,,` - seven empty fields.
- **Line 27** - `TOTAL,,,28450,kg,,` - a summary row sitting inside the data. If this is read as a harvest, every number after it is wrong.

## 4. Columns that contradict themselves

- **Units - 5 spellings plus blank:** `kg` (16 rows), `Kg` (1), `lb` (3), `lbs` (1), `Lb` (1), blank (2). One pound is 0.45359237 kg.
- **Varieties - 4 spellings for 3 varieties:** `Sweetheart`, `sweethart`, `Lapins`, `Regina`.
- **Dates - 3 formats:** `2026-03-09` (22 rows), `03/04/2026` (1 row), `4 Mar 26` (1 row).
- **Blocks:** `B1`, `B2`, `B3`, `B4`. The question says "Block 3", which is not a value in the file.

## 5. Three rules the file gives for free

### 5.1 The unit follows the block, not the person

| Grader | Blocks worked | Units written |
|---|---|---|
| J Silvestre | B1 only | `kg` (6), `Kg` (1) |
| R Craig | B3 only | `kg` (6), blank (2) |
| M Reid | B2 and B4 | `lb`/`lbs`/`Lb` in B2, `kg` in B4 |

Block 2 is recorded in pounds. Every other block is in kilograms. The note on line 8 says "US buyer sheet", which explains why.

What this buys: both blank-unit rows (6 and 11) are Block 3, and every other Block 3 row says `kg`. Reading them as kilograms is inference from the block, not a guess. It is still not a value the row carried.

### 5.2 The misspelling is the same person, block and variety

Line 7 `sweethart` is R Craig's row. R Craig writes `Sweetheart` correctly on his six other Block 3 rows. One letter missing.

### 5.3 Row order is evidence, but this file breaks it

Rows are in date order everywhere except line 18. Line 18 is `4 Mar 26` and it sits between 12 March and 13 March.

Line 5 sits between 3 March and 5 March, which is exactly where 4 March belongs. So position argues for "4 March". But line 18 proves this file does misplace rows, and both misplaced-looking rows are the two non-ISO dates. Position was tested as evidence for line 5 and rejected, because the file has already shown it can put a row in the wrong slot.

## 6. The question hits almost every problem

> How many kilograms of Sweetheart were harvested in Block 3 in March 2026?

All Block 3 rows for Sweetheart, including the misspelling:

| Line | Date as written | Qty | Unit | Problem |
|---|---|---|---|---|
| 5 | `03/04/2026` | 1180 | kg | March or April |
| 6 | 2026-03-05 | `record lost` | *(blank)* | No number exists |
| 7 | 2026-03-06 | 990 | kg | Spelled `sweethart` |
| 11 | 2026-03-09 | 1210 | *(blank)* | No unit written |
| 16 | 2026-03-12 | 1150 | kg | Possible duplicate of line 17 |
| 17 | 2026-03-12 | 1105 | kg | Note: "re-weighed after grading" |
| 26 | 2026-03-20 | 1075 | kg | Clean |

**One of the seven rows is clean.**

### The answer under each reading

| Rules applied | Rows counted | Answer |
|---|---|---|
| Clean row + re-weighed row only | 26, 17 | **2,180 kg** |
| Also accept the misspelled variety | + 7 | **3,170 kg** |
| Also read the blank unit as kg | + 11 | **4,380 kg** |
| Also read `03/04/2026` as 4 March | + 5 | **5,560 kg** |
| Also count both 12 March rows | + 16 | **6,710 kg** |

The answer moves by more than three times. There is no single correct number, so any number must carry its exclusions with it.

### The two highest-leverage errors

**The blank unit on line 11.** Read as kg the row is 1,210 kg. Read as pounds it is 548.85 kg. Read as grams it is 1.21 kg. One blank field moves that row by a factor of 1,000.

**The block filter.** Sweetheart also appears in B1 (5 rows, lines 2, 3, 12, 21, 25, totalling 4,445 kg) and B2 (1 row, line 23, 2,210 lb = 1,002.44 kg). Drop the block filter and 3,170 becomes 8,617.44 - about 2.7 times.

### Out of scope for this question

The `-120` correction on line 20 is B4 Regina. Three rows fall on 12 March and only one is B4 Regina (line 15), so the row it corrects is uniquely identified. It does not touch the Block 3 Sweetheart answer.

## 7. The file fails its own cross-check, twice

Line 27 claims 28,450 kg.

- Adding every quantity in the file and ignoring units gives **27,297**. The stated total is over by **1,153**.
- It also adds pounds and kilograms as if they were the same unit. The five pound rows (lines 8, 9, 10, 19, 23) total 10,200 lb = 4,626.64 kg. Converted properly, the file's real total is about **21,723.64 kg** - and that already assumes the blank-unit 1,210 on line 11 is kg. Exclude that row and it is 20,513.64 kg.

The grower's own total does not match the grower's own rows. This is the concrete reason the system must not trust a number because a customer typed it.
