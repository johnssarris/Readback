import { readFileSync } from "node:fs";
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

export function loadPng(path: string): ImageData {
  const png = PNG.sync.read(readFileSync(path));
  return makeImageData(png.width, png.height, new Uint8ClampedArray(png.data));
}

export function cloneImageData(image: ImageData): ImageData {
  return makeImageData(image.width, image.height, new Uint8ClampedArray(image.data));
}
