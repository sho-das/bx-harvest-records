/**
 * The page served at GET /.
 *
 * The markup lives in TypeScript rather than in a .html file because `tsc` is
 * the only build step this project has, and it does not copy assets. A .html
 * file under src/ would compile to nothing, so the controller would have to
 * find it on disk at request time and guess at the path - one guess for running
 * the compiled output, another for running under tsx. Holding the page here
 * means it lands in dist with everything else and the route has nothing to look
 * up.
 *
 * The cost is that this file has no HTML syntax highlighting, and a change to
 * the page needs a rebuild rather than a browser refresh.
 *
 * Three characters are escaped for the template literal and nothing else is:
 * a backslash, a backtick, and the two characters `${`. The rest of the string
 * is the page exactly as the browser receives it.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harvest question</title>
<style>
  :root {
    --bg: #ffffff;
    --panel: #f6f6f4;
    --ink: #1a1a18;
    --muted: #6b6b64;
    --line: #dcdcd6;
    --accent: #1f5f3f;
    --accent-ink: #ffffff;
    --refusal: #8a3324;
    --refusal-bg: #fdf3f1;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a;
      --panel: #1e2024;
      --ink: #e8e8e4;
      --muted: #9a9a92;
      --line: #33353a;
      --accent: #4fa87a;
      --accent-ink: #10120f;
      --refusal: #e2857a;
      --refusal-bg: #2a1d1b;
    }
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

  header {
    border-bottom: 1px solid var(--line);
    padding: 22px 32px;
  }
  header h1 { margin: 0; font-size: 19px; font-weight: 600; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 14px; }

  .wrap {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 400px;
    gap: 40px;
    max-width: 1180px;
    margin: 0 auto;
    padding: 32px;
    align-items: start;
  }
  @media (max-width: 900px) {
    .wrap { grid-template-columns: minmax(0, 1fr); gap: 28px; }
  }

  section { margin-bottom: 34px; }
  h2 {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 12px;
  }

  textarea {
    width: 100%;
    min-height: 76px;
    padding: 12px 14px;
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    resize: vertical;
  }
  textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  pre.curl {
    margin: 12px 0 10px;
    padding: 14px 16px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  button {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 7px 15px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button[disabled] { opacity: 0.5; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .hint { color: var(--muted); font-size: 13px; }

  .answer { font-size: 46px; font-weight: 600; line-height: 1.1; }
  .answer .unit { font-size: 20px; font-weight: 400; color: var(--muted); margin-left: 8px; }
  .understood { margin-top: 8px; color: var(--muted); font-size: 14px; }

  .refusal {
    border: 1px solid var(--refusal);
    background: var(--refusal-bg);
    border-radius: 6px;
    padding: 16px 18px;
  }
  .refusal .tag {
    display: block;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--refusal);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .refusal p { margin: 0; }

  /*
    Deliberately not the refusal styling. The red box is the system speaking.
    This is the customer's own sentence read back, so it is quiet, and it sits
    outside the box rather than in it.
  */
  .asked {
    border-left: 3px solid var(--line);
    padding: 2px 0 2px 12px;
    margin-bottom: 14px;
  }
  .asked .tag {
    display: block;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
    margin-bottom: 4px;
  }
  .asked p { margin: 0; color: var(--muted); }

  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left;
    font-weight: 600;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0 12px 7px 0;
    border-bottom: 1px solid var(--line);
  }
  td { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.n, th.n { text-align: right; }
  td.n:last-child, th.n:last-child { padding-right: 0; }
  td.n:first-child, th.n:first-child { padding-right: 18px; }
  tr.readas td {
    border-bottom: 1px solid var(--line);
    padding-top: 0;
    color: var(--muted);
    font-size: 13px;
  }
  tr.plain td { border-bottom: none; }
  .empty { color: var(--muted); font-size: 14px; padding: 10px 0; }

  /* The block or blocks holding the largest figure. Weight and a marker, not
     colour alone, so it still reads if colour does not arrive. */
  tr.top td { font-weight: 600; }
  /* The word is written into the markup rather than into content:, because it
     changes with the direction and a stylesheet cannot read the answer. */
  .mark { font-weight: 400; color: var(--muted); margin-left: 8px; }

  /* A reading the customer's own words do not account for. Not a refusal, so
     not the red box, but it sits directly under the number rather than in the
     grey line, because grey text under a large figure does not get read. */
  .untraced {
    margin-top: 10px;
    padding: 9px 12px;
    border-left: 3px solid var(--refusal);
    background: var(--refusal-bg);
    font-size: 14px;
  }
  .untraced strong { font-weight: 600; }

  .park {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 15px 16px;
    margin-bottom: 12px;
  }
  .park .q { font-weight: 600; }
  .park .evidence { color: var(--muted); font-size: 14px; margin-top: 6px; }
  .park .opts { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin-top: 14px; }
  .opt { text-align: left; line-height: 1.35; padding: 9px 14px; }
  .opt .label { display: block; font-weight: 600; }
  .opt .detail { display: block; font-size: 12px; color: var(--muted); font-family: var(--mono); margin-top: 2px; }
  .opt[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .opt[aria-pressed="true"] .detail { color: var(--accent-ink); opacity: 0.85; }
  .needs-person { margin-top: 12px; font-size: 14px; color: var(--muted); }

  /* The word "saved" rides inside the option button, so what a person answered
     is on the answer itself rather than in a sentence beside the list. */
  .opt .flag { float: right; font-weight: 400; font-size: 12px; color: var(--muted); }
  .opt[aria-pressed="true"] .flag { color: var(--accent-ink); opacity: 0.85; }
  .park .save { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .park .save .hint { font-size: 13px; }
  .park .save .failed { color: var(--refusal); font-size: 13px; }
  /* Already answered, so it is quieter than a question still waiting. */
  .park.settled { border-style: dashed; }
  .park.settled .q { font-weight: 400; }
  .park .decided { color: var(--muted); font-size: 13px; margin-top: 6px; }

  .total {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 20px;
  }
  aside section { margin-top: 26px; margin-bottom: 0; }
  .total h2 { margin-top: 0; }
  .tline { display: flex; justify-content: space-between; gap: 14px; padding: 5px 0; font-size: 14px; }
  .tline .v { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tline.head { font-weight: 600; }
  .trule { border-top: 1px solid var(--line); margin: 10px 0 4px; }
  .tline.sum { font-weight: 600; font-size: 17px; padding-top: 6px; }
  .note { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  .hidden { display: none; }
</style>
</head>
<body>

<header>
  <h1>Harvest question</h1>
  <p>The number, everything that is not in it, and what a person decided.</p>
</header>

<div class="wrap">
  <main>
    <section>
      <h2>The question</h2>
      <textarea id="question" spellcheck="false" rows="2">How many kilograms of Sweetheart were harvested in Block 3 in March 2026?</textarea>
      <pre class="curl" id="curl"></pre>
      <div class="row">
        <button class="primary" id="run">Run</button>
        <button id="copy">Copy</button>
        <span class="hint" id="copied"></span>
      </div>
      <p class="hint" style="margin-top:10px">
        The command above is the request this page makes. Same URL, same header,
        same body string - the page builds one body and uses it for both, so it
        cannot show you one thing and send another.
      </p>
    </section>

    <section id="result" class="hidden">
      <h2>The answer</h2>
      <!--
        Shown above the refusal, outside the answer box. It carries the
        customer's own words back, which is what makes a refusal readable
        without quoting anything the model wrote.
      -->
      <div id="askedBox"></div>
      <div id="answerBox"></div>
    </section>

    <!-- Comparison mode only. Four blocks, the same question asked of each. -->
    <section id="comparisonSection" class="hidden">
      <h2>Every block, same question</h2>
      <div id="comparison"></div>
    </section>

    <section id="countedSection" class="hidden">
      <h2>Rows counted</h2>
      <div id="counted"></div>
    </section>

    <section id="notCountedSection" class="hidden">
      <h2>Rows not counted</h2>
      <div id="notCounted"></div>
    </section>
  </main>

  <aside>
    <div class="total">
      <h2>Running total</h2>
      <div id="totalBody"><p class="hint">Run the question to see the figure.</p></div>
      <p class="note">
        Choosing an option shows what the answer would become. Nothing is
        written until you press Save on that question.
      </p>
      <p class="note" style="margin-top:12px;padding-top:0;border-top:none">
        Save records the answer and reads the file again, so the same question
        is not asked twice. It stays on screen below, and picking a different
        option there changes it.
      </p>
    </div>

    <!-- Directly under the total, because clicking an option and watching the
         figure move are the same action. Putting them in separate columns made
         you look in two places at once. -->
    <section id="parkedSection" class="hidden">
      <h2>Waiting on an answer</h2>
      <div id="parked"></div>
    </section>

    <!--
      A question that was asked once and answered. It is here rather than gone
      because a decision nobody can see is a decision nobody can correct: the
      row counts, the figure above includes it, and the only sign a person was
      involved is this list.
    -->
    <section id="settledSection" class="hidden">
      <h2>Answered by a person</h2>
      <div id="settled"></div>
    </section>
  </aside>
</div>

<script>
(function () {
  'use strict';

  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

  var els = {
    question: document.getElementById('question'),
    curl: document.getElementById('curl'),
    run: document.getElementById('run'),
    copy: document.getElementById('copy'),
    copied: document.getElementById('copied'),
    result: document.getElementById('result'),
    answerBox: document.getElementById('answerBox'),
    askedBox: document.getElementById('askedBox'),
    comparisonSection: document.getElementById('comparisonSection'),
    comparison: document.getElementById('comparison'),
    countedSection: document.getElementById('countedSection'),
    counted: document.getElementById('counted'),
    notCountedSection: document.getElementById('notCountedSection'),
    notCounted: document.getElementById('notCounted'),
    parkedSection: document.getElementById('parkedSection'),
    parked: document.getElementById('parked'),
    settledSection: document.getElementById('settledSection'),
    settled: document.getElementById('settled'),
    totalBody: document.getElementById('totalBody')
  };

  // -------------------------------------------------------------------------
  // Exact decimal arithmetic
  //
  // Every figure from the endpoint is a NUMERIC(12,3) string. The page has to
  // add deltas together, so it works in whole thousandths with BigInt and never
  // touches a float. 3170.000 + 1210.000 + 1180.000 is 5560.000 exactly, not
  // 5559.999999999999.
  // -------------------------------------------------------------------------

  function toMilli(text) {
    var s = String(text);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = ((parts[1] || '') + '000').slice(0, 3);
    var n = BigInt(whole) * 1000n + BigInt(frac);
    return neg ? -n : n;
  }

  function fromMilli(n) {
    var neg = n < 0n;
    var a = neg ? -n : n;
    var whole = (a / 1000n).toString();
    var frac = (a % 1000n).toString().padStart(3, '0');
    return (neg ? '-' : '') + whole + '.' + frac;
  }

  function signed(n) {
    return (n < 0n ? '' : '+') + fromMilli(n);
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function longDate(iso) {
    if (!iso) return null;
    var p = iso.split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + Number(p[0]);
  }

  function describe(u, blocks) {
    var bits = [];
    // In comparison mode the block filter is null, and "every block" would
    // read as if the filter had been dropped. It was not dropped: the customer
    // asked about all of them, and the blocks are named so they can see which.
    if (u.block_comparison) {
      // The direction is named here as well as in the answer box. It is the
      // one word that decides whether the block shown is the right one, and
      // "comparing B1, B2, B3, B4" alone does not say which end was asked for.
      bits.push('comparing ' + (blocks && blocks.length ? blocks.join(', ') : 'every block') +
                ', ' + (u.highest === false ? 'lowest' : 'highest') + ' first');
    } else {
      bits.push(u.block ? 'Block ' + u.block : 'every block');
    }
    bits.push(u.variety ? u.variety : 'every variety');
    if (u.date_from && u.date_to_exclusive) {
      bits.push(longDate(u.date_from) + ' up to but not including ' + longDate(u.date_to_exclusive));
    } else if (u.date_from) {
      bits.push('from ' + longDate(u.date_from) + ' onwards');
    } else if (u.date_to_exclusive) {
      bits.push('up to but not including ' + longDate(u.date_to_exclusive));
    } else {
      bits.push('every date');
    }
    return 'Understood as: ' + bits.join(', ') + '.';
  }

  // -------------------------------------------------------------------------
  // The request, shown and sent from one string
  // -------------------------------------------------------------------------

  function bodyFor(question) {
    return JSON.stringify({ question: question });
  }

  function curlFor(question) {
    // The body is wrapped in single quotes for the shell, so a single quote
    // inside the question has to be closed, escaped and reopened. The JSON
    // itself is untouched - only the shell quoting differs.
    var shellSafe = bodyFor(question).replace(/'/g, "'\\\\''");
    return "curl -s -X POST " + location.host + "/ask \\\\\\n" +
           "  -H 'Content-Type: application/json' \\\\\\n" +
           "  -d '" + shellSafe + "'";
  }

  function refreshCurl() {
    els.curl.textContent = curlFor(els.question.value.trim());
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  // \`chosen\` is a preview: which option is selected on a park, and nothing
  // more. \`picked\` is the same idea for a question already answered, holding
  // the option a person has clicked but not yet saved. Neither is what the
  // database holds - that arrives with the response, as \`chosen_label\`.
  function blank() {
    return { base: null, parks: [], chosen: {}, settled: [], picked: {}, failed: {} };
  }

  var state = blank();

  function clearResult() {
    state = blank();
    els.result.classList.add('hidden');
    els.comparisonSection.classList.add('hidden');
    els.countedSection.classList.add('hidden');
    els.notCountedSection.classList.add('hidden');
    els.parkedSection.classList.add('hidden');
    els.settledSection.classList.add('hidden');
    els.answerBox.innerHTML = '';
    els.askedBox.innerHTML = '';
    els.comparison.innerHTML = '';
    els.counted.innerHTML = '';
    els.notCounted.innerHTML = '';
    els.parked.innerHTML = '';
    els.settled.innerHTML = '';
    els.totalBody.innerHTML = '<p class="hint">Run the question to see the figure.</p>';
  }

  function showRefusal(reason, question) {
    clearResult();
    els.result.classList.remove('hidden');

    // The refusal names the blocks that exist but never the block that was
    // asked for, because that string comes from the model. The customer's own
    // sentence supplies the missing half, and it is safe because they wrote it.
    els.askedBox.innerHTML = question
      ? '<div class="asked"><span class="tag">You asked</span><p>' + esc(question) + '</p></div>'
      : '';

    els.answerBox.innerHTML =
      '<div class="refusal"><span class="tag">No answer</span><p>' + esc(reason) + '</p></div>';
    els.totalBody.innerHTML = '<p class="hint">No answer, so no total.</p>';
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderCounted(rows) {
    els.countedSection.classList.remove('hidden');
    if (!rows.length) {
      els.counted.innerHTML = '<p class="empty">No rows matched. That is the answer, not a failure.</p>';
      return;
    }
    var html = '<table><thead><tr>' +
      '<th class="n">Line</th><th>Date</th><th>Quantity as written</th>' +
      '<th>Unit as written</th><th class="n">Kilograms</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var hasNote = r.read_as !== null && r.read_as !== undefined;
      html += '<tr' + (hasNote ? ' class="plain"' : '') + '>' +
        '<td class="n num">' + esc(r.line) + '</td>' +
        '<td class="num">' + esc(r.date) + '</td>' +
        '<td class="num">' + esc(r.quantity_raw) + '</td>' +
        '<td class="num">' + esc(r.unit_raw) + '</td>' +
        '<td class="n num">' + esc(r.quantity_kg) + '</td></tr>';
      if (hasNote) {
        html += '<tr class="readas"><td></td><td colspan="4">' + esc(r.read_as) + '</td></tr>';
      }
    });
    els.counted.innerHTML = html + '</tbody></table>';
  }

  function renderNotCounted(rows) {
    els.notCountedSection.classList.remove('hidden');
    if (!rows.length) {
      els.notCounted.innerHTML = '<p class="empty">Nothing was left out.</p>';
      return;
    }
    var html = '<table><thead><tr><th class="n">Line</th><th>Status</th><th>Reason</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var reason = r.reason;
      if (r.superseded_by_line !== null && r.superseded_by_line !== undefined &&
          String(reason).indexOf('line ' + r.superseded_by_line) === -1) {
        reason = reason + ' Replaced by line ' + r.superseded_by_line + '.';
      }
      html += '<tr><td class="n num">' + esc(r.line) + '</td>' +
        '<td>' + esc(r.status) + '</td>' +
        '<td>' + esc(reason) + '</td></tr>';
    });
    els.notCounted.innerHTML = html + '</tbody></table>';
  }

  /**
   * The Save row under a question's options.
   *
   * Clicking an option and saving it are two actions on purpose. A click
   * changes the figure in the running total and nothing else; Save writes to
   * the database and reads the file again. Putting the write on the option
   * button itself would make every glance at "what would this become" a change
   * to what the file means.
   *
   * The button is dead unless the selection differs from what is stored, so
   * saving the answer that is already saved is not an action the page offers.
   */
  function saveRow(kind, index, selectedLabel, savedLabel) {
    var can = selectedLabel !== null && selectedLabel !== savedLabel;
    var note = state.failed[kind + index];
    var hint = note
      ? '<span class="failed">' + esc(note) + '</span>'
      : selectedLabel === null
        ? '<span class="hint">Pick an option to save it.</span>'
        : can ? '' : '<span class="hint">That is the saved answer.</span>';

    return '<div class="save"><button type="button" class="save-btn" data-kind="' + kind +
      '" data-index="' + index + '"' + (can ? '' : ' disabled') + '>' +
      (savedLabel ? 'Change the answer' : 'Save this answer') + '</button>' + hint + '</div>';
  }

  function renderParked() {
    els.parkedSection.classList.remove('hidden');
    if (!state.parks.length) {
      els.parked.innerHTML = '<p class="empty">Nothing is waiting on an answer.</p>';
      return;
    }
    var html = '';
    state.parks.forEach(function (park, pi) {
      html += '<div class="park">';
      html += '<div class="q">' + esc(park.question) + '</div>';
      if (park.evidence) html += '<div class="evidence">' + esc(park.evidence) + '</div>';

      // Answered, and the row still does not count. "Not a variety in this
      // data" is that case: it is a real answer and it supplies no value, so
      // the row stays out. Saying so is the difference between a question
      // nobody answered and one whose answer was to leave it out.
      if (park.chosen_label) {
        html += '<div class="decided">A person answered &ldquo;' + esc(park.chosen_label) +
                '&rdquo;. The row still does not count.</div>';
      }

      if (park.free_text) {
        html += '<div class="needs-person">This one needs a person, not a choice from a list. ' +
                'No weight was recorded, so there is nothing to pick between.</div>';
      } else {
        var selected = state.chosen[pi];
        html += '<div class="opts">';
        park.options.forEach(function (o, oi) {
          var on = selected === oi;
          html += '<button class="opt" type="button" aria-pressed="' + (on ? 'true' : 'false') +
            '" data-park="' + pi + '" data-opt="' + oi + '">' +
            '<span class="label">' + esc(o.label) +
            (o.chosen ? '<span class="flag">saved</span>' : '') + '</span>' +
            '<span class="detail">row ' + esc(o.row_becomes_kg === null ? 'unknown' : o.row_becomes_kg) +
            ' &nbsp;/&nbsp; answer ' + esc(o.answer_becomes_kg) + '</span></button>';
        });
        html += '</div>';
        html += saveRow('park', pi,
          selected === undefined ? null : park.options[selected].label,
          park.chosen_label);
      }
      html += '</div>';
    });
    els.parked.innerHTML = html;

    Array.prototype.forEach.call(els.parked.querySelectorAll('.opt'), function (btn) {
      btn.addEventListener('click', function () {
        var pi = Number(btn.getAttribute('data-park'));
        var oi = Number(btn.getAttribute('data-opt'));
        // One option at a time per park. Clicking the selected one clears it.
        if (state.chosen[pi] === oi) delete state.chosen[pi];
        else state.chosen[pi] = oi;
        renderParked();
        renderTotal();
      });
    });

    bindSave(els.parked);
  }

  /**
   * Questions that were asked once, answered, and are not being asked again.
   *
   * The rows they belong to are counted, so they are already inside the figure
   * at the top of the page. Without this list the only trace of a person having
   * decided anything is a line of grey text in the counted table, and changing
   * the answer means writing to the database by hand.
   */
  function renderSettled() {
    if (!state.settled.length) {
      els.settledSection.classList.add('hidden');
      return;
    }
    els.settledSection.classList.remove('hidden');

    var html = '';
    state.settled.forEach(function (item, si) {
      var picked = state.picked['settled' + si];
      var pressed = picked === undefined ? item.chosen_label : picked;

      html += '<div class="park settled">';
      html += '<div class="q">' + esc(item.question) + '</div>';
      html += '<div class="decided">Answered &ldquo;' + esc(item.chosen_label) + '&rdquo;' +
              (item.decided_at ? ' on ' + esc(longDate(String(item.decided_at).slice(0, 10))) : '') +
              '. This row is counted in the figure above.</div>';
      html += '<div class="opts">';
      item.options.forEach(function (o, oi) {
        html += '<button class="opt" type="button" aria-pressed="' +
          (o.label === pressed ? 'true' : 'false') +
          '" data-settled="' + si + '" data-opt="' + oi + '">' +
          '<span class="label">' + esc(o.label) +
          (o.chosen ? '<span class="flag">saved</span>' : '') + '</span></button>';
      });
      html += '</div>';
      html += saveRow('settled', si, pressed === undefined ? null : pressed, item.chosen_label);
      html += '</div>';
    });
    els.settled.innerHTML = html;

    Array.prototype.forEach.call(els.settled.querySelectorAll('.opt'), function (btn) {
      btn.addEventListener('click', function () {
        var si = Number(btn.getAttribute('data-settled'));
        var oi = Number(btn.getAttribute('data-opt'));
        state.picked['settled' + si] = state.settled[si].options[oi].label;
        renderSettled();
      });
    });

    bindSave(els.settled);
  }

  /**
   * The one write the page makes.
   *
   * It sends the line, the field and the label, and nothing else. What that
   * answer does to the row is worked out by the importer, from the option
   * already stored against the question, so the page cannot save a weight or a
   * date the file never offered.
   *
   * The question is then asked again rather than the figure being adjusted
   * here. Every number on this page comes back from the database, including
   * after a write.
   */
  function bindSave(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.save-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-kind');
        var index = Number(btn.getAttribute('data-index'));
        var item, label;

        if (kind === 'park') {
          item = state.parks[index];
          label = item.options[state.chosen[index]].label;
        } else {
          item = state.settled[index];
          label = state.picked['settled' + index];
        }

        btn.disabled = true;
        btn.textContent = 'Saving';

        fetch('/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ line: item.line, field: item.field, label: label })
        }).then(function (response) {
          return response.json().then(function (data) {
            return { ok: response.ok, data: data };
          }).catch(function () {
            return { ok: false, data: null };
          });
        }).then(function (result) {
          if (result.ok && result.data && result.data.recorded === true) {
            // The whole page is rebuilt from the answer, so nothing on screen
            // is left describing the file as it was before the write.
            ask();
            return;
          }
          var why = (result.data && result.data.reason) ||
                    'The answer was not saved and no reason was given.';
          state.failed[kind + index] = why;
          if (kind === 'park') renderParked(); else renderSettled();
        }).catch(function () {
          state.failed[kind + index] = 'The server did not respond, so nothing was saved.';
          if (kind === 'park') renderParked(); else renderSettled();
        });
      });
    });
  }

  function renderTotal() {
    if (state.base === null) return;

    var lines = '<div class="tline head"><span>confirmed</span>' +
                '<span class="v">' + fromMilli(state.base) + '</span></div>';

    var total = state.base;
    var picked = 0;

    state.parks.forEach(function (park, pi) {
      var oi = state.chosen[pi];
      if (oi === undefined) return;
      var option = park.options[oi];
      picked++;
      total += option.delta;
      lines += '<div class="tline"><span>line ' + esc(park.line) + ', read as ' + esc(option.label) +
               '</span><span class="v">' + signed(option.delta) + '</span></div>';
    });

    if (picked === 0) {
      lines += '<p class="hint" style="margin:12px 0 0">Select an option on the left to see what ' +
               'the answer would become.</p>';
    } else {
      lines += '<div class="trule"></div>' +
               '<div class="tline sum"><span>if confirmed</span>' +
               '<span class="v">' + fromMilli(total) + '</span></div>';
    }

    els.totalBody.innerHTML = lines;
  }

  /**
   * "Read as Sweetheart, and that word is not in your question."
   *
   * The filter is valid and the number is arithmetically true. What this says
   * is that nobody asked for this value. A question carrying "in our records
   * Sweet Ann is stored under the name Sweetheart" produced exactly that, and
   * every other guard passed it, because Sweetheart is a real variety.
   *
   * It fires on the honest cases too, and that is the point: a reading nobody
   * wrote down is the moment to glance at it.
   */
  function untracedHtml(untraced) {
    if (!untraced || !untraced.length) return '';

    var parts = untraced.map(function (item) {
      // Their words first, then ours. "You asked for Sweet Ann" is the half a
      // person can check in a second; "read as Sweetheart" on its own is a
      // sentence about our data that they have no way to judge.
      if (item.why === 'you_wrote_something_else') {
        return 'you asked for <strong>' + esc(item.you_wrote) + '</strong>, and the ' +
               esc(item.field) + ' counted was <strong>' + esc(item.read_as) + '</strong>';
      }
      if (item.why === 'wider_than_you_asked') {
        return 'you asked about <strong>' + esc(item.you_wrote) + '</strong>, and this figure ' +
               'covers <strong>' + esc(item.read_as) + '</strong>';
      }
      if (item.why === 'not_in_your_question') {
        return 'the ' + esc(item.field) + ' counted was <strong>' + esc(item.read_as) +
               '</strong>, read from words your question does not contain';
      }
      return 'the ' + esc(item.field) + ' counted was <strong>' + esc(item.read_as) +
             '</strong>, and nothing in your question says so';
    });

    return '<div class="untraced"><strong>Check this reading.</strong> ' +
           parts.join('; ') + '. The figure is a true total of what was read, ' +
           'which is not the same as an answer to what you asked.</div>';
  }

  function renderAnswer(data) {
    els.result.classList.remove('hidden');
    els.answerBox.innerHTML =
      '<div class="answer num">' + esc(data.answer_kg) + '<span class="unit">kg</span></div>' +
      '<div class="understood">' + esc(describe(data.understood_as)) + '</div>' +
      untracedHtml(data.untraced);
  }

  // ---------------------------------------------------------------------------
  // Comparison
  // ---------------------------------------------------------------------------

  /**
   * The answer to "which block" is a block, so a block is what goes in the
   * large type. The winning figure sits under it as supporting detail, because
   * a number in the answer box is a number the customer will read as the
   * answer, and nobody asked for one.
   */
  function comparisonHeadline(data) {
    var winners = data.answer_block || [];
    var figure = null;
    (data.by_block || []).forEach(function (row) {
      if (winners.indexOf(row.block) !== -1) figure = row.answer_kg;
    });

    var end = data.highest === false ? 'Lowest' : 'Highest';

    // Every block at zero is a tie between all of them, and it is not a tie for
    // the most. Nothing was picked anywhere, and that is the answer.
    var allZero = (data.by_block || []).length > 0 &&
      (data.by_block || []).every(function (row) { return toMilli(row.answer_kg) === 0n; });

    if (allZero) {
      return { big: 'None', detail: 'No rows matched in any block. That is the answer, not a failure.' };
    }

    // Asked for the least, a block that recorded nothing wins at 0.000. That is
    // true and it is not the same as picking a little, so it says which it is
    // rather than letting 0.000 read as a small harvest.
    var zeroWinner = figure !== null && toMilli(figure) === 0n;
    var nothingAtAll = zeroWinner
      ? ' ' + (winners.length > 1 ? 'Those blocks recorded' : 'That block recorded') +
        ' no rows at all, which is not the same as a small harvest.'
      : '';

    if (winners.length > 1) {
      return {
        big: winners.join(' and '),
        detail: 'A tie for ' + end.toLowerCase() + '. ' + winners.length +
                ' blocks are level at ' + figure + ' kg.' + nothingAtAll
      };
    }
    return {
      big: winners.join(''),
      detail: end + ' of the four, at ' + figure + ' kg.' + nothingAtAll
    };
  }

  function renderComparison(data) {
    var blocks = (data.by_block || []).map(function (row) { return row.block; });
    var winners = data.answer_block || [];
    var head = comparisonHeadline(data);

    els.result.classList.remove('hidden');
    els.answerBox.innerHTML =
      '<div class="answer">' + esc(head.big) + '</div>' +
      '<div class="understood">' + esc(head.detail) + '</div>' +
      '<div class="understood">' + esc(describe(data.understood_as, blocks)) + '</div>' +
      untracedHtml(data.untraced);

    els.comparisonSection.classList.remove('hidden');
    var word = data.highest === false ? 'least' : 'most';
    var html = '<table><thead><tr><th>Block</th><th class="n">Kilograms</th>' +
      '</tr></thead><tbody>';
    (data.by_block || []).forEach(function (row) {
      var isTop = winners.indexOf(row.block) !== -1;
      html += '<tr' + (isTop ? ' class="top"' : '') + '>' +
        '<td class="num">' + esc(row.block) +
        (isTop ? '<span class="mark">&larr; ' + esc(word) + '</span>' : '') + '</td>' +
        '<td class="n num">' + esc(row.answer_kg) + '</td></tr>';
    });
    els.comparison.innerHTML = html + '</tbody></table>';

    // Nothing is parked in comparison mode, so there is nothing to price.
    els.totalBody.innerHTML =
      '<p class="hint">A comparison has no single total to move. Ask about one ' +
      'block to see the rows behind its figure.</p>';
  }

  function show(data) {
    clearResult();

    if (data.answered === false) {
      showRefusal(
        data.reason || 'The question was not answered, and no reason was given.',
        data.question
      );
      return;
    }

    // Two shapes come back from one endpoint, and \`comparison\` is the only
    // field that separates them. Branching on a missing field instead would
    // make an absent \`counted\` array look like a comparison.
    if (data.comparison === true) {
      renderComparison(data);
      return;
    }

    state.base = toMilli(data.answer_kg);

    // Each park is priced against the base, once, when the response arrives.
    // Reading answer_becomes_kg off the last click would show that park's
    // figure as if it were the total: choosing kg on line 11 and 4 March on
    // line 5 would read 4380.000 instead of 5560.000.
    state.parks = (data.parked || []).map(function (park) {
      return {
        line: park.line,
        field: park.field,
        question: park.question,
        evidence: park.evidence,
        free_text: park.free_text,
        chosen_label: park.chosen_label === undefined ? null : park.chosen_label,
        options: (park.options || []).map(function (o) {
          return {
            label: o.label,
            chosen: o.chosen === true,
            row_becomes_kg: o.row_becomes_kg,
            answer_becomes_kg: o.answer_becomes_kg,
            // 3 April 2026 falls outside March, so its delta is +0.000. That
            // is a real answer that changes nothing, and it is shown, not hidden.
            delta: toMilli(o.answer_becomes_kg) - state.base
          };
        })
      };
    });

    state.settled = (data.settled || []).map(function (item) {
      return {
        line: item.line,
        field: item.field,
        question: item.question,
        chosen_label: item.chosen_label,
        decided_at: item.decided_at,
        options: (item.options || []).map(function (o) {
          return { label: o.label, chosen: o.chosen === true };
        })
      };
    });

    renderAnswer(data);
    renderCounted(data.counted || []);
    renderNotCounted(data.not_counted || []);
    renderParked();
    renderSettled();
    renderTotal();
  }

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  function ask() {
    var question = els.question.value.trim();
    if (!question) return;

    // Never leave the previous answer on screen next to a new question.
    clearResult();
    els.run.disabled = true;
    els.run.textContent = 'Running';

    var body = bodyFor(question);   // the same string the curl above displays

    fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      }).catch(function () {
        return { ok: false, status: response.status, data: null };
      });
    }).then(function (result) {
      if (result.data && (result.data.answered === true || result.data.answered === false)) {
        show(result.data);
        return;
      }
      var reason = (result.data && (result.data.reason || result.data.message)) || null;
      // \`question\` here is the local variable, not a field off the response.
      // On these two paths there may be no response body to read it from, and
      // the local one is the same string for the same reason: the customer
      // typed it into the box above.
      showRefusal(
        reason || ('The server did not respond with an answer (HTTP ' + result.status + ').'),
        question
      );
    }).catch(function () {
      showRefusal('The server did not respond.', question);
    }).then(function () {
      els.run.disabled = false;
      els.run.textContent = 'Run';
    });
  }

  els.question.addEventListener('input', refreshCurl);
  els.question.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); ask(); }
  });
  els.run.addEventListener('click', ask);
  els.copy.addEventListener('click', function () {
    navigator.clipboard.writeText(els.curl.textContent).then(function () {
      els.copied.textContent = 'Copied.';
      setTimeout(function () { els.copied.textContent = ''; }, 1800);
    }).catch(function () {
      els.copied.textContent = 'Could not copy. Select the text above.';
    });
  });

  refreshCurl();
})();
</script>
</body>
</html>
`;
