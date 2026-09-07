/** A small `xml.etree.ElementTree` stand-in for WordprocessingML.
 *
 * Tags and attributes come back in ElementTree's `{namespace}local` form,
 * and `find`/`findall` match direct children only, exactly as the module
 * this replaces does. Word writes well-formed XML, so recovery from
 * malformed input is not attempted.
 */

const NAME = "[^\\s/>=]+";
const TAG = new RegExp(
  `<(?<closing>/?)(?<name>${NAME})(?<attrs>(?:\\s+${NAME}\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(?<empty>/?)>`,
  "y",
);
const ATTR = new RegExp(`(${NAME})\\s*=\\s*"([^"]*)"|(${NAME})\\s*=\\s*'([^']*)'`, "g");

const XML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return XML_ENTITIES[body] ?? all;
  });
}

export class Element {
  readonly children: Element[] = [];
  /** Character data before the first child, or null when there is none. */
  text: string | null = null;

  constructor(
    readonly tag: string,
    readonly attrib: Readonly<Record<string, string>>,
  ) {}

  get(key: string, fallback: string | null = null): string | null {
    return key in this.attrib ? this.attrib[key]! : fallback;
  }

  find(tag: string): Element | null {
    return this.children.find((child) => child.tag === tag) ?? null;
  }

  findall(tag: string): Element[] {
    return this.children.filter((child) => child.tag === tag);
  }

  /** Self and every descendant, in document order. */
  *iter(): Generator<Element> {
    yield this;
    for (const child of this.children) yield* child.iter();
  }

  [Symbol.iterator](): Iterator<Element> {
    return this.children[Symbol.iterator]();
  }
}

interface Frame {
  element: Element;
  namespaces: Map<string, string>;
}

function qualify(
  name: string,
  namespaces: Map<string, string>,
  isAttribute: boolean,
): string {
  const colon = name.indexOf(":");
  if (colon < 0) {
    // Only elements pick up the default namespace; attributes never do.
    const uri = isAttribute ? undefined : namespaces.get("");
    return uri ? `{${uri}}${name}` : name;
  }
  const prefix = name.slice(0, colon);
  const local = name.slice(colon + 1);
  const uri = namespaces.get(prefix);
  return uri ? `{${uri}}${local}` : name;
}

/** `ElementTree.fromstring`. */
export function fromstring(source: Buffer | string): Element {
  const xml = typeof source === "string" ? source : source.toString("utf8");
  const root = new Element("#document", {});
  // The `xml` prefix is bound by the specification, never declared.
  const stack: Frame[] = [{
    element: root,
    namespaces: new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]),
  }];

  const addText = (raw: string, expand = true): void => {
    if (!raw) return;
    const parent = stack[stack.length - 1]!.element;
    // ElementTree hangs text that follows a child element off that child
    // as its `tail`; nothing here reads tails, so it is dropped.
    if (parent.children.length > 0) return;
    parent.text = (parent.text ?? "") + (expand ? decode(raw) : raw);
  };

  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      addText(xml.slice(i));
      break;
    }
    addText(xml.slice(i, lt));

    // Comments, CDATA, processing instructions and the doctype are
    // consumed here; ElementTree reports none of them to the caller.
    if (xml.startsWith("<!--", lt)) {
      i = skipTo(xml, lt + 4, "-->", 3);
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      const stop = close < 0 ? xml.length : close;
      addText(xml.slice(lt + 9, stop), false);
      i = close < 0 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      i = skipTo(xml, lt + 2, "?>", 2);
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      i = skipTo(xml, lt + 2, ">", 1);
      continue;
    }

    TAG.lastIndex = lt;
    const match = TAG.exec(xml);
    if (!match) {
      // A stray `<` that does not open a tag is literal text.
      addText("<");
      i = lt + 1;
      continue;
    }
    i = TAG.lastIndex;
    const { closing, name, attrs, empty } = match.groups as Record<string, string>;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const parent = stack[stack.length - 1]!;
    const namespaces = new Map(parent.namespaces);
    const attrib: Record<string, string> = {};
    const pending: [string, string][] = [];

    ATTR.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = ATTR.exec(attrs ?? "")) !== null) {
      const key = attr[1] ?? attr[3]!;
      const value = decode(attr[2] ?? attr[4]!);
      if (key === "xmlns") namespaces.set("", value);
      else if (key.startsWith("xmlns:")) namespaces.set(key.slice(6), value);
      else pending.push([key, value]);
    }
    for (const [key, value] of pending) {
      attrib[qualify(key, namespaces, true)] = value;
    }

    const element = new Element(qualify(name!, namespaces, false), attrib);
    parent.element.children.push(element);
    if (!empty) stack.push({ element, namespaces });
  }

  const document = root.children[0];
  if (!document) throw new Error("no element found");
  return document;
}

function skipTo(xml: string, from: number, close: string, width: number): number {
  const at = xml.indexOf(close, from);
  return at < 0 ? xml.length : at + width;
}
