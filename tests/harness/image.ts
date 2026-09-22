import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/**
 * Node has no ImageData, and the pipeline only ever touches width/height/data,
 * so the harness passes the same plain-object stand-in the unit tests use.
 */
export function makeImageData(width: number, height: number, data?: Uint8ClampedArray): ImageData {
  return {
    width,
    height,
    data: data ?? new Uint8ClampedArray(width * height * 4),
    colorSpace: "srgb",
  } as ImageData;
}

/**
 * A fixture image, whichever of the two formats it is stored in.
 *
 * Rendered fixtures are PNGs because they are drawn rather than captured and
 * nothing should be lost between drawing and measuring. A photo arrives from a
 * phone as a JPEG, and is kept as one: re-encoding it as PNG would preserve
 * every compression artifact it already has while costing four times the space.
 */
export function loadImage(path: string): ImageData {
  if (/\.jpe?g$/i.test(path)) {
    const { width, height, data } = jpeg.decode(readFileSync(path), { useTArray: true });
    return makeImageData(width, height, new Uint8ClampedArray(data.buffer, data.byteOffset, data.length));
  }
  const png = PNG.sync.read(readFileSync(path));
  return makeImageData(png.width, png.height, new Uint8ClampedArray(png.data));
}

export function cloneImageData(image: ImageData): ImageData {
  return makeImageData(image.width, image.height, new Uint8ClampedArray(image.data));
}
