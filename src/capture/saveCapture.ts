import { APP_VERSION, BUILD_DATE } from "../version";
import type { MarkerReport } from "../pipeline/markers";
import type { PaneAspect, Point } from "../pipeline/rectify";
import type { ScreenProfile, TestText } from "../settings";
import type { KeptCapture } from "./captureQueue";
import { buildZip } from "./zip";

/**
 * Saving captures, so a frame that went wrong can be looked at later.
 *
 * What comes out is a fixture. The sidecar is the format tests/fixtures uses,
 * with the corners as they were finally set and a diagnostics block recording
 * what the detector made of the frame and what the camera was actually doing -
 * so a bad capture drops into tests/fixtures/ unedited and becomes a case that
 * gets measured on every run from then on.
 *
 * A capture is encoded when it is kept, and a session's kept captures leave
 * together, as one zip: see captureQueue.ts.
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
  /** The pane's proportions as a read would take them, and where they came from. */
  aspect?: PaneAspect | null;
  /** The screen profile as given on the start screen, when it was: the pane's size, and its grid if that was given too. */
  screen?: ScreenProfile | null;
  /** The test text that was open, as chosen on the start screen, when it was one. */
  testText?: TestText | null;
  /** What the app read from it, when it was kept from the result screen. */
  read?: { text: string; summary: string[] } | null;
}

/**
 * The capture as it will be kept: its frame as a JPEG, and its sidecar.
 *
 * Named after `when`, which is the moment the frame was frozen rather than
 * the moment it was kept, so the same frame kept twice - once on its own,
 * then again with what was read from it - is one capture, not two.
 */
export async function encodeCapture(record: CaptureRecord, when: Date): Promise<KeptCapture> {
  const name = stamp(when);
  return { name, jpeg: await encode(record.frame), sidecar: sidecar(record, name) };
}

/** How sending ended: handed to the share sheet or downloaded, or called off. */
export type SendOutcome = "sent" | "cancelled";

/**
 * Sends kept captures as one zip, each as a JPEG and a sidecar under its own
 * name, so the zip unpacks straight into tests/fixtures/.
 */
export async function sendCaptures(captures: KeptCapture[], now = new Date()): Promise<SendOutcome> {
  return deliver(await bundleCaptures(captures, now));
}

/** The one zip sendCaptures hands over, named for when and how many. */
export async function bundleCaptures(captures: KeptCapture[], now: Date): Promise<File> {
  const entries = [];
  for (const capture of captures) {
    entries.push({ name: `${capture.name}.jpg`, data: new Uint8Array(await capture.jpeg.arrayBuffer()) });
    entries.push({ name: `${capture.name}.json`, data: new TextEncoder().encode(capture.sidecar) });
  }
  const name = `${stamp(now)}-${captures.length}-shot${captures.length === 1 ? "" : "s"}`;
  return new File([buildZip(entries, now)], `${name}.zip`, { type: "application/zip" });
}

/** The sidecar, in the shape tests/fixtures/README.md describes. */
export function sidecar(record: CaptureRecord, name: string): string {
  const { corners, report, track, frame, aspect, screen } = record;

  return `${JSON.stringify(
    {
      kind: "photo",
      // Named when a test text was chosen, so the capture is scored as it is
      // dropped in; the file is taken from the top unless `lines` is added.
      text: record.testText ?? "REPLACE-ME.txt",
      note: `Saved from Readback ${APP_VERSION} (${BUILD_DATE}) as ${name}`,
      // Kept even when the markers found them: they are what this capture was
      // actually read with, and a fixture that re-detects them should agree.
      corners: ["tl", "tr", "br", "bl"].map((c) => [
        Math.round(corners[c as keyof typeof corners].x),
        Math.round(corners[c as keyof typeof corners].y),
      ]),
      // The whole frame, uncropped: the camera's optical centre is taken to be
      // its middle, so a fixture cut down from it has to say where it was cut.
      frame: { width: frame.width, height: frame.height, cropX: 0, cropY: 0 },
      // What the harness measures the shot against - camera pixels per screen
      // pixel, blur and bow are all in screen pixels - so it goes in when it
      // is known rather than being typed in afterwards.
      ...(screen ? { paneSize: { width: screen.pane.width, height: screen.pane.height } } : {}),
      // And the grid, so the capture is read in the harness the way it was
      // read here, profile and all.
      ...(screen?.grid ? { profile: { ...screen.grid } } : {}),
      diagnostics: {
        frame: { width: frame.width, height: frame.height },
        // What the app made of it, when it was kept after reading: set
        // against the text it should have read, the first thing to look at.
        ...(record.read ? { read: record.read } : {}),
        aspect: aspect ? { value: Number(aspect.aspect.toFixed(4)), method: aspect.method } : null,
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

function encode(frame: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    frame.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The frame could not be encoded"));
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
 * Sharing needs the tap that started this to still count as one, and the zip
 * is built first. The frames were encoded when they were kept, so building it
 * is only copying bytes, well inside the few seconds a tap lasts; nothing
 * slower belongs in front of it.
 */
async function deliver(file: File): Promise<SendOutcome> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "sent";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  // Revoking immediately can cancel the download on some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "sent";
}

/** Local time, sortable, safe in a filename: readback-20260922-154530. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `readback-${date}-${time}`;
}
