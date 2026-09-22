/**
 * A zip archive, stored rather than compressed.
 *
 * Saving a capture means saving two things - the frame and what was measured
 * from it - and they are worth nothing apart: a sidecar without its photo
 * describes an image nobody has. Two downloads from one tap is also the thing
 * iOS Safari is least willing to do. So they go out as one file.
 *
 * Nothing here compresses. The payload is a JPEG and a few hundred bytes of
 * JSON, so deflate would buy nothing off the image and a rounding error off the
 * text, which is not worth carrying a compressor for.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Version 2.0, the floor for the format as written here. */
const VERSION = 20;

/** General purpose bit 11: names are UTF-8. */
const UTF8_NAMES = 0x0800;

const STORED = 0;

export function buildZip(entries: ZipEntry[], modified = new Date()): Blob {
  const names = entries.map((entry) => new TextEncoder().encode(entry.name));
  const time = dosTime(modified);
  const date = dosDate(modified);

  const localSize = names.reduce((sum, name, i) => sum + 30 + name.length + entries[i].data.length, 0);
  const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0);

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;

  const u16 = (value: number) => {
    view.setUint16(at, value, true);
    at += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(at, value, true);
    at += 4;
  };
  const bytes = (value: Uint8Array) => {
    out.set(value, at);
    at += value.length;
  };

  const offsets: number[] = [];
  const crcs: number[] = [];

  entries.forEach((entry, i) => {
    offsets.push(at);
    crcs.push(crc32(entry.data));

    u32(LOCAL_HEADER);
    u16(VERSION);
    u16(UTF8_NAMES);
    u16(STORED);
    u16(time);
    u16(date);
    u32(crcs[i]);
    u32(entry.data.length); // compressed
    u32(entry.data.length); // uncompressed
    u16(names[i].length);
    u16(0); // no extra field
    bytes(names[i]);
    bytes(entry.data);
  });

  const centralStart = at;

  entries.forEach((entry, i) => {
    u32(CENTRAL_HEADER);
    u16(VERSION); // made by
    u16(VERSION); // needed to extract
    u16(UTF8_NAMES);
    u16(STORED);
    u16(time);
    u16(date);
    u32(crcs[i]);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(names[i].length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    bytes(names[i]);
  });

  // Measured before the end record is written, since writing it moves `at`.
  const directoryBytes = at - centralStart;

  u32(END_OF_CENTRAL);
  u16(0); // this disk
  u16(0); // disk the central directory starts on
  u16(entries.length);
  u16(entries.length);
  u32(directoryBytes);
  u32(centralStart);
  u16(0); // comment length

  return new Blob([out], { type: "application/zip" });
}

let table: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time: seconds are stored in units of two. */
function dosTime(d: Date): number {
  return (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
}

/** MS-DOS packed date, counting years from 1980. */
function dosDate(d: Date): number {
  return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
}
