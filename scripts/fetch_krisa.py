#!/usr/bin/env python3
"""Pull the KRISA handbook from sqa.jdn.gov.my into Markdown.

KRISA (Kejuruteraan Sistem Aplikasi Sektor Awam) is published by JDN as a
Joomla site plus per-chapter PDFs and Word templates. The HTML carries the
same text as the PDFs, so the chapters are rendered from HTML and the
document templates from their .docx originals.

    python3 scripts/fetch_krisa.py            # chapters + templates
    python3 scripts/fetch_krisa.py --pdf      # also mirror chapter PDFs
    python3 scripts/fetch_krisa.py --refresh  # ignore the download cache

Downloads are cached under .cache/ so a re-run is cheap and the site is
only hit once per page.
"""

import argparse
import html
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import krisa_md

BASE = "https://sqa.jdn.gov.my"
INDEX = f"{BASE}/index.php/ms/garis-panduan/garis-panduan-pembangunan-aplikasi-krisa"
TEMPLATES = f"{BASE}/index.php/ms/templat-artifak/dokumen-pembangunan-sistem"
AGENT = "Mozilla/5.0 (compatible; krisa-mirror/1.0)"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
DOCS = os.path.join(ROOT, "docs")
TEMPLAT = os.path.join(ROOT, "templat")

# Chapter names are the book's own; nothing in the markup carries them.
CHAPTERS = {
    1: "Pengenalan",
    2: "Fasa Permulaan Projek",
    3: "Fasa Analisis",
    4: "Fasa Reka Bentuk",
    5: "Fasa Pembangunan",
    6: "Fasa Pengujian",
    7: "Fasa Pelaksanaan",
    8: "Pengiraan Saiz Fungsian",
}

REFRESH = False


def get(url, binary=False):
    """Fetch a URL through the on-disk cache."""
    key = re.sub(r"[^A-Za-z0-9._-]", "_", url.split("://", 1)[-1])[-160:]
    path = os.path.join(CACHE, key)
    os.makedirs(CACHE, exist_ok=True)
    if os.path.exists(path) and not REFRESH:
        with open(path, "rb") as handle:
            blob = handle.read()
    else:
        request = urllib.request.Request(url, headers={"User-Agent": AGENT})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                blob = response.read()
        except (urllib.error.URLError, OSError) as error:
            print(f"  ! {url}: {error}", file=sys.stderr)
            return None
        with open(path, "wb") as handle:
            handle.write(blob)
        time.sleep(0.4)
    return blob if binary else blob.decode("utf-8", "replace")


def escape(text):
    """Section labels carry [F2.1] style tags that would break link text."""
    return text.replace("[", "\\[").replace("]", "\\]")


def slugify(text, limit=60):
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:limit].strip("-") or "bahagian"


def links(markup):
    """Every anchor in document order, as (href, text) pairs."""
    out = []
    seen = set()
    pattern = re.compile(r'<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', re.I)
    for match in pattern.finditer(markup):
        href = html.unescape(match.group(1)).strip()
        text = re.sub(r"<[^>]+>", " ", match.group(2))
        text = re.sub(r"\s+", " ", html.unescape(text)).strip()
        if href in seen:
            continue
        seen.add(href)
        out.append((href, text))
    return out


class Section:
    def __init__(self, href, title, chapter, number):
        self.url = krisa_md.absolute(href)
        self.title = title
        self.chapter = chapter
        self.number = number

    @property
    def label(self):
        return f"{self.number} {self.title}" if self.number else self.title

    @property
    def stem(self):
        if not self.number:
            return slugify(self.title)
        major, _, minor = self.number.partition(".")
        return f"{major}.{int(minor or 0):02d}-{slugify(self.title)}"


def toc(markup):
    """Walk the index page and group its sections into chapters.

    Each chapter ends with a "Muat Turun Bab N" PDF link, which is what
    tells us where one chapter stops and the next begins.
    """
    sections = []
    extras = []
    pdfs = {}
    chapter = 0
    for href, text in links(markup):
        pdf = re.search(r"BAB(\d)-KRISA-[a-z]+\.pdf", href, re.I)
        if pdf:
            chapter = int(pdf.group(1))
            pdfs[chapter] = krisa_md.absolute(href)
            continue
        if "/index.php/ms/" not in href or "/../" not in href:
            continue
        number = re.match(r"^(\d+\.\d+)\s+(.*)", text)
        if number:
            major = int(number.group(1).split(".")[0])
            sections.append(
                Section(href, number.group(2).strip(), major, number.group(1))
            )
            chapter = major
        elif not chapter:
            # Front matter, before chapter 1's download link is seen.
            extras.append(Section(href, text.title(), 0, ""))
        elif chapter and chapter < 8:
            # An unnumbered lead-in page, e.g. chapter 2's "Pengenalan".
            sections.append(
                Section(href, text.title(), chapter + 1, f"{chapter + 1}.0")
            )
        else:
            extras.append(Section(href, text.title(), 9, ""))
    return sections, extras, pdfs


def render(section, out_dir, href_prefix="images"):
    markup = get(section.url)
    if markup is None:
        return None
    body = krisa_md.extract(markup, "itemprop", "articleBody")
    if body is None:
        print(f"  ! no article body: {section.url}", file=sys.stderr)
        return None
    asset_dir = os.path.join(out_dir, "images")
    text = krisa_md.render_html(
        body, asset_dir=asset_dir, asset_href=href_prefix,
        fetch=lambda u: get(u, binary=True),
    )
    front = "\n".join([
        "---",
        f'title: "{section.label}"',
        f"sumber: {section.url}",
        "---",
    ])
    heading = f"# {section.label}"
    return f"{front}\n\n{heading}\n\n{text}\n"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def chapters(sections, extras, pdfs):
    written = []
    for section in sections:
        folder = f"bab-{section.chapter:02d}-{slugify(CHAPTERS[section.chapter])}"
        out_dir = os.path.join(DOCS, folder)
        text = render(section, out_dir)
        if text is None:
            continue
        path = os.path.join(out_dir, section.stem + ".md")
        write(path, text)
        written.append((section, os.path.relpath(path, ROOT)))
        print(f"  {os.path.relpath(path, ROOT)}")
    for section in extras:
        out_dir = os.path.join(DOCS, "lampiran")
        text = render(section, out_dir)
        if text is None:
            continue
        path = os.path.join(out_dir, slugify(section.title) + ".md")
        write(path, text)
        written.append((section, os.path.relpath(path, ROOT)))
        print(f"  {os.path.relpath(path, ROOT)}")
    return written


def templates():
    markup = get(TEMPLATES)
    if markup is None:
        return []
    found = {}
    for href, _ in links(markup):
        # Some hrefs on the portal carry stray whitespace inside the path.
        clean = re.sub(r"\s+", "", href)
        match = re.search(r"/(D\d{2}_[A-Z0-9_\-]+)\.docx", clean)
        if match:
            found[match.group(1)] = krisa_md.absolute(clean)
    written = []
    for code in sorted(found):
        url = found[code]
        blob = get(url, binary=True)
        if not blob:
            continue
        docx_path = os.path.join(TEMPLAT, "docx", code + ".docx")
        os.makedirs(os.path.dirname(docx_path), exist_ok=True)
        with open(docx_path, "wb") as handle:
            handle.write(blob)
        title = code.split("_", 1)[1].replace("_", " ").title()
        title = re.sub(
            r"\b(Pps|Brs|Srs|Sds|Uat|Pat)\b",
            lambda m: m.group(1).upper(), title,
        )
        try:
            body = krisa_md.render_docx(docx_path)
        except Exception as error:  # a template we cannot parse is not fatal
            print(f"  ! {code}: {error}", file=sys.stderr)
            continue
        front = "\n".join([
            "---",
            f'title: "{code[:3]} {title}"',
            f"sumber: {url}",
            f"docx: docx/{code}.docx",
            "---",
        ])
        md_path = os.path.join(TEMPLAT, f"{code[:3]}-{slugify(title)}.md")
        write(md_path, f"{front}\n\n# {code[:3]} {title}\n\n{body}\n")
        written.append((code, title, os.path.relpath(md_path, ROOT), url))
        print(f"  {os.path.relpath(md_path, ROOT)}")
    return written


def mirror_pdfs(pdfs):
    for chapter in sorted(pdfs):
        blob = get(pdfs[chapter], binary=True)
        if not blob:
            continue
        path = os.path.join(ROOT, "pdf", os.path.basename(pdfs[chapter]))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(blob)
        print(f"  {os.path.relpath(path, ROOT)}")


def main():
    global REFRESH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", action="store_true",
                        help="also mirror the eight chapter PDFs (~13 MB)")
    parser.add_argument("--refresh", action="store_true",
                        help="bypass the download cache")
    args = parser.parse_args()
    REFRESH = args.refresh
    krisa_md.REFRESH = args.refresh

    index = get(INDEX)
    if index is None:
        return 1
    sections, extras, pdfs = toc(index)
    print(f"Bahagian: {len(sections)} + {len(extras)} lampiran")
    written = chapters(sections, extras, pdfs)
    print("Templat:")
    docs = templates()
    if args.pdf:
        print("PDF:")
        mirror_pdfs(pdfs)
    build_index(written, docs, pdfs)
    print(f"Siap: {len(written)} bahagian, {len(docs)} templat")
    return 0


def build_index(written, docs, pdfs):
    """Regenerate README.md so the index always matches what was pulled."""
    lines = [
        "# KRISA — Kejuruteraan Sistem Aplikasi Sektor Awam",
        "",
        "Salinan Markdown bagi buku panduan KRISA terbitan Jabatan Digital",
        "Negara (JDN), untuk rujukan mudah dan carian teks penuh.",
        "",
        f"Sumber: <{INDEX}>",
        "",
        "Semua kandungan hak milik JDN. Repositori ini hanya salinan",
        "rujukan; sila rujuk portal MySQA untuk versi rasmi dan terkini.",
        "",
        "## Kandungan",
        "",
    ]
    by_chapter = {}
    for section, path in written:
        by_chapter.setdefault(section.chapter, []).append((section, path))
    for chapter in sorted(by_chapter):
        if chapter == 0:
            lines.append("### Pendahuluan")
        elif chapter == 9:
            lines.append("### Lampiran")
        else:
            lines.append(f"### Bab {chapter} — {CHAPTERS[chapter]}")
        lines.append("")
        for section, path in by_chapter[chapter]:
            lines.append(f"- [{escape(section.label)}]({path})")
        if chapter in pdfs:
            lines.append(f"- PDF rasmi: <{pdfs[chapter]}>")
        lines.append("")
    lines += ["## Templat dokumen", "",
              "| Kod | Dokumen | Markdown | DOCX |",
              "|---|---|---|---|"]
    for code, title, path, url in docs:
        lines.append(
            f"| {code[:3]} | {title} | [md]({path}) "
            f"| [docx](templat/docx/{code}.docx) |"
        )
    lines += [
        "",
        "## Menjana semula",
        "",
        "```bash",
        "python3 scripts/fetch_krisa.py           # bab + templat",
        "python3 scripts/fetch_krisa.py --pdf     # sertakan PDF rasmi",
        "python3 scripts/fetch_krisa.py --refresh # abaikan cache",
        "```",
        "",
        "Tiada kebergantungan luar; pustaka standard Python 3 sahaja.",
        "Muat turun disimpan dalam `.cache/`.",
        "",
    ]
    write(os.path.join(ROOT, "README.md"), "\n".join(lines))


if __name__ == "__main__":
    raise SystemExit(main())
