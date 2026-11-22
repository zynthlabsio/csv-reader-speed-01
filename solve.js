// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Own implementation, written from the reference's specified behaviour:
// reads a CSV text once, left to right, and returns {columns, rows, errors}
// exactly as csv-reader 1.0.0 does. Speed comes from indexOf/slice scanning
// instead of a character-at-a-time loop: unquoted fields are sliced in one
// go between the nearest comma / LF, quoted fields jump quote to quote, and
// lone-CR positions are pre-indexed once per run so no scan ever runs past
// the current field. No dependencies, deterministic, no state kept between
// run() calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // Positions of every '\r', indexed once so a "does this span hold a CR?"
  // check never scans past the span. Binary search keeps it stateless.
  const crs = [];
  {
    let c = text.indexOf('\r', 0);
    while (c !== -1) {
      crs.push(c);
      c = text.indexOf('\r', c + 1);
    }
  }
  const crCount = crs.length;
  function crAtOrAfter(x) {
    let lo = 0;
    let hi = crCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo < crCount ? crs[lo] : -1;
  }

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let end;
      let ended;
      if (ci === -1 && ni === -1) {
        end = n;
        ended = END;
      } else if (ni === -1 || (ci !== -1 && ci < ni)) {
        end = ci;
        ended = COMMA;
      } else {
        end = ni;
        ended = LINE_BREAK;
      }
      const ri = crAtOrAfter(pos);
      if (ri === -1 || ri >= end) {
        // No CR in the span: one slice does the whole field.
        if (ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) {
          // CRLF terminator: the CR belongs to the break, not the field.
          if (end - 1 > pos) {
            value += text.slice(pos, end - 1);
            added += end - 1 - pos;
          }
          pos = end + 1;
          line += 1;
        } else {
          if (end > pos) {
            value += text.slice(pos, end);
            added += end - pos;
          }
          if (ended === COMMA) pos = end + 1;
          else if (ended === LINE_BREAK) {
            pos = end + 1;
            line += 1;
          } else pos = end;
        }
        return { value, ended, added };
      }
      // Slow path: the span holds at least one CR. A CR followed by LF can
      // only be the CRLF terminator (its LF is `end`); every other CR is a
      // lone CR: stray_cr, dropped, field continues.
      let cur = pos;
      for (;;) {
        const r = text.indexOf('\r', cur);
        if (r === -1 || r >= end) {
          if (end > cur) {
            value += text.slice(cur, end);
            added += end - cur;
          }
          if (ended === COMMA) pos = end + 1;
          else if (ended === LINE_BREAK) {
            pos = end + 1;
            line += 1;
          } else pos = end;
          return { value, ended, added };
        }
        if (r + 1 === end && ended === LINE_BREAK) {
          if (r > cur) {
            value += text.slice(cur, r);
            added += r - cur;
          }
          pos = end + 1;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        if (r > cur) {
          value += text.slice(cur, r);
          added += r - cur;
        }
        error('stray_cr');
        cur = r + 1;
      }
    }
    return { value, ended: END, added };
  }

  // Counts line breaks inside a quoted span [from, to): each LF, each CRLF
  // and each lone CR is one.
  function countBreaks(from, to) {
    let count = 0;
    let i = from;
    for (;;) {
      const a = text.indexOf('\n', i);
      const b = crAtOrAfter(i);
      const hasA = a !== -1 && a < to;
      const hasB = b !== -1 && b < to;
      if (!hasA && !hasB) return count;
      if (hasB && (!hasA || b < a)) {
        count += 1;
        i = b + 1 < n && text.charCodeAt(b + 1) === 10 ? b + 2 : b + 1;
      } else {
        count += 1;
        i = a + 1;
      }
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos;
    let parts = null;
    let hasCR = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one quote in the value, field continues.
        if (parts === null) parts = [];
        if (!hasCR) {
          const r = crAtOrAfter(start);
          if (r !== -1 && r < q) hasCR = true;
        }
        parts.push(text.slice(start, q));
        parts.push('"');
        pos = q + 2;
        start = pos;
        continue;
      }
      // Closing quote at q.
      if (!hasCR) {
        const r = crAtOrAfter(start);
        if (r !== -1 && r < q) hasCR = true;
      }
      let value;
      if (parts === null) {
        value = text.slice(start, q);
      } else {
        parts.push(text.slice(start, q));
        value = parts.join('');
      }
      if (hasCR) value = value.replace(/\r\n?/g, '\n');
      // Every LF, CRLF and lone CR inside the quotes is one more line.
      const firstNl = text.indexOf('\n', open + 1);
      const firstCr = crAtOrAfter(open + 1);
      if ((firstNl !== -1 && firstNl < q) || (firstCr !== -1 && firstCr < q)) {
        line += countBreaks(open + 1, q);
      }
      pos = q + 1;
      if (pos >= n) return { value, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
