# Readback

Point an iPhone camera at a text editor on screen, rectify the captured quad, and
read the text back.

The app needs a camera, and browsers only hand out `getUserMedia` on a **secure
origin** — so on a phone it has to be served over HTTPS. GitHub Pages provides
that for free.

## Deploying to GitHub Pages

The repo builds and deploys itself via `.github/workflows/deploy.yml` on every
push to `main`. One-time setup in the GitHub web UI:

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the **Actions** tab).

The site is then live at `https://<your-user>.github.io/Readback/`.

### Base path

Project Pages serve from a subdirectory, so `vite.config.ts` sets
`base: "/Readback/"`. If you move the app to a custom domain or a user/org page
(served from `/`), build with `BASE_PATH=/ npm run build`.

## Installing on an iPhone

1. Open `https://<your-user>.github.io/Readback/` in **Safari** (other iOS
   browsers can be picky about camera permissions).
2. Tap **Start camera** and allow access when prompted.
3. Optional, for a fullscreen app-like window: **Share → Add to Home Screen**.

If permission was denied by accident, reset it from **aA** in the Safari address
bar → **Website Settings → Camera → Allow**.

## Versions and updates

The build stamps the short commit and build date into the bundle, and the start
screen shows them (`2026-09-20 · 6996d3e`) — so a phone can say exactly which
deploy it is running.

The service worker registers in **prompt** mode. A new deploy is fetched in the
background, then the app offers an **Update** toast rather than swapping itself
out mid-capture; **Later** keeps the current version until the next reload. A
running app re-checks for a new deploy hourly and whenever it returns to the
foreground, which matters for a home-screen install that is never really closed.

## The glyph atlas

Recognition matches each character cell against a template, so the app needs a
sprite sheet of the face the editor is set to. That face is **Cascadia Mono**
(it ships with Windows 11), bundled under `public/fonts/` so the atlas never
silently renders in a fallback font.

```sh
npm run atlas   # renders public/atlas/atlas.png + atlas-manifest.json
```

`public/tools/atlas-generator.html` does the same in a browser, and can render
from a locally installed font file instead of the bundled one.

## Development

```sh
npm install
npm run dev     # http://localhost:5173 — a secure context, so the camera works
npm test
npm run build

npm run metrics   # run the fixtures through the pipeline and print the numbers
npm run fixtures  # re-render the synthetic fixtures
```

`tests/fixtures/README.md` explains what a fixture is and how to add a real
screenshot or phone photo.

To test on a phone against the dev server you still need HTTPS; deploy to Pages
or put a tunnel (e.g. `cloudflared`, `ngrok`) in front of `npm run dev`.
