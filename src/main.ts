import "./style.css";
import { CaptureController } from "./capture/CaptureController";
import { setupUpdatePrompt } from "./updatePrompt";
import { VERSION_LABEL } from "./version";
import { loadPaneSize, parsePaneSize, savePaneSize } from "./settings";

const app = document.querySelector<HTMLDivElement>("#app")!;

/**
 * iOS Safari only hands out a camera stream on a secure origin, and it is far
 * happier prompting for permission from inside a user gesture, so the app opens
 * on a start screen rather than calling getUserMedia on load.
 */
function showStartScreen(message?: string) {
  app.innerHTML = "";

  const panel = document.createElement("div");
  panel.className = "start-panel";

  const title = document.createElement("h1");
  title.textContent = "Readback";

  const hint = document.createElement("p");
  hint.className = message ? "error" : "start-hint";
  hint.textContent =
    message ?? "Point the camera at the screen you want to read back.";

  const button = document.createElement("button");
  button.className = "shutter-btn";
  button.textContent = message ? "Try again" : "Start camera";
  button.addEventListener("click", () => start());

  const version = document.createElement("p");
  version.className = "version-badge";
  version.textContent = VERSION_LABEL;

  panel.append(title, hint, button, paneSizeField(), version);
  app.appendChild(panel);
}

/**
 * Where to give the pane's size, from the line overlay.py prints. Optional:
 * left empty, the proportions are worked out from each photograph instead.
 */
function paneSizeField(): HTMLElement {
  const field = document.createElement("label");
  field.className = "pane-size";

  const caption = document.createElement("span");
  caption.textContent = "Pane size from overlay.py (optional)";

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.placeholder = "e.g. 985 x 563";
  input.autocomplete = "off";
  const saved = loadPaneSize();
  input.value = saved ? `${saved.width} x ${saved.height}` : "";

  const status = document.createElement("span");
  status.className = "pane-size-status";

  input.addEventListener("change", () => {
    const text = input.value.trim();
    if (text === "") {
      savePaneSize(null);
      status.textContent = "Worked out from each photo.";
      return;
    }
    const size = parsePaneSize(text);
    if (size) {
      savePaneSize(size);
      input.value = `${size.width} x ${size.height}`;
      status.textContent = "Saved.";
    } else {
      status.textContent = "Width x height, like 985 x 563.";
    }
  });

  field.append(caption, input, status);
  return field;
}

async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showStartScreen(
      "This device blocks camera access on insecure connections. Open the app over https (or on localhost).",
    );
    return;
  }

  app.innerHTML = "";
  const controller = new CaptureController(app);
  try {
    await controller.start();
  } catch (err) {
    showStartScreen(describeCameraError(err as Error));
  }
}

function describeCameraError(err: Error): string {
  switch (err.name) {
    case "NotAllowedError":
      return "Camera permission was denied. On iPhone: aA in the address bar → Website Settings → Camera → Allow, then try again.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "The camera is already in use by another app. Close it and try again.";
    default:
      return `Camera access failed: ${err.message}`;
  }
}

setupUpdatePrompt();
showStartScreen();
