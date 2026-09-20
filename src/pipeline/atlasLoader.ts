import { buildAtlasFromImageData, type AtlasManifest, type GlyphAtlas } from "./match";

/**
 * Loads the pre-generated glyph atlas (see public/tools/atlas-generator.html) from
 * `${baseUrl}/atlas.png` + `${baseUrl}/atlas-manifest.json`. Returns null (rather than
 * throwing) if the assets aren't present yet, since the atlas is a manual, one-time
 * dev-time artifact the app should degrade gracefully without.
 */
export async function loadAtlasAssets(baseUrl = `${import.meta.env.BASE_URL}atlas`): Promise<GlyphAtlas | null> {
  try {
    const manifestRes = await fetch(`${baseUrl}/atlas-manifest.json`);
    if (!manifestRes.ok) return null;
    const manifest: AtlasManifest = await manifestRes.json();

    const imageRes = await fetch(`${baseUrl}/atlas.png`);
    if (!imageRes.ok) return null;
    const blob = await imageRes.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    return buildAtlasFromImageData(imageData, manifest);
  } catch (err) {
    console.warn("Glyph atlas not available:", err);
    return null;
  }
}
