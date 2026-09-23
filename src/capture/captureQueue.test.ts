import { describe, expect, it } from "vitest";
import { memoryQueue, type KeptCapture } from "./captureQueue";
import { bundleCaptures } from "./saveCapture";

/**
 * A session's captures, kept one at a time and sent as one zip. IndexedDB is a
 * browser's, so the queue is checked here through its in-memory stand-in,
 * which keeps to the same promises.
 */

function kept(name: string, jpeg = [0xff, 0xd8, 0xff, 0xd9]): KeptCapture {
  return { name, jpeg: new Blob([new Uint8Array(jpeg)]), sidecar: `{"name":"${name}"}\n` };
}

describe("the capture queue", () => {
  it("counts what it keeps and hands it back oldest first", async () => {
    const queue = memoryQueue();
    expect(await queue.add(kept("readback-20260923-101502"))).toBe(1);
    expect(await queue.add(kept("readback-20260923-101455"))).toBe(2);
    expect((await queue.list()).map((c) => c.name)).toEqual(["readback-20260923-101455", "readback-20260923-101502"]);
  });

  // The same frame kept again from the result screen carries what was read
  // from it; it replaces the first copy rather than going out twice.
  it("keeps one copy of a frame kept twice, the later one", async () => {
    const queue = memoryQueue();
    await queue.add(kept("readback-20260923-101502"));
    const count = await queue.add({ ...kept("readback-20260923-101502"), sidecar: "read" });
    expect(count).toBe(1);
    expect((await queue.list())[0].sidecar).toBe("read");
  });

  it("is empty once cleared", async () => {
    const queue = memoryQueue();
    await queue.add(kept("a"));
    await queue.clear();
    expect(await queue.count()).toBe(0);
  });
});

describe("bundleCaptures", () => {
  it("puts every kept capture's frame and sidecar in one zip, under the capture's name", async () => {
    const captures = [kept("readback-20260923-101455"), kept("readback-20260923-101502")];
    const file = await bundleCaptures(captures, new Date(2026, 8, 23, 10, 20, 0));
    expect(file.name).toBe("readback-20260923-102000-2-shots.zip");

    // The central directory names every entry; read them off in order.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    const entries = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const names: string[] = [];
    for (let i = 0; i < entries; i++) {
      const length = view.getUint16(at + 28, true);
      names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)));
      at += 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    expect(names).toEqual([
      "readback-20260923-101455.jpg",
      "readback-20260923-101455.json",
      "readback-20260923-101502.jpg",
      "readback-20260923-101502.json",
    ]);
  });
});
