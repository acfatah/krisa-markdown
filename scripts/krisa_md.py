"""HTML and DOCX to Markdown rendering for the KRISA handbook.

Pure standard library: the target box has no pip, no pandoc, no poppler.
"""

import base64
import hashlib
import html
import os
import re
import textwrap
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree

WRAP = 80

VOID = {"br", "img", "hr", "input", "meta", "link", "col"}
SKIP = {"script", "style", "noscript"}
BLOCK = {
    "p", "div", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4",
    "h5", "h6", "blockquote", "pre", "section", "article",
}


class Node:
    def __init__(self, tag, attrs=None):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.children = []
        self.text = ""

    def find_all(self, tag):
        for child in self.children:
            if child.tag == tag:
                yield child
            yield from child.find_all(tag)


class TreeBuilder(HTMLParser):
    """Builds a forgiving DOM. Joomla output is not well-formed XML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        node = Node("#text")
        node.text = data
        self.stack[-1].children.append(node)


def parse(markup):
    builder = TreeBuilder()
    builder.feed(markup)
    return builder.root


def extract(markup, attr, value):
    """Return the raw substring of the element carrying attr="value".

    Balances nested tags of the same name so a wrapper div is not cut short.
    """
    anchor = markup.find(f'{attr}="{value}"')
    if anchor < 0:
        return None
    start = markup.rfind("<", 0, anchor)
    name = re.match(r"<([a-zA-Z0-9]+)", markup[start:]).group(1)
    pattern = re.compile(rf"<(/?){name}\b", re.I)
    depth = 0
    for match in pattern.finditer(markup, start):
        depth += -1 if match.group(1) else 1
        if depth == 0:
            return markup[start:markup.index(">", match.end()) + 1]
    return markup[start:]


class Renderer:
    """Walks a Node tree and emits Markdown.

    ``asset_dir`` receives images pulled out of base64 data URIs;
    ``asset_href`` is the path they are referenced by from the Markdown file.
    """

    def __init__(self, asset_dir=None, asset_href=".", fetch=None):
        self.asset_dir = asset_dir
        self.asset_href = asset_href
        self.fetch = fetch
        self.images = 0

    # -- inline ---------------------------------------------------------

    def inline(self, node):
        out = []
        for child in node.children:
            out.append(self.inline_one(child))
        return "".join(out)

    def inline_one(self, node):
        tag = node.tag
        if tag == "#text":
            return re.sub(r"\s+", " ", node.text)
        if tag in SKIP:
            return ""
        if tag == "br":
            return "\n"
        if tag == "img":
            return self.image(node)
        if tag in ("strong", "b"):
            return self.emphasise(node, "**")
        if tag in ("em", "i"):
            return self.emphasise(node, "*")
        if tag in ("code", "tt"):
            body = self.inline(node).strip()
            return f"`{body}`" if body else ""
        if tag == "a":
            return self.link(node)
        if tag in BLOCK:
            # A block nested where inline was expected: keep its text.
            return self.inline(node)
        return self.inline(node)

    def emphasise(self, node, marker):
        body = self.inline(node)
        stripped = body.strip()
        if not stripped:
            return " " if body else ""
        lead = " " if body[:1].isspace() else ""
        tail = " " if body[-1:].isspace() else ""
        return f"{lead}{marker}{stripped}{marker}{tail}"

    def link(self, node):
        body = self.inline(node).strip()
        href = node.attrs.get("href", "").strip()
        if not href or href == "#":
            return body
        href = absolute(href)
        return f"[{body}]({href})" if body else f"<{href}>"

    def image(self, node):
        src = node.attrs.get("src", "")
        alt = re.sub(r"\s+", " ", node.attrs.get("alt", "")).strip()
        name = self.save_image(src)
        if not name:
            return ""
        self.images += 1
        alt = alt or f"Rajah {self.images}"
        return f"\n\n![{alt}]({self.asset_href}/{name})\n\n"

    def save_image(self, src):
        if not self.asset_dir or not src:
            return None
        match = re.match(r"data:image/([a-zA-Z]+);base64,(.*)", src, re.S)
        if match:
            kind = match.group(1).lower().replace("jpeg", "jpg")
            try:
                blob = base64.b64decode(match.group(2))
            except Exception:
                return None
        elif self.fetch:
            blob = self.fetch(absolute(src))
            if not blob:
                return None
            kind = os.path.splitext(src.split("?")[0])[1].lstrip(".") or "png"
        else:
            return None
        digest = hashlib.sha1(blob).hexdigest()[:12]
        name = f"rajah-{digest}.{kind}"
        os.makedirs(self.asset_dir, exist_ok=True)
        path = os.path.join(self.asset_dir, name)
        if not os.path.exists(path):
            with open(path, "wb") as handle:
                handle.write(blob)
        return name

    # -- block ----------------------------------------------------------

    def blocks(self, node):
        """Emit logical blocks, one paragraph per line.

        Nothing is wrapped here: ``rewrap`` makes a single pass over the
        finished document so that hanging indents inside nested lists are
        computed once, from the real prefix.
        """
        out = []
        pending = []

        def flush():
            if pending:
                for para in split_paragraphs("".join(pending)):
                    out.append(para)
                pending.clear()

        for child in node.children:
            tag = child.tag
            if tag in SKIP:
                continue
            if tag in ("p", "div", "section", "article", "span"):
                if has_block(child):
                    flush()
                    out.extend(self.blocks(child))
                else:
                    pending.append(self.inline(child) + "\n\n")
                continue
            if tag in ("ul", "ol"):
                flush()
                out.append(self.list(child))
                continue
            if tag == "table":
                flush()
                out.append(self.table(child))
                continue
            if re.fullmatch(r"h[1-6]", tag or ""):
                flush()
                level = int(tag[1])
                body = self.inline(child).strip()
                if body:
                    out.append("#" * min(level + 1, 6) + " " + body)
                continue
            if tag == "hr":
                flush()
                out.append("---")
                continue
            if tag == "blockquote":
                flush()
                out.append(quote("\n\n".join(self.blocks(child))))
                continue
            pending.append(self.inline_one(child))

        flush()
        return [b for b in out if b.strip()]

    def list(self, node):
        """Render a list at column zero; the caller indents nested levels."""
        ordered = node.tag == "ol"
        style = node.attrs.get("style", "")
        alpha = "lower-alpha" in style or node.attrs.get("type") == "a"
        roman = "lower-roman" in style or node.attrs.get("type") == "i"
        lines = []
        index = 0
        for item in node.children:
            if item.tag != "li":
                continue
            index += 1
            if not ordered:
                marker = "- "
            elif alpha:
                marker = f"{chr(ord('a') + index - 1)}. "
            elif roman:
                marker = f"{roman_numeral(index)}. "
            else:
                marker = f"{index}. "
            parts = self.blocks(item)
            if not parts:
                continue
            head = marker + parts[0]
            tail = [indent_block(part) for part in parts[1:]]
            body = "\n\n".join([head] + tail)
            # An item that carried extra blocks needs a blank line after it,
            # or the next marker is swallowed as a lazy continuation.
            lines.append(body + "\n" if tail else body)
        return "\n".join(lines)

    def table(self, node):
        rows = []
        for tr in node.find_all("tr"):
            cells = [c for c in tr.children if c.tag in ("td", "th")]
            if not cells:
                continue
            rows.append([self.cell(c) for c in cells])
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        header = rows[0]
        if not any(h.strip() for h in header):
            header = [f"Kolum {i + 1}" for i in range(width)]
            body = rows[1:]
        else:
            body = rows[1:]
        lines = ["| " + " | ".join(header) + " |",
                 "|" + "|".join(["---"] * width) + "|"]
        for row in body:
            lines.append("| " + " | ".join(row) + " |")
        return "\n".join(lines)

    def cell(self, node):
        parts = self.blocks(node)
        text = "<br>".join(
            "<br>".join(line for line in part.split("\n") if line.strip())
            for part in parts if part.strip()
        )
        return text.replace("|", "\\|").strip()


def has_block(node):
    return any(c.tag in BLOCK or c.tag == "table" for c in node.children)


def split_paragraphs(text):
    for chunk in re.split(r"\n{2,}", text):
        cleaned = re.sub(r"[ \t]+\n", "\n", chunk).strip()
        cleaned = cleaned.replace("\xa0", " ").strip()
        if cleaned:
            yield cleaned


MARKER = re.compile(
    r"^(?P<pad>\s*)"
    r"(?P<marker>(?:[-*+] )|(?:\d{1,2}\. )|(?:[a-z]\. )|(?:[ivx]{1,4}\. ))?"
    r"(?P<body>.*)$"
)

NOWRAP = ("|", "#", "---", "![", "```", ">", "<")


def indent_block(text, pad="    "):
    return "\n".join(pad + line if line.strip() else line
                      for line in text.split("\n"))


def rewrap(text):
    """Hard-wrap the finished document at 80 columns.

    Left alone: table rows, headings, images, rules and anything that is
    a single long token such as a URL. List markers set the hanging
    indent, so wrapped continuation lines stay under their own item.
    """
    out = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith(NOWRAP) or len(line) <= WRAP:
            out.append(line)
            continue
        match = MARKER.match(line)
        pad = match.group("pad")
        marker = match.group("marker") or ""
        body = match.group("body")
        wrapped = textwrap.wrap(
            body, width=WRAP,
            initial_indent=pad + marker,
            subsequent_indent=pad + " " * len(marker),
            break_long_words=False, break_on_hyphens=False,
        )
        out.extend(wrapped or [line])
    return "\n".join(out)


def quote(text):
    return "\n".join("> " + line if line else ">"
                     for line in text.split("\n"))


def roman_numeral(n):
    table = [(10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
    out = ""
    for value, glyph in table:
        while n >= value:
            out += glyph
            n -= value
    return out


BASE = "https://sqa.jdn.gov.my"


def absolute(href):
    href = html.unescape(href.strip())
    if href.startswith(("http://", "https://", "mailto:", "#")):
        return href
    href = re.sub(r"^/\.\./", "/", href)
    if not href.startswith("/"):
        href = "/" + href
    return BASE + href.replace(" ", "%20")


def render_html(markup, asset_dir=None, asset_href=".", fetch=None):
    renderer = Renderer(asset_dir, asset_href, fetch)
    return rewrap("\n\n".join(renderer.blocks(parse(markup))))


# -- docx ---------------------------------------------------------------

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def render_docx(path):
    """Render a .docx template as Markdown, keeping headings and tables."""
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
        try:
            styles = docx_heading_styles(archive.read("word/styles.xml"))
        except KeyError:
            styles = {}
    body = ElementTree.fromstring(xml).find(f"{W}body")
    return rewrap("\n\n".join(docx_blocks(body, styles)))


def docx_heading_styles(xml):
    """Map style ids to heading levels.

    The KRISA templates do not use Word's built-in Heading styles directly.
    They define Style1..Style4, each based on a Heading style, so the
    chain has to be followed to recover the level.
    """
    based = {}
    for style in ElementTree.fromstring(xml).findall(f"{W}style"):
        ident = style.get(f"{W}styleId", "")
        parent = style.find(f"{W}basedOn")
        based[ident] = parent.get(f"{W}val") if parent is not None else None

    def level(ident, seen=()):
        match = re.match(r"(?:Heading|Tajuk)(\d)$", ident or "", re.I)
        if match:
            return int(match.group(1))
        if not ident or ident in seen:
            return 0
        return level(based.get(ident), seen + (ident,))

    return {ident: level(ident) for ident in based if level(ident)}


def docx_blocks(parent, styles=None):
    out = []
    for child in parent:
        if child.tag == f"{W}p":
            text, level, bullet = docx_paragraph(child, styles)
            if not text:
                continue
            if level:
                out.append("#" * min(level + 1, 6) + " " + text)
            elif bullet:
                out.append("- " + text)
            else:
                out.append(text)
        elif child.tag == f"{W}tbl":
            table = docx_table(child)
            if table:
                out.append(table)
    return out


def docx_paragraph(node, styles=None):
    props = node.find(f"{W}pPr")
    level = 0
    bullet = False
    if props is not None:
        style = props.find(f"{W}pStyle")
        name = style.get(f"{W}val", "") if style is not None else ""
        match = re.match(r"(?:Heading|Tajuk)(\d)", name, re.I)
        if match:
            level = int(match.group(1))
        elif styles:
            level = styles.get(name, 0)
        if props.find(f"{W}numPr") is not None:
            bullet = True
    pieces = []
    for run in node.iter():
        if run.tag == f"{W}t":
            pieces.append(run.text or "")
        elif run.tag in (f"{W}tab", f"{W}br"):
            pieces.append(" ")
    text = re.sub(r"\s+", " ", "".join(pieces)).strip()
    return text, level, bullet


def docx_table(node):
    rows = []
    for tr in node.findall(f"{W}tr"):
        cells = []
        for tc in tr.findall(f"{W}tc"):
            parts = []
            for para in tc.findall(f"{W}p"):
                text = docx_paragraph(para)[0]
                if text:
                    parts.append(text)
            cells.append("<br>".join(parts).replace("|", "\\|"))
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    header = rows[0]
    if not any(h.strip() for h in header):
        header = [f"Kolum {i + 1}" for i in range(width)]
    lines = ["| " + " | ".join(header) + " |",
             "|" + "|".join(["---"] * width) + "|"]
    for row in rows[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)
