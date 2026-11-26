#!/usr/bin/env bun
/** Pull the KRISA handbook from sqa.jdn.gov.my into Markdown.
 *
 * KRISA (Kejuruteraan Sistem Aplikasi Sektor Awam) is published by JDN as
 * a Joomla site plus per-chapter PDFs and Word templates. The HTML
 * carries the same text as the PDFs, so the chapters are rendered from
 * HTML and the document templates from their .docx originals.
 *
 *     bun scripts/fetch-krisa.ts            # chapters + templates
 *     bun scripts/fetch-krisa.ts --pdf      # also mirror chapter PDFs
 *     bun scripts/fetch-krisa.ts --refresh  # ignore the download cache
 *
 * Downloads are cached under .cache/ so a re-run is cheap and the site is
 * only hit once per page.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  absolute, extract, type Node, parse, renderDocx, renderHtml,
} from "./krisa-md.ts";
import { collapse, PY_S, stripChars, strip, title as pyTitle } from "./lib/pystr.ts";
import { unescape } from "./lib/unescape.ts";

const BASE = "https://sqa.jdn.gov.my";
const INDEX = `${BASE}/index.php/ms/garis-panduan/garis-panduan-pembangunan-aplikasi-krisa`;
const TEMPLATES = `${BASE}/index.php/ms/templat-artifak/dokumen-pembangunan-sistem`;
const AGENT = "Mozilla/5.0 (compatible; krisa-mirror/1.0)";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(ROOT, ".cache");
const DOCS = join(ROOT, "docs");
const TEMPLAT = join(ROOT, "templat");

/** Chapter names are the book's own; nothing in the markup carries them. */
const CHAPTERS: Record<number, string> = {
  1: "Pengenalan",
  2: "Fasa Permulaan Projek",
  3: "Fasa Analisis",
  4: "Fasa Reka Bentuk",
  5: "Fasa Pembangunan",
  6: "Fasa Pengujian",
  7: "Fasa Pelaksanaan",
  8: "Pengiraan Saiz Fungsian",
};

let REFRESH = false;

// -- download cache -----------------------------------------------------

function cachePath(url: string): string {
  const scheme = url.indexOf("://");
  const tail = scheme < 0 ? url : url.slice(scheme + 3);
  const key = tail.replace(/[^A-Za-z0-9._-]/g, "_").slice(-160);
  return join(CACHE, key);
}

/** Fetch a URL through the on-disk cache. */
async function get(url: string): Promise<Buffer | null> {
  const path = cachePath(url);
  mkdirSync(CACHE, { recursive: true });
  if (existsSync(path) && !REFRESH) return readFileSync(path);

  let blob: Buffer;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }
    blob = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(`  ! ${url}: ${message(error)}`);
    return null;
  }
  writeFileSync(path, blob);
  await Bun.sleep(400);
  return blob;
}

async function getText(url: string): Promise<string | null> {
  const blob = await get(url);
  return blob === null ? null : new TextDecoder("utf-8").decode(blob);
}

/** The renderer is synchronous, so images are downloaded ahead of it and
 * read back off the cache. A miss reads as a failed download, which is
 * what the renderer already handles. */
function cached(url: string): Buffer | null {
  const path = cachePath(url);
  return existsSync(path) ? readFileSync(path) : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- index page ---------------------------------------------------------

/** Section labels carry [F2.1] style tags that would break link text. */
function escape(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function slugify(text: string, limit = 60): string {
  let slug = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  slug = stripChars(slug.replace(/[^a-zA-Z0-9]+/g, "-"), "-").toLowerCase();
  return stripChars(slug.slice(0, limit), "-") || "bahagian";
}

/** Every anchor in document order, as [href, text] pairs. */
function links(markup: string): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markup)) !== null) {
    const href = strip(unescape(match[1]!));
    const text = strip(collapse(unescape(match[2]!.replace(/<[^>]+>/g, " "))));
    if (seen.has(href)) continue;
    seen.add(href);
    out.push([href, text]);
  }
  return out;
}

class Section {
  readonly url: string;

  constructor(
    href: string,
    readonly title: string,
    readonly chapter: number,
    readonly number: string,
  ) {
    this.url = absolute(href);
  }

  get label(): string {
    return this.number ? `${this.number} ${this.title}` : this.title;
  }

  get stem(): string {
    if (!this.number) return slugify(this.title);
    const dot = this.number.indexOf(".");
    const major = dot < 0 ? this.number : this.number.slice(0, dot);
    const minor = dot < 0 ? "" : this.number.slice(dot + 1);
    const padded = String(Number.parseInt(minor || "0", 10)).padStart(2, "0");
    return `${major}.${padded}-${slugify(this.title)}`;
  }
}

interface Toc {
  sections: Section[];
  extras: Section[];
  pdfs: Map<number, string>;
}

const NUMBERED = new RegExp(`^(\\d+\\.\\d+)${PY_S}+(.*)`);

/** Walk the index page and group its sections into chapters.
 *
 * The contents live in the sidebar's `<ul id="myUL">`; reading only that
 * list keeps the site menu and footer links out. Each chapter ends with
 * a "Muat Turun Bab N" PDF link, which is what tells us where one
 * chapter stops and the next begins.
 */
function toc(markup: string): Toc {
  const sections: Section[] = [];
  const extras: Section[] = [];
  const pdfs = new Map<number, string>();
  let chapter = 0;

  for (const [href, text] of links(extract(markup, "id", "myUL") ?? "")) {
    const pdf = /BAB(\d)-KRISA-[a-z]+\.pdf/i.exec(href);
    if (pdf) {
      chapter = Number(pdf[1]);
      pdfs.set(chapter, absolute(href));
      continue;
    }
    if (!href.includes("/index.php/ms/")) continue;

    const number = NUMBERED.exec(text);
    if (number) {
      const major = Number(number[1]!.split(".")[0]);
      sections.push(new Section(href, strip(number[2]!), major, number[1]!));
      chapter = major;
    } else if (!chapter) {
      // Front matter, before chapter 1's download link is seen.
      extras.push(new Section(href, pyTitle(text), 0, ""));
    } else if (chapter < 8) {
      // An unnumbered lead-in page, e.g. chapter 2's "Pengenalan".
      sections.push(new Section(href, pyTitle(text), chapter + 1, `${chapter + 1}.0`));
    } else {
      extras.push(new Section(href, pyTitle(text), 9, ""));
    }
  }
  return { sections, extras, pdfs };
}

// -- rendering ----------------------------------------------------------

const SKIP_SUBTREE = new Set(["script", "style", "noscript"]);

/** Image URLs the renderer will ask for, in the order it will ask. */
function imageUrls(node: Node, out: string[] = []): string[] {
  for (const child of node.children) {
    if (SKIP_SUBTREE.has(child.tag)) continue;
    if (child.tag === "img") {
      const src = child.attr("src");
      if (src && !/^data:image\/[a-zA-Z]+;base64,/.test(src)) out.push(absolute(src));
    }
    imageUrls(child, out);
  }
  return out;
}

async function render(section: Section, outDir: string, hrefPrefix = "images") {
  const markup = await getText(section.url);
  if (markup === null) return null;
  const body = extract(markup, "itemprop", "articleBody");
  if (body === null) {
    console.error(`  ! no article body: ${section.url}`);
    return null;
  }
  for (const url of imageUrls(parse(body))) await get(url);

  const text = renderHtml(body, {
    assetDir: join(outDir, "images"),
    assetHref: hrefPrefix,
    fetch: cached,
  });
  const front = [
    "---",
    `title: "${section.label}"`,
    `sumber: ${section.url}`,
    "---",
  ].join("\n");
  return `${front}\n\n# ${section.label}\n\n${text}\n`;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
}

type Written = [Section, string];

async function chapters(sections: Section[], extras: Section[]): Promise<Written[]> {
  const written: Written[] = [];
  for (const section of sections) {
    const chapter = String(section.chapter).padStart(2, "0");
    const outDir = join(DOCS, `bab-${chapter}-${slugify(CHAPTERS[section.chapter]!)}`);
    const text = await render(section, outDir);
    if (text === null) continue;
    const path = join(outDir, section.stem + ".md");
    write(path, text);
    written.push([section, relative(ROOT, path)]);
    console.log(`  ${relative(ROOT, path)}`);
  }
  for (const section of extras) {
    const outDir = join(DOCS, "lampiran");
    const text = await render(section, outDir);
    if (text === null) continue;
    const path = join(outDir, slugify(section.title) + ".md");
    write(path, text);
    written.push([section, relative(ROOT, path)]);
    console.log(`  ${relative(ROOT, path)}`);
  }
  return written;
}

type Template = [code: string, title: string, path: string, url: string];

const DOCX_HREF = /\/(D\d{2}_[A-Z0-9_\-]+)\.docx/;
const WHITESPACE = new RegExp(`${PY_S}+`, "g");

async function templates(): Promise<Template[]> {
  const markup = await getText(TEMPLATES);
  if (markup === null) return [];

  const found = new Map<string, string>();
  for (const [href] of links(markup)) {
    // Some hrefs on the portal carry stray whitespace inside the path.
    const clean = href.replace(WHITESPACE, "");
    const match = DOCX_HREF.exec(clean);
    if (match) found.set(match[1]!, absolute(clean));
  }

  const written: Template[] = [];
  for (const code of [...found.keys()].sort()) {
    const url = found.get(code)!;
    const blob = await get(url);
    if (!blob || blob.length === 0) continue;

    const docxPath = join(TEMPLAT, "docx", code + ".docx");
    mkdirSync(dirname(docxPath), { recursive: true });
    writeFileSync(docxPath, blob);

    const title = pyTitle(code.slice(code.indexOf("_") + 1).replaceAll("_", " "))
      .replace(/\b(Pps|Brs|Srs|Sds|Uat|Pat)\b/g, (m) => m.toUpperCase());

    let body: string;
    try {
      body = renderDocx(docxPath);
    } catch (error) {
      // A template we cannot parse is not fatal.
      console.error(`  ! ${code}: ${message(error)}`);
      continue;
    }

    const front = [
      "---",
      `title: "${code.slice(0, 3)} ${title}"`,
      `sumber: ${url}`,
      `docx: docx/${code}.docx`,
      "---",
    ].join("\n");
    const mdPath = join(TEMPLAT, `${code.slice(0, 3)}-${slugify(title)}.md`);
    write(mdPath, `${front}\n\n# ${code.slice(0, 3)} ${title}\n\n${body}\n`);
    written.push([code, title, relative(ROOT, mdPath), url]);
    console.log(`  ${relative(ROOT, mdPath)}`);
  }
  return written;
}

async function mirrorPdfs(pdfs: Map<number, string>): Promise<void> {
  for (const chapter of [...pdfs.keys()].sort((a, b) => a - b)) {
    const url = pdfs.get(chapter)!;
    const blob = await get(url);
    if (!blob || blob.length === 0) continue;
    const path = join(ROOT, "pdf", basename(url));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, blob);
    console.log(`  ${relative(ROOT, path)}`);
  }
}

/** Regenerate README.md so the index always matches what was pulled. */
function buildIndex(
  written: Written[],
  docs: Template[],
  pdfs: Map<number, string>,
): void {
  const lines = [
    "# KRISA — Kejuruteraan Sistem Aplikasi Sektor Awam",
    "",
    "<p>",
    '  <a href="./LICENSE">',
    "    <img",
    '      alt="License"',
    '      src="https://img.shields.io/github/license/acfatah/krisa-markdown?style=flat-square"',
    "    ></a>",
    '  <a href="https://github.com/acfatah/krisa-markdown/commits/main">',
    "    <img",
    '      alt="Last commit"',
    '      src="https://img.shields.io/github/last-commit/acfatah/krisa-markdown?display_timestamp=committer&style=flat-square"',
    "    ></a>",
    "</p>",
    "",
    "Salinan Markdown bagi buku panduan KRISA terbitan Jabatan Digital",
    "Negara (JDN), untuk rujukan mudah dan carian teks penuh.",
    "",
    `Sumber: <${INDEX}>`,
    "",
    "Semua kandungan hak milik JDN. Repositori ini hanya salinan",
    "rujukan; sila rujuk portal MySQA untuk versi rasmi dan terkini.",
    "",
    "## Kandungan",
    "",
  ];

  const byChapter = new Map<number, Written[]>();
  for (const entry of written) {
    const bucket = byChapter.get(entry[0].chapter);
    if (bucket) bucket.push(entry);
    else byChapter.set(entry[0].chapter, [entry]);
  }

  for (const chapter of [...byChapter.keys()].sort((a, b) => a - b)) {
    if (chapter === 0) lines.push("### Pendahuluan");
    else if (chapter === 9) lines.push("### Lampiran");
    else lines.push(`### Bab ${chapter} — ${CHAPTERS[chapter]}`);
    lines.push("");
    for (const [section, path] of byChapter.get(chapter)!) {
      lines.push(`- [${escape(section.label)}](${path})`);
    }
    if (pdfs.has(chapter)) lines.push(`- PDF rasmi: <${pdfs.get(chapter)}>`);
    lines.push("");
  }

  lines.push(
    "## Templat dokumen",
    "",
    "| Kod | Dokumen | Markdown | DOCX |",
    "|---|---|---|---|",
  );
  for (const [code, title, path] of docs) {
    lines.push(
      `| ${code.slice(0, 3)} | ${title} | [md](${path}) ` +
      `| [docx](templat/docx/${code}.docx) |`,
    );
  }
  lines.push(
    "",
    "## Menjana semula",
    "",
    "```bash",
    "bun run fetch           # bab + templat",
    "bun run fetch:pdf       # sertakan PDF rasmi",
    "bun run fetch:refresh   # abaikan cache",
    "```",
    "",
    "Memerlukan Bun sahaja; tiada kebergantungan masa larian luar.",
    "Muat turun disimpan dalam `.cache/`.",
    "",
    "## Lesen",
    "",
    "Skrip dalam `scripts/` dan fail konfigurasi dilesenkan di bawah",
    "[MIT](LICENSE). Kandungan dalam `docs/` dan `templat/` kekal hak milik",
    "JDN dan tidak termasuk dalam lesen ini.",
    "",
  );
  write(join(ROOT, "README.md"), lines.join("\n"));
}

// -- entry point --------------------------------------------------------

const USAGE = `usage: fetch-krisa.ts [-h] [--pdf] [--refresh]

Pull the KRISA handbook from sqa.jdn.gov.my into Markdown.

options:
  -h, --help  show this help message and exit
  --pdf       also mirror the eight chapter PDFs (~13 MB)
  --refresh   bypass the download cache
`;

function parseArgs(argv: string[]): { pdf: boolean; refresh: boolean } {
  const options = { pdf: false, refresh: false };
  for (const arg of argv) {
    if (arg === "--pdf") options.pdf = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      process.stderr.write(
        `${USAGE}\nfetch-krisa.ts: error: unrecognized arguments: ${arg}\n`,
      );
      process.exit(2);
    }
  }
  return options;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  REFRESH = args.refresh;

  const index = await getText(INDEX);
  if (index === null) return 1;
  const { sections, extras, pdfs } = toc(index);
  console.log(`Bahagian: ${sections.length} + ${extras.length} lampiran`);
  if (sections.length === 0) {
    // A layout change on the site; writing now would empty README.md.
    process.stderr.write("fetch-krisa.ts: no sections found on the index page\n");
    return 1;
  }
  const written = await chapters(sections, extras);
  console.log("Templat:");
  const docs = await templates();
  if (args.pdf) {
    console.log("PDF:");
    await mirrorPdfs(pdfs);
  }
  buildIndex(written, docs, pdfs);
  console.log(`Siap: ${written.length} bahagian, ${docs.length} templat`);
  return 0;
}

process.exitCode = await main();
