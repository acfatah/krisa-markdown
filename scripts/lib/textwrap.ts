/** Port of `textwrap.wrap` for the one configuration the renderer uses:
 * tabs expanded, whitespace collapsed to spaces, surrounding whitespace
 * dropped, long words and hyphens left intact, no line limit. */

import { clen, expandTabs, isBlank, PY_S } from "./pystr.ts";

/** `_whitespace` translated to a space by `_munge_whitespace`. Note this
 * is the ASCII set only, narrower than `\s`. */
const MUNGE = /[\t\n\v\f\r]/g;

/** `wordsep_simple_re`, used when `break_on_hyphens` is off. */
const SEPARATOR = new RegExp(`(${PY_S}+)`);

export interface WrapOptions {
  width: number;
  initialIndent: string;
  subsequentIndent: string;
}

function splitChunks(text: string): string[] {
  return expandTabs(text, 8).replace(MUNGE, " ").split(SEPARATOR).filter(Boolean);
}

export function wrap(text: string, options: WrapOptions): string[] {
  const { width: totalWidth, initialIndent, subsequentIndent } = options;
  if (totalWidth <= 0) throw new RangeError(`invalid width ${totalWidth}`);

  // CPython reverses the chunk list and pops from the end; a cursor over
  // the forward list reads better and behaves the same.
  const chunks = splitChunks(text);
  let next = 0;
  const lines: string[] = [];

  while (next < chunks.length) {
    const line: string[] = [];
    let length = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const width = totalWidth - clen(indent);

    // Leading whitespace is dropped on every line but the first.
    if (lines.length && isBlank(chunks[next]!)) next += 1;

    while (next < chunks.length) {
      const size = clen(chunks[next]!);
      if (length + size > width) break;
      line.push(chunks[next]!);
      length += size;
      next += 1;
    }

    // A word too long for the line goes on it alone rather than being cut,
    // because `break_long_words` is off.
    if (next < chunks.length && clen(chunks[next]!) > width && line.length === 0) {
      line.push(chunks[next]!);
      next += 1;
    }

    if (line.length && isBlank(line[line.length - 1]!)) line.pop();
    if (line.length) lines.push(indent + line.join(""));
  }
  return lines;
}
