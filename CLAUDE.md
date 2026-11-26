# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this repo is

An unofficial Markdown copy of JDN's KRISA handbook (Kejuruteraan Sistem
Aplikasi Sektor Awam), scraped from the Joomla site at sqa.jdn.gov.my. The
content is in Malay; the code and its comments are in English.

Almost everything outside `scripts/` is generated output. Only the scripts and
the config files are original work, and only they are covered by the MIT
LICENSE. `docs/` and `templat/` stay JDN's.

## Commands

```bash
bun install             # dev dependencies only (typescript, @types/bun)
bun run fetch           # regenerate docs/, templat/ and README.md
bun run fetch:pdf       # also download the 8 chapter PDFs into pdf/
bun run fetch:refresh   # ignore .cache/ and download everything again
bun run typecheck       # tsc --noEmit; the only static check
```

There are no tests and no linter. **The check for any change is a rerun of
`bun run fetch` followed by `git status`.** A change that should not affect
the output must leave the working tree clean; a change that should affect it
must show only the expected diff.

- **Use the cache.** `bun run fetch` reads from `.cache/` (ignored, never
  committed), so it works offline and doesn't load the site.
- **TLS on refresh.** The site sends no intermediate certificate, so
  `fetch:refresh` fails with `unable to verify the first certificate`. To
  refresh, the user has chosen to run it with `NODE_TLS_REJECT_UNAUTHORIZED=0`
  for that one run. Never write that into the scripts or `package.json`.

## Generated files

- **Don't edit `docs/`, `templat/` or `README.md` by hand.** The next run
  overwrites them.
- **README.md comes from `buildIndex()`** in `scripts/fetch-krisa.ts`. That
  includes the badge block, the "Menjana semula" and "Lesen" sections, and the
  `acfatah/krisa-markdown` badge URLs. Change the README there, then rerun the
  fetch to regenerate it.
- **`templat/docx/`** holds copies of JDN's original DOCX files, next to their
  Markdown renders.

## Architecture

`scripts/fetch-krisa.ts` downloads and writes the files, and
`scripts/krisa-md.ts` turns HTML and DOCX into Markdown:

1. **Download with a cache.** `get()` stores each URL as one flat file in
   `.cache/`, named from the URL.
2. **Contents.** `toc()` reads only the sidebar's `<ul id="myUL">` on the
   index page. A "Muat Turun Bab N" PDF link marks the end of each chapter.
   Links numbered `N.NN` become sections, and the others become `lampiran`
   (appendices). If it finds no sections, `main()` stops so README.md isn't
   emptied.
3. **Chapters.** `render()` takes each page's `itemprop="articleBody"`,
   downloads its images in document order first, then renders it. The
   renderer is synchronous and reads images back from the cache. Base64 data
   URIs are saved into an `images/` folder next to the Markdown file.
4. **Templates.** `templates()` collects the `Dxx_*.docx` links from the
   templates page, copies each DOCX file into `templat/docx/`, and renders it
   with `renderDocx()`. A DOCX file that fails to parse is skipped, not fatal.
5. **Index.** `buildIndex()` rewrites README.md from what was actually
   written.

The chapter names in `CHAPTERS` are hard-coded, because nothing in the markup
carries them.

## Parity with Python (`scripts/lib/`)

The code is a port of Python scripts that wrote this same output byte for
byte. The Python version is kept on the `python` branch. `scripts/lib/`
reproduces the CPython standard-library behaviour that the output depends on:

- **`htmlparser.ts`:** `html.parser`, including how it recovers from the
  site's malformed markup.
- **`pystr.ts`:** Python's `\s`, `strip`, `title` and `expandtabs`, and
  string length counted in code points.
- **`textwrap.ts`, `unescape.ts`, `entities.ts`:** `textwrap.wrap`,
  `html.unescape` and the HTML5 entity table.
- **`xml.ts`, `zip.ts`:** ElementTree and `zipfile`, used to read DOCX files.

**Don't replace these with JavaScript's own versions,** such as `\s`,
`.trim()`, `.length` or `DOMParser`. They behave differently on edge cases,
and that changes the output. Use `PY_S` and `strip()` from `pystr.ts` in any
new regexes or string handling.

## Repo conventions

- **No runtime dependencies.** Only Bun and the Node built-ins (`node:fs`,
  `node:path`, `node:crypto`).
- **Branches.** `main` is the TypeScript version and the default branch;
  `python` is the original Python version.
- **Strict TypeScript.** `tsconfig.json` enables `strict` mode,
  `noUncheckedIndexedAccess` and the unused-code checks, and allows imports
  ending in `.ts`.
