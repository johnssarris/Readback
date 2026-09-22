import { describe, expect, it } from "vitest";
import { buildZip } from "./zip";

/**
 * The archive has to be readable by whatever the person opens it with, which is
 * not this code - so these check the bytes against the format rather than
 * against a round trip through the same assumptions that wrote them.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("buildZip", () => {
  it("writes a local header, then the file, for each entry", async () => {
    const zip = await bytesOf(buildZip([{ name: "a.txt", data: ascii("hello") }]));

    expect(zip.getUint32(0, true)).toBe(LOCAL_HEADER);
    expect(zip.getUint16(8, true)).toBe(0); // stored, not deflated
    expect(zip.getUint32(18, true)).toBe(5); // compressed size
    expect(zip.getUint32(22, true)).toBe(5); // uncompressed size
    expect(zip.getUint16(26, true)).toBe(5); // name length

    const name = new TextDecoder().decode(new Uint8Array(zip.buffer, 30, 5));
    expect(name).toBe("a.txt");
    expect(new TextDecoder().decode(new Uint8Array(zip.buffer, 35, 5))).toBe("hello");
  });

  it("points the central directory at each entry's local header", async () => {
    const entries = [
      { name: "photo.jpg", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "photo.json", data: ascii("{}") },
    ];
    const zip = await bytesOf(buildZip(entries));

    // End of central directory is the last 22 bytes; it says where the
    // directory starts and how many entries it holds.
    const end = zip.byteLength - 22;
    expect(zip.getUint32(end, true)).toBe(END_OF_CENTRAL);
    expect(zip.getUint16(end + 10, true)).toBe(2);

    const directoryAt = zip.getUint32(end + 16, true);
    expect(zip.getUint32(directoryAt, true)).toBe(CENTRAL_HEADER);

    // The directory's recorded size has to end exactly where the end record
    // begins: a reader locates the directory by subtracting one from the other,
    // so an offset that is right on its own is not enough.
    expect(zip.getUint32(end + 12, true)).toBe(end - directoryAt);

    // Each central record's offset must land on that entry's local header.
    let at = directoryAt;
    for (const entry of entries) {
      expect(zip.getUint32(at, true)).toBe(CENTRAL_HEADER);
      const offset = zip.getUint32(at + 42, true);
      expect(zip.getUint32(offset, true)).toBe(LOCAL_HEADER);
      expect(zip.getUint32(offset + 22, true)).toBe(entry.data.length);
      at += 46 + zip.getUint16(at + 28, true);
    }
    expect(at).toBe(end);
  });

  it("computes the CRC the format specifies", async () => {
    // "123456789" is the standard CRC-32 check value.
    const zip = await bytesOf(buildZip([{ name: "c", data: ascii("123456789") }]));
    expect(zip.getUint32(14, true)).toBe(0xcbf43926);
  });
});
