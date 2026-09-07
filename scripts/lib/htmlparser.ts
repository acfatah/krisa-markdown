/** Port of Python's `html.parser.HTMLParser` with `convert_charrefs=True`.
 *
 * Joomla's output is not well-formed, so the exact recovery behaviour of
 * the standard library parser is what decides where text nodes begin and
 * end. The regexes and the `goahead` state machine below are transcribed
 * from CPython 3.12 `Lib/html/parser.py` rather than re-derived.
 *
 * Only `feed()` is ported. The renderer never calls `close()`, and the
 * trailing buffer CPython would flush there is deliberately left alone.
 */

import { strip } from "./pystr.ts";
import { unescape } from "./unescape.ts";

// Sticky patterns are anchored (`re.match(data, pos)`), global ones scan
// forward (`re.search(data, pos)`).
const interestingNormal = /[&<]/g;
const incomplete = /&[a-zA-Z#]/y;
const entityref = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/y;
const charref = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/y;
const starttagopen = /<[a-zA-Z]/y;
const endtagopen = /<\/[a-zA-Z]/y;
const piclose = />/g;
const commentclose = /--!?>/g;
const commentabruptclose = /-?>/y;
const semicolonish = /[\t\n\r\f ;]/g;
const tagfindTolerant = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const attrfindTolerant =
  /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const locatetagend =
  /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;

const CDATA_CONTENT_ELEMENTS = new Set([
  "script", "style", "xmp", "iframe", "noembed", "noframes",
]);
const RCDATA_CONTENT_ELEMENTS = new Set(["textarea", "title"]);

export type Attr = [string, string | null];

function at(pattern: RegExp, text: string, pos: number): RegExpExecArray | null {
  pattern.lastIndex = pos;
  return pattern.exec(text);
}

function from(pattern: RegExp, text: string, pos: number): RegExpExecArray | null {
  pattern.lastIndex = pos;
  return pattern.exec(text);
}

export class HTMLParser {
  private rawdata = "";
  private interesting: RegExp = interestingNormal;
  private cdataElem: string | null = null;
  private escapable = true;

  feed(data: string): void {
    this.rawdata += data;
    this.goahead();
  }

  // -- overridable handlers -------------------------------------------

  handleStarttag(_tag: string, _attrs: Attr[]): void {}
  handleEndtag(_tag: string): void {}
  handleStartendtag(tag: string, attrs: Attr[]): void {
    this.handleStarttag(tag, attrs);
    this.handleEndtag(tag);
  }
  handleData(_data: string): void {}
  handleComment(_data: string): void {}
  handleDecl(_decl: string): void {}
  handlePi(_data: string): void {}
  unknownDecl(_data: string): void {}

  // -- internal --------------------------------------------------------

  private setCdataMode(elem: string, escapable: boolean): void {
    this.cdataElem = elem.toLowerCase();
    this.escapable = escapable;
    this.interesting = this.cdataElem === "plaintext"
      ? /(?![\s\S])/g
      : new RegExp(`</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, "gi");
  }

  private clearCdataMode(): void {
    this.interesting = interestingNormal;
    this.cdataElem = null;
    this.escapable = true;
  }

  /** `goahead(0)`: consume as much as is unambiguously complete. */
  private goahead(): void {
    const rawdata = this.rawdata;
    const n = rawdata.length;
    let i = 0;

    while (i < n) {
      let j: number;
      if (!this.cdataElem) {
        j = rawdata.indexOf("<", i);
        if (j < 0) {
          // A charref may be cut in half at the end of the buffer; hold
          // the tail back unless the trailing `&` is clearly resolved.
          const last = rawdata.lastIndexOf("&");
          const amppos = last >= Math.max(i, n - 34) ? last : -1;
          if (amppos >= 0 && !from(semicolonish, rawdata, amppos)) break;
          j = n;
        }
      } else {
        const match = from(this.interesting, rawdata, i);
        if (match) j = match.index;
        else break;
      }

      if (i < j) {
        const chunk = rawdata.slice(i, j);
        this.handleData(this.escapable ? unescape(chunk) : chunk);
      }
      i = j;
      if (i === n) break;

      if (rawdata.startsWith("<", i)) {
        let k: number;
        if (at(starttagopen, rawdata, i)) k = this.parseStarttag(i);
        else if (rawdata.startsWith("</", i)) k = this.parseEndtag(i);
        else if (rawdata.startsWith("<!--", i)) k = this.parseComment(i);
        else if (rawdata.startsWith("<?", i)) k = this.parsePi(i);
        else if (rawdata.startsWith("<!", i)) k = this.parseHtmlDeclaration(i);
        else if (i + 1 < n) {
          this.handleData("<");
          k = i + 1;
        } else break;
        if (k < 0) break;
        i = k;
      } else if (rawdata.startsWith("&#", i)) {
        // Unreachable while convert_charrefs is on outside CDATA, and
        // CDATA never reaches here; kept so the shape matches CPython.
        const match = at(charref, rawdata, i);
        if (match) {
          let k = match.index + match[0].length;
          if (!rawdata.startsWith(";", k - 1)) k -= 1;
          i = k;
          continue;
        }
        if (rawdata.slice(i).includes(";")) i += 2;
        break;
      } else if (rawdata.startsWith("&", i)) {
        const match = at(entityref, rawdata, i);
        if (match) {
          let k = match.index + match[0].length;
          if (!rawdata.startsWith(";", k - 1)) k -= 1;
          i = k;
          continue;
        }
        if (at(incomplete, rawdata, i)) break;
        if (i + 1 < n) {
          this.handleData("&");
          i += 1;
        } else break;
      } else {
        throw new Error("interesting.search() lied");
      }
    }
    this.rawdata = rawdata.slice(i);
  }

  private parseHtmlDeclaration(i: number): number {
    const rawdata = this.rawdata;
    if (rawdata.startsWith("<!--", i)) return this.parseComment(i);
    if (rawdata.startsWith("<![CDATA[", i)) {
      const j = rawdata.indexOf("]]>", i + 9);
      if (j < 0) return -1;
      this.unknownDecl(rawdata.slice(i + 3, j));
      return j + 3;
    }
    if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
      const gtpos = rawdata.indexOf(">", i + 9);
      if (gtpos === -1) return -1;
      this.handleDecl(rawdata.slice(i + 2, gtpos));
      return gtpos + 1;
    }
    if (rawdata.startsWith("<![", i)) {
      const j = rawdata.indexOf(">", i + 3);
      if (j < 0) return -1;
      if (rawdata[j - 1] === "]") this.unknownDecl(rawdata.slice(i + 3, j - 1));
      else this.handleComment(rawdata.slice(i + 2, j));
      return j + 1;
    }
    return this.parseBogusComment(i);
  }

  private parseComment(i: number): number {
    const rawdata = this.rawdata;
    let match = from(commentclose, rawdata, i + 4);
    if (!match) {
      match = at(commentabruptclose, rawdata, i + 4);
      if (!match) return -1;
    }
    this.handleComment(rawdata.slice(i + 4, match.index));
    return match.index + match[0].length;
  }

  private parseBogusComment(i: number): number {
    const rawdata = this.rawdata;
    const pos = rawdata.indexOf(">", i + 2);
    if (pos === -1) return -1;
    this.handleComment(rawdata.slice(i + 2, pos));
    return pos + 1;
  }

  private parsePi(i: number): number {
    const rawdata = this.rawdata;
    const match = from(piclose, rawdata, i + 2);
    if (!match) return -1;
    this.handlePi(rawdata.slice(i + 2, match.index));
    return match.index + match[0].length;
  }

  private parseStarttag(i: number): number {
    const rawdata = this.rawdata;
    const endpos = this.checkForWholeStartTag(i);
    if (endpos < 0) return endpos;

    const attrs: Attr[] = [];
    const nameMatch = at(tagfindTolerant, rawdata, i + 1)!;
    let k = nameMatch.index + nameMatch[0].length;
    const tag = nameMatch[1]!.toLowerCase();

    while (k < endpos) {
      const m = at(attrfindTolerant, rawdata, k);
      if (!m) break;
      const attrname = m[1]!;
      const rest = m[2];
      let attrvalue: string | null = m[3] ?? null;
      if (!rest) {
        attrvalue = null;
      } else if (
        attrvalue !== null &&
        ((attrvalue.startsWith("'") && attrvalue.endsWith("'")) ||
          (attrvalue.startsWith('"') && attrvalue.endsWith('"')))
      ) {
        attrvalue = attrvalue.slice(1, -1);
      }
      if (attrvalue) attrvalue = unescape(attrvalue);
      attrs.push([attrname.toLowerCase(), attrvalue]);
      k = m.index + m[0].length;
    }

    const end = strip(rawdata.slice(k, endpos));
    if (end !== ">" && end !== "/>") {
      this.handleData(rawdata.slice(i, endpos));
      return endpos;
    }
    if (end.endsWith("/>")) {
      this.handleStartendtag(tag, attrs);
    } else {
      this.handleStarttag(tag, attrs);
      if (CDATA_CONTENT_ELEMENTS.has(tag) || tag === "plaintext") {
        this.setCdataMode(tag, false);
      } else if (RCDATA_CONTENT_ELEMENTS.has(tag)) {
        this.setCdataMode(tag, true);
      }
    }
    return endpos;
  }

  private checkForWholeStartTag(i: number): number {
    const rawdata = this.rawdata;
    const match = at(locatetagend, rawdata, i + 1)!;
    const j = match.index + match[0].length;
    return rawdata[j - 1] === ">" ? j : -1;
  }

  private parseEndtag(i: number): number {
    const rawdata = this.rawdata;
    if (rawdata.indexOf(">", i + 2) < 0) return -1;
    if (!at(endtagopen, rawdata, i)) {
      if (rawdata.slice(i + 2, i + 3) === ">") return i + 3;
      return this.parseBogusComment(i);
    }
    const match = at(locatetagend, rawdata, i + 2)!;
    const j = match.index + match[0].length;
    if (rawdata[j - 1] !== ">") return -1;
    const tag = at(tagfindTolerant, rawdata, i + 2)![1]!.toLowerCase();
    this.handleEndtag(tag);
    this.clearCdataMode();
    return j;
  }
}
