/** Port of Python's `html.unescape`, following the HTML5 rules for both
 * valid and invalid character references. */

import { HTML5_ENTITIES } from "./entities.ts";

/** Numeric references the standard remaps rather than takes literally. */
const INVALID_CHARREFS: Record<number, string> = {
  0x00: "�",
  0x0d: "\r",
  0x80: "€",
  0x81: "\x81",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8d: "\x8d",
  0x8e: "Ž",
  0x8f: "\x8f",
  0x90: "\x90",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9d: "\x9d",
  0x9e: "ž",
  0x9f: "Ÿ",
};

/** Numeric references that resolve to nothing at all. */
const INVALID_CODEPOINTS = new Set<number>([
  0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8,
  0xe, 0xf, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  0x7f, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
  0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
  0xb, 0xfffe, 0xffff,
  ...Array.from({ length: 32 }, (_, i) => 0xfdd0 + i),
  ...Array.from({ length: 17 }, (_, plane) => [
    plane * 0x10000 + 0xfffe,
    plane * 0x10000 + 0xffff,
  ]).flat(),
]);

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

function numeric(body: string): string {
  const digits = body.replace(/;+$/, "");
  const num = digits[0] === "x" || digits[0] === "X"
    ? Number.parseInt(digits.slice(1), 16)
    : Number.parseInt(digits, 10);
  if (!Number.isFinite(num)) return "�";
  if (num in INVALID_CHARREFS) return INVALID_CHARREFS[num]!;
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
  if (INVALID_CODEPOINTS.has(num)) return "";
  return String.fromCodePoint(num);
}

function named(body: string): string {
  if (body in HTML5_ENTITIES) return HTML5_ENTITIES[body]!;
  // The standard takes the longest prefix that is a known name and leaves
  // the remainder as literal text, so `&notit;` becomes `¬it;`.
  for (let x = body.length - 1; x > 1; x -= 1) {
    const head = body.slice(0, x);
    if (head in HTML5_ENTITIES) return HTML5_ENTITIES[head]! + body.slice(x);
  }
  return "&" + body;
}

export function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (_, body: string) =>
    body[0] === "#" ? numeric(body.slice(1)) : named(body),
  );
}
