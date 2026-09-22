import { APP_VERSION, BUILD_DATE } from "../version";
import type { MarkerReport } from "../pipeline/markers";
import type { Point } from "../pipeline/rectify";
import { buildZip } from "./zip";

/**
 * Saving a capture, so a frame that went wrong can be looked at later.
 *
 * What comes out is a fixture. The sidecar is the format tests/fixtures uses,
 * with the corners as they were finally set and a diagnostics block recording
 * what the detector made of the frame and what the camera was actually doing -
 * so a bad capture drops into tests/fixtures/ unedited and becomes a case that
 * gets measured on every run from then on.
 */

/** JPEG rather than PNG: a photograph of a screen, at the size a phone takes it. */
const IMAGE_TYPE = "image/jpeg";

/** High enough that the compression is not what the recognition is failing on. */
const IMAGE_QUALITY = 0.92;

export interface CaptureRecord {
  /** The frozen frame, at the resolution the camera gave it. */
  frame: HTMLCanvasElement;
  /** The corners as they stood when saved, whether detected or dragged. */
  corners: Record<"tl" | "tr" | "br" | "bl", Point>;
  /** Whether those corners came from the markers or from a fingertip. */
  fromMarkers: boolean;
  /** What the detector made of the frame. */
  report: MarkerReport;
  /** What the camera was actually doing, as the track reports it. */
  track: MediaTrackSettings | null;
}

/**
 * Writes the capture out as one zip.
 *
 * One file rather than two: a sidecar without its frame describes an image
 * nobody has, and two downloads from a single tap is the thing iOS Safari is
 * least willing to do.
 */
export async function saveCapture(record: CaptureRecord, now = new Date()): Promise<void> {
  const name = stamp(now);
  const image = await encode(record.frame);

  const zip = buildZip(
    [
      { name: `${name}.jpg`, data: image },
      { name: `${name}.json`, data: new TextEncoder().encode(sidecar(record, name)) },
    ],
    now
  );

  await deliver(new File([zip], `${name}.zip`, { type: "application/zip" }));
}

/** The sidecar, in the shape tests/fixtures/README.md describes. */
export function sidecar(record: CaptureRecord, name: string): string {
  const { corners, report, track, frame } = record;

  return `${JSON.stringify(
    {
      kind: "photo",
      text: "REPLACE-ME.txt",
      note: `Saved from Readback ${APP_VERSION} (${BUILD_DATE}) as ${name}`,
      // Kept even when the markers found them: they are what this capture was
      // actually read with, and a fixture that re-detects them should agree.
      corners: ["tl", "tr", "br", "bl"].map((c) => [
        Math.round(corners[c as keyof typeof corners].x),
        Math.round(corners[c as keyof typeof corners].y),
      ]),
      diagnostics: {
        frame: { width: frame.width, height: frame.height },
        cornersFrom: record.fromMarkers ? "markers" : "hand",
        markers: {
          outcome: report.outcome,
          threshold: report.threshold,
          blobs: report.blobs,
          candidates: report.candidates,
          quadsTried: report.quadsTried,
          levels: report.levels,
          agreeing: report.agreeing,
          ms: report.ms,
        },
        // What the camera granted, which is rarely what was asked for.
        track,
      },
    },
    null,
    2
  )}\n`;
}

function encode(frame: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    frame.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("The frame could not be encoded"));
          return;
        }
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      IMAGE_TYPE,
      IMAGE_QUALITY
    );
  });
}

/**
 * Hands the file over however this browser does it.
 *
 * Sharing is the good path on a phone - it reaches Files, AirDrop and every
 * messaging app, which is how a capture actually gets off the device and to
 * someone who can look at it. A download is the desktop answer, and the
 * fallback when sharing is refused. Cancelling the share sheet is not a
 * failure and must not fall through to a download the person did not ask for.
 *
 * Sharing needs the tap that started this to still count as one, and encoding
 * the frame happens first. Encoding a phone-sized JPEG is a fraction of the
 * few seconds that lasts, but it is why nothing slower belongs in front of it.
 */
async function deliver(file: File): Promise<void> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  // Revoking immediately can cancel the download on some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Local time, sortable, safe in a filename: readback-20260922-154530. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `readback-${date}-${time}`;
}
