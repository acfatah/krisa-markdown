/** Just enough of `zipfile` to read named members out of a .docx.
 *
 * Stored and deflated entries only, which is all Word writes. ZIP64 is
 * rejected rather than half-supported.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  headerOffset: number;
}

export class ZipArchive {
  private constructor(
    private readonly buffer: Buffer,
    private readonly entries: Map<string, Entry>,
  ) {}

  static open(buffer: Buffer): ZipArchive {
    const eocd = findEocd(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) throw new Error("ZIP64 archives are not supported");

    const entries = new Map<string, Entry>();
    for (let i = 0; i < count; i += 1) {
      if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw new Error("bad central directory signature");
      }
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
      entries.set(name, {
        name,
        method: buffer.readUInt16LE(offset + 10),
        compressedSize: buffer.readUInt32LE(offset + 20),
        headerOffset: buffer.readUInt32LE(offset + 42),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipArchive(buffer, entries);
  }

  /** `ZipFile.read(name)`; throws the way `KeyError` would. */
  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new KeyError(name);

    const start = entry.headerOffset;
    if (this.buffer.readUInt32LE(start) !== LOCAL_SIGNATURE) {
      throw new Error(`bad local header for ${name}`);
    }
    const nameLength = this.buffer.readUInt16LE(start + 26);
    const extraLength = this.buffer.readUInt16LE(start + 28);
    const from = start + 30 + nameLength + extraLength;
    const raw = this.buffer.subarray(from, from + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported compression method ${entry.method} for ${name}`);
  }
}

/** Stands in for Python's `KeyError`, which `render_docx` catches by name. */
export class KeyError extends Error {
  constructor(key: string) {
    super(key);
    this.name = "KeyError";
  }
}

function findEocd(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT);
  for (let i = buffer.length - EOCD_SIZE; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a zip archive: no end of central directory record");
}
