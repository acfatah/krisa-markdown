/** HTML and DOCX to Markdown rendering for the KRISA handbook.
 *
 * No runtime dependencies: the port keeps the original's promise that the
 * target box needs nothing beyond the runtime itself.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HTMLParser, type Attr } from "./lib/htmlparser.ts";
import {
  clen, collapse, isBlank, isSpace, PY_S, startsWithAny, strip,
} from "./lib/pystr.ts";
import { wrap } from "./lib/textwrap.ts";
import { unescape } from "./lib/unescape.ts";
import { Element, fromstring } from "./lib/xml.ts";
import { KeyError, ZipArchive } from "./lib/zip.ts";

export const WRAP = 80;

const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "col"]);
const SKIP = new Set(["script", "style", "noscript"]);
const BLOCK = new Set([
  "p", "div", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4",
  "h5", "h6", "blockquote", "pre", "section", "article",
]);

export class Node {
  readonly attrs: Record<string, string | null>;
  readonly children: Node[] = [];
  text = "";

  constructor(readonly tag: string, attrs: Attr[] = []) {
    this.attrs = Object.fromEntries(attrs);
  }

  /** A valueless attribute reads as empty rather than as Python's `None`,
   * which would only ever have raised further down. */
  attr(name: string, fallback = ""): string {
    return this.attrs[name] ?? fallback;
  }

  *findAll(tag: string): Generator<Node> {
    for (const child of this.children) {
      if (child.tag === tag) yield child;
      yield* child.findAll(tag);
    }
  }
}

/** Builds a forgiving DOM. Joomla output is not well-formed XML. */
class TreeBuilder extends HTMLParser {
  readonly root = new Node("root");
  private readonly stack: Node[] = [this.root];

  override handleStarttag(tag: string, attrs: Attr[]): void {
    const node = new Node(tag, attrs);
    this.stack[this.stack.length - 1]!.children.push(node);
    if (!VOID.has(tag)) this.stack.push(node);
  }

  override handleStartendtag(tag: string, attrs: Attr[]): void {
    this.stack[this.stack.length - 1]!.children.push(new Node(tag, attrs));
  }

  override handleEndtag(tag: string): void {
    for (let i = this.stack.length - 1; i > 0; i -= 1) {
      if (this.stack[i]!.tag === tag) {
        this.stack.length = i;
        return;
      }
    }
  }

  override handleData(data: string): void {
    const node = new Node("#text");
    node.text = data;
    this.stack[this.stack.length - 1]!.children.push(node);
  }
}

export function parse(markup: string): Node {
  const builder = new TreeBuilder();
  builder.feed(markup);
  return builder.root;
}

/** Return the raw substring of the element carrying attr="value".
 *
 * Balances nested tags of the same name so a wrapper div is not cut short.
 */
export function extract(markup: string, attr: string, value: string): string | null {
  const anchor = markup.indexOf(`${attr}="${value}"`);
  if (anchor < 0) return null;
  const start = markup.lastIndexOf("<", anchor - 1);
  const name = /^<([a-zA-Z0-9]+)/.exec(markup.slice(start))![1]!;
  const pattern = new RegExp(`<(/?)${name}\\b`, "gi");
  pattern.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markup)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) {
      return markup.slice(start, markup.indexOf(">", pattern.lastIndex) + 1);
    }
  }
  return markup.slice(start);
}

export type Fetch = (url: string) => Buffer | null;

export interface RendererOptions {
  assetDir?: string | null;
  assetHref?: string;
  fetch?: Fetch | null;
}

/** Walks a Node tree and emits Markdown.
 *
 * `assetDir` receives images pulled out of base64 data URIs; `assetHref`
 * is the path they are referenced by from the Markdown file.
 */
export class Renderer {
  private readonly assetDir: string | null;
  private readonly assetHref: string;
  private readonly fetch: Fetch | null;
  private images = 0;

  constructor(
    { assetDir = null, assetHref = ".", fetch = null }: RendererOptions = {},
  ) {
    this.assetDir = assetDir;
    this.assetHref = assetHref;
    this.fetch = fetch;
  }

  // -- inline ---------------------------------------------------------

  inline(node: Node): string {
    return node.children.map((child) => this.inlineOne(child)).join("");
  }

  inlineOne(node: Node): string {
    const tag = node.tag;
    if (tag === "#text") return collapse(node.text);
    if (SKIP.has(tag)) return "";
    if (tag === "br") return "\n";
    if (tag === "img") return this.image(node);
    if (tag === "strong" || tag === "b") return this.emphasise(node, "**");
    if (tag === "em" || tag === "i") return this.emphasise(node, "*");
    if (tag === "code" || tag === "tt") {
      const body = strip(this.inline(node));
      return body ? `\`${body}\`` : "";
    }
    if (tag === "a") return this.link(node);
    // A block nested where inline was expected: keep its text.
    return this.inline(node);
  }

  emphasise(node: Node, marker: string): string {
    const body = this.inline(node);
    const stripped = strip(body);
    if (!stripped) return body ? " " : "";
    const lead = isSpace(body.slice(0, 1)) ? " " : "";
    const tail = isSpace(body.slice(-1)) ? " " : "";
    return `${lead}${marker}${stripped}${marker}${tail}`;
  }

  link(node: Node): string {
    const body = strip(this.inline(node));
    const href = strip(node.attr("href"));
    if (!href || href === "#") return body;
    const target = absolute(href);
    return body ? `[${body}](${target})` : `<${target}>`;
  }

  image(node: Node): string {
    const src = node.attr("src");
    let alt = strip(collapse(node.attr("alt")));
    const name = this.saveImage(src);
    if (!name) return "";
    this.images += 1;
    alt = alt || `Rajah ${this.images}`;
    return `\n\n![${alt}](${this.assetHref}/${name})\n\n`;
  }

  saveImage(src: string): string | null {
    if (!this.assetDir || !src) return null;
    let blob: Buffer;
    let kind: string;

    const inline = /^data:image\/([a-zA-Z]+);base64,([\s\S]*)/.exec(src);
    if (inline) {
      kind = inline[1]!.toLowerCase().replaceAll("jpeg", "jpg");
      const decoded = b64decode(inline[2]!);
      if (decoded === null) return null;
      blob = decoded;
    } else if (this.fetch) {
      const fetched = this.fetch(absolute(src));
      if (!fetched || fetched.length === 0) return null;
      blob = fetched;
      kind = splitext(src.split("?")[0]!)[1].replace(/^\.+/, "") || "png";
    } else {
      return null;
    }

    const digest = createHash("sha1").update(blob).digest("hex").slice(0, 12);
    const name = `rajah-${digest}.${kind}`;
    mkdirSync(this.assetDir, { recursive: true });
    const path = join(this.assetDir, name);
    if (!existsSync(path)) writeFileSync(path, blob);
    return name;
  }

  // -- block ----------------------------------------------------------

  /** Emit logical blocks, one paragraph per line.
   *
   * Nothing is wrapped here: `rewrap` makes a single pass over the
   * finished document so that hanging indents inside nested lists are
   * computed once, from the real prefix.
   */
  blocks(node: Node): string[] {
    const out: string[] = [];
    let pending: string[] = [];

    const flush = (): void => {
      if (pending.length) {
        out.push(...splitParagraphs(pending.join("")));
        pending = [];
      }
    };

    for (const child of node.children) {
      const tag = child.tag;
      if (SKIP.has(tag)) continue;
      if (tag === "p" || tag === "div" || tag === "section" ||
          tag === "article" || tag === "span") {
        if (hasBlock(child)) {
          flush();
          out.push(...this.blocks(child));
        } else {
          pending.push(this.inline(child) + "\n\n");
        }
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        flush();
        out.push(this.list(child));
        continue;
      }
      if (tag === "table") {
        flush();
        out.push(this.table(child));
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const level = Number(tag[1]);
        const body = strip(this.inline(child));
        if (body) out.push("#".repeat(Math.min(level + 1, 6)) + " " + body);
        continue;
      }
      if (tag === "hr") {
        flush();
        out.push("---");
        continue;
      }
      if (tag === "blockquote") {
        flush();
        out.push(quote(this.blocks(child).join("\n\n")));
        continue;
      }
      pending.push(this.inlineOne(child));
    }

    flush();
    return out.filter((block) => !isBlank(block));
  }

  /** Render a list at column zero; the caller indents nested levels. */
  list(node: Node): string {
    const ordered = node.tag === "ol";
    const style = node.attr("style");
    const alpha = style.includes("lower-alpha") || node.attrs["type"] === "a";
    const roman = style.includes("lower-roman") || node.attrs["type"] === "i";
    const lines: string[] = [];
    let index = 0;

    for (const item of node.children) {
      if (item.tag !== "li") continue;
      index += 1;
      let marker: string;
      if (!ordered) marker = "- ";
      else if (alpha) marker = `${String.fromCharCode(0x61 + index - 1)}. `;
      else if (roman) marker = `${romanNumeral(index)}. `;
      else marker = `${index}. `;

      const parts = this.blocks(item);
      if (!parts.length) continue;
      const head = marker + parts[0];
      const tail = parts.slice(1).map((part) => indentBlock(part));
      const body = [head, ...tail].join("\n\n");
      // An item that carried extra blocks needs a blank line after it, or
      // the next marker is swallowed as a lazy continuation.
      lines.push(tail.length ? body + "\n" : body);
    }
    return lines.join("\n");
  }

  table(node: Node): string {
    let rows: string[][] = [];
    for (const tr of node.findAll("tr")) {
      const cells = tr.children.filter((c) => c.tag === "td" || c.tag === "th");
      if (!cells.length) continue;
      rows.push(cells.map((c) => this.cell(c)));
    }
    if (!rows.length) return "";

    const width = Math.max(...rows.map((r) => r.length));
    rows = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
    let header = rows[0]!;
    if (!header.some((h) => !isBlank(h))) {
      header = Array.from({ length: width }, (_, i) => `Kolum ${i + 1}`);
    }
    const lines = [
      "| " + header.join(" | ") + " |",
      "|" + Array(width).fill("---").join("|") + "|",
    ];
    for (const row of rows.slice(1)) lines.push("| " + row.join(" | ") + " |");
    return lines.join("\n");
  }

  cell(node: Node): string {
    const text = this.blocks(node)
      .filter((part) => !isBlank(part))
      .map((part) => part.split("\n").filter((line) => !isBlank(line)).join("<br>"))
      .join("<br>");
    return strip(text.replaceAll("|", "\\|"));
  }
}

function hasBlock(node: Node): boolean {
  return node.children.some((c) => BLOCK.has(c.tag) || c.tag === "table");
}

function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\n{2,}/)) {
    let cleaned = strip(chunk.replace(/[ \t]+\n/g, "\n"));
    cleaned = strip(cleaned.replaceAll("\u00a0", " "));
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** Leading pad, an optional list marker, then the rest of the line.
 *
 * Digits are matched as ASCII; Python's `\d` also covers other decimal
 * scripts, none of which the handbook uses. */
const MARKER = new RegExp(
  `^(?<pad>${PY_S}*)` +
  `(?<marker>(?:[-*+] )|(?:\\d{1,2}\\. )|(?:[a-z]\\. )|(?:[ivx]{1,4}\\. ))?` +
  `(?<body>.*)$`,
);

const NOWRAP = ["|", "#", "---", "![", "```", ">", "<"] as const;

export function indentBlock(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((line) => (isBlank(line) ? line : pad + line))
    .join("\n");
}

/** Hard-wrap the finished document at 80 columns.
 *
 * Left alone: table rows, headings, images, rules and anything that is a
 * single long token such as a URL. List markers set the hanging indent,
 * so wrapped continuation lines stay under their own item.
 */
export function rewrap(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = strip(line);
    if (!stripped || startsWithAny(stripped, NOWRAP) || clen(line) <= WRAP) {
      out.push(line);
      continue;
    }
    const groups = MARKER.exec(line)!.groups as Record<string, string | undefined>;
    const pad = groups.pad ?? "";
    const marker = groups.marker ?? "";
    const wrapped = wrap(groups.body ?? "", {
      width: WRAP,
      initialIndent: pad + marker,
      subsequentIndent: pad + " ".repeat(clen(marker)),
    });
    out.push(...(wrapped.length ? wrapped : [line]));
  }
  return out.join("\n");
}

export function quote(text: string): string {
  return text.split("\n").map((line) => (line ? "> " + line : ">")).join("\n");
}

export function romanNumeral(n: number): string {
  const table: [number, string][] =
    [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [value, glyph] of table) {
    while (n >= value) {
      out += glyph;
      n -= value;
    }
  }
  return out;
}

const BASE = "https://sqa.jdn.gov.my";

export function absolute(href: string): string {
  let target = unescape(strip(href));
  if (startsWithAny(target, ["http://", "https://", "mailto:", "#"])) return target;
  target = target.replace(/^\/\.\.\//, "/");
  if (!target.startsWith("/")) target = "/" + target;
  return BASE + target.replaceAll(" ", "%20");
}

export function renderHtml(markup: string, options: RendererOptions = {}): string {
  const renderer = new Renderer(options);
  return rewrap(renderer.blocks(parse(markup)).join("\n\n"));
}

// -- helpers ------------------------------------------------------------

/** `base64.b64decode`: characters outside the alphabet are discarded, but
 * the padding still has to add up. Returns null where Python raises. */
function b64decode(text: string): Buffer | null {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const body = clean.replace(/=+$/, "");
  if (clean.length % 4 !== 0 || body.length % 4 === 1) return null;
  return Buffer.from(body, "base64");
}

/** `os.path.splitext`, which ignores dots that lead the basename. */
function splitext(path: string): [string, string] {
  const start = path.lastIndexOf("/") + 1;
  let dot = path.lastIndexOf(".");
  if (dot <= start) return [path, ""];
  let leading = start;
  while (leading < path.length && path[leading] === ".") leading += 1;
  if (dot < leading) return [path, ""];
  return [path.slice(0, dot), path.slice(dot)];
}

// -- docx ---------------------------------------------------------------

const W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}";

/** Render a .docx template as Markdown, keeping headings and tables. */
export function renderDocx(path: string): string {
  const archive = ZipArchive.open(readFileSync(path));
  const xml = archive.read("word/document.xml");
  let styles: Map<string, number>;
  try {
    styles = docxHeadingStyles(archive.read("word/styles.xml"));
  } catch (error) {
    if (!(error instanceof KeyError)) throw error;
    styles = new Map();
  }
  const body = fromstring(xml).find(`${W}body`);
  if (!body) throw new TypeError("word/document.xml has no <w:body>");
  return rewrap(docxBlocks(body, styles).join("\n\n"));
}

export function docxHeadingStyles(xml: Buffer): Map<string, number> {
  const based = new Map<string, string | null>();
  for (const style of fromstring(xml).findall(`${W}style`)) {
    const ident = style.get(`${W}styleId`, "")!;
    const parent = style.find(`${W}basedOn`);
    based.set(ident, parent ? parent.get(`${W}val`) : null);
  }

  const level = (ident: string | null, seen: string[] = []): number => {
    const match = /^(?:Heading|Tajuk)(\d)$/i.exec(ident ?? "");
    if (match) return Number(match[1]);
    if (!ident || seen.includes(ident)) return 0;
    return level(based.get(ident) ?? null, [...seen, ident]);
  };

  const out = new Map<string, number>();
  for (const ident of based.keys()) {
    const value = level(ident);
    if (value) out.set(ident, value);
  }
  return out;
}

export function docxBlocks(parent: Element, styles?: Map<string, number>): string[] {
  const out: string[] = [];
  for (const child of parent) {
    if (child.tag === `${W}p`) {
      const [text, level, bullet] = docxParagraph(child, styles);
      if (!text) continue;
      if (level) out.push("#".repeat(Math.min(level + 1, 6)) + " " + text);
      else if (bullet) out.push("- " + text);
      else out.push(text);
    } else if (child.tag === `${W}tbl`) {
      const table = docxTable(child);
      if (table) out.push(table);
    }
  }
  return out;
}

export function docxParagraph(
  node: Element,
  styles?: Map<string, number>,
): [string, number, boolean] {
  const props = node.find(`${W}pPr`);
  let level = 0;
  let bullet = false;
  if (props) {
    const style = props.find(`${W}pStyle`);
    const name = style ? style.get(`${W}val`, "")! : "";
    const match = /^(?:Heading|Tajuk)(\d)/i.exec(name);
    if (match) level = Number(match[1]);
    else if (styles && styles.size) level = styles.get(name) ?? 0;
    if (props.find(`${W}numPr`)) bullet = true;
  }
  const pieces: string[] = [];
  for (const run of node.iter()) {
    if (run.tag === `${W}t`) pieces.push(run.text ?? "");
    else if (run.tag === `${W}tab` || run.tag === `${W}br`) pieces.push(" ");
  }
  return [strip(collapse(pieces.join(""))), level, bullet];
}

export function docxTable(node: Element): string {
  let rows: string[][] = [];
  for (const tr of node.findall(`${W}tr`)) {
    const cells: string[] = [];
    for (const tc of tr.findall(`${W}tc`)) {
      const parts: string[] = [];
      for (const para of tc.findall(`${W}p`)) {
        const text = docxParagraph(para)[0];
        if (text) parts.push(text);
      }
      cells.push(parts.join("<br>").replaceAll("|", "\\|"));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";

  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  let header = rows[0]!;
  if (!header.some((h) => !isBlank(h))) {
    header = Array.from({ length: width }, (_, i) => `Kolum ${i + 1}`);
  }
  const lines = [
    "| " + header.join(" | ") + " |",
    "|" + Array(width).fill("---").join("|") + "|",
  ];
  for (const row of rows.slice(1)) lines.push("| " + row.join(" | ") + " |");
  return lines.join("\n");
}
