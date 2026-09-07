/** Python string and regex primitives that JavaScript spells differently.
 *
 * The port has to match CPython byte for byte, and the two languages
 * disagree in small places: `\s`, `str.strip`, `str.title` and
 * `str.expandtabs` all have their own definitions. Everything that
 * depends on one lives here.
 */

/** Python's `\s` for `str` patterns, which is exactly `str.isspace()`.
 *
 * JavaScript's `\s` differs at both ends: it adds U+FEFF and omits
 * U+001C..U+001F and U+0085.
 */
export const PY_SPACE_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\u00a0\\u1680" +
  "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** `[\s]` and `[^\s]`, ready to interpolate into a pattern. */
export const PY_S = `[${PY_SPACE_CLASS}]`;
export const PY_NOT_S = `[^${PY_SPACE_CLASS}]`;

const RUN = new RegExp(`${PY_S}+`, "g");
const LEAD = new RegExp(`^${PY_S}+`);
const TRAIL = new RegExp(`${PY_S}+$`);
const ONE = new RegExp(`^${PY_S}$`);

/** `re.sub(r"\s+", repl, text)`. */
export function collapse(text: string, repl = " "): string {
  return text.replace(RUN, repl);
}

/** `str.strip()` — no argument form. */
export function strip(text: string): string {
  return text.replace(LEAD, "").replace(TRAIL, "");
}

export function lstrip(text: string): string {
  return text.replace(LEAD, "");
}

export function rstrip(text: string): string {
  return text.replace(TRAIL, "");
}

/** `str.strip(chars)` — strip any of the given characters. */
export function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start += 1;
  while (end > start && chars.includes(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/** `str.isspace()` for a single character, plus the empty-string case. */
export function isSpace(text: string): boolean {
  return text.length > 0 && ONE.test(text);
}

/** True when `text.strip()` is empty, which is how CPython spells "blank". */
export function isBlank(text: string): boolean {
  return strip(text) === "";
}

const ALPHA = /\p{L}/u;

/** `str.title()`.
 *
 * CPython title-cases a character whenever the previous one was not
 * alphabetic, and lower-cases it otherwise. Full title-case mappings for
 * the handful of characters where they differ from upper-case (ß, ﬁ) are
 * not reproduced; the handbook is Malay and never carries them.
 */
export function title(text: string): string {
  let out = "";
  let previousIsCased = false;
  for (const ch of text) {
    out += previousIsCased ? ch.toLowerCase() : ch.toUpperCase();
    previousIsCased = ALPHA.test(ch);
  }
  return out;
}

/** `str.expandtabs(tabsize)`. Column resets on `\n` and `\r`. */
export function expandTabs(text: string, tabsize = 8): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") {
      if (tabsize > 0) {
        const pad = tabsize - (column % tabsize);
        out += " ".repeat(pad);
        column += pad;
      }
    } else {
      out += ch;
      column = ch === "\n" || ch === "\r" ? 0 : column + 1;
    }
  }
  return out;
}

/** `len(s)` — code points, not UTF-16 units. */
export function clen(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n -= 1;
        i += 1;
      }
    }
  }
  return n;
}

/** `text.startswith(tuple)`. */
export function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}
