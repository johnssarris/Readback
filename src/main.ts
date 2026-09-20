import "./style.css";
import { CaptureController } from "./capture/CaptureController";

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

  panel.append(title, hint, button);
  app.appendChild(panel);
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

showStartScreen();
