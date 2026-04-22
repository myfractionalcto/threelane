# SnapScreen — Plan

A locally-hosted Electron app for Mac that records screen + webcam + a mobile
companion camera simultaneously over the same WiFi network, then edits the
tracks into portrait/landscape reels with per-scene layouts and exports to MP4.

Not a SaaS. Everything runs on the host laptop; the mobile device is an
**installable PWA** (Chrome on Android, Safari on iOS) served by that laptop.

---

## 1. High-level architecture

```
┌────────────────────────── Mac laptop (host) ──────────────────────────┐
│                                                                        │
│   Electron main process (Node)                                         │
│     • desktopCapturer (screen)                                         │
│     • project storage on disk                                          │
│     • Express + Socket.IO over HTTPS    ◄──── WiFi ───────┐            │
│       (self-signed TLS for getUserMedia)                  │            │
│     • ffmpeg-static for export                            │            │
│                                                           │            │
│   Renderer (React)                                        │            │
│     ├── Recorder studio (Riverside-style)                 │            │
│     └── Editor (OpenScreen-style timeline)                │            │
│                                                           │            │
└───────────────────────────────────────────────────────────┼────────────┘
                                                            │
                                              ┌─────────────▼──────────────┐
                                              │  Mobile PWA (Chrome/Safari)│
                                              │   • installable, offline-  │
                                              │     capable shell          │
                                              │   • MediaRecorder locally  │
                                              │   • Uploads clip on stop   │
                                              └────────────────────────────┘
```

Design principle: **record each input as its own file, never pre-composite**.
The editor makes all layout/audio choices after the fact, so the raw material
must stay separable.

Per recording session you get, on disk:

```
~/Movies/SnapScreen/<project-id>/
  screen.webm           # laptop screen (video only)
  laptop-cam.webm       # laptop webcam (video+audio, or video only)
  laptop-mic.webm       # laptop mic (if recorded separately)
  mobile-<id>.webm      # uploaded from phone after stop
  manifest.json         # track list, start offsets, sync data
```

---

## 2. Tech stack

| Concern                 | Choice                                             |
|-------------------------|----------------------------------------------------|
| App shell               | Electron (Mac universal — arm64 + x64)             |
| Renderer build          | Vite + React + TypeScript                          |
| UI kit                  | Tailwind + shadcn/ui (matches Riverside/OpenScreen aesthetic) |
| State                   | Zustand (light, fits both recorder + editor)       |
| Companion server        | Express + Socket.IO (inside Electron main)         |
| QR for mobile link      | `qrcode`                                           |
| Video export            | `ffmpeg-static` + `fluent-ffmpeg`                  |
| Packaging               | electron-builder (.dmg for Mac)                    |

---

## 3. Recording pipeline

### 3.1 Laptop-side

- **Screen**: `navigator.mediaDevices.getDisplayMedia` in the renderer, or
  `desktopCapturer.getSources` → `getUserMedia({ chromeMediaSource: 'desktop' })`
  for more control (pick a specific screen/window).
- **Webcam + mic**: `getUserMedia({ video, audio })`.
- Each stream goes into its **own** `MediaRecorder` (separate webm files).
  Chunks are piped to disk via IPC so memory stays flat for long recordings.
- A master clock (`performance.now()` anchored to a wall-clock at t=0) stamps
  every chunk so tracks can be aligned later.

### 3.2 Mobile companion (PWA)

- Electron main runs an **HTTPS** server on a local port (e.g.
  `https://<mac-ip>:7878`). HTTPS is mandatory: mobile browsers block
  `getUserMedia` on non-`localhost` HTTP, and PWA install needs a secure
  context. TLS strategy: see §3.4.
- User clicks "Add device" → renderer shows QR code + short URL.
- Phone opens the URL in Chrome (Android) or Safari (iOS). The page is a
  **PWA**: `manifest.webmanifest` with icons + name + `display: standalone`,
  and a service worker caching the shell so once installed it launches like
  an app ("Add to Home Screen").
- Service worker scope is the mobile page only — the Mac app's origin never
  installs a SW.
- WebSocket handshake over WSS: device registers, swaps clock offsets
  (several round trips, median — same trick NTP uses) so we know how far
  the phone's clock drifts from the Mac's.
- Mobile requests camera + mic permission, shows preview, signals "ready".
- When the Mac hits Record, the server broadcasts `start(targetTs)`; each
  side starts its own `MediaRecorder` as close to that timestamp as
  possible and records the actual start offset.
- On stop, the phone uploads the blob to the server (chunked `POST`).
  Uploads continue in the background via the service worker if the user
  navigates away.
- Manifest records the mobile's measured offset so the editor places its
  track accurately on the timeline.

### 3.3 Cross-browser notes (Chrome Android vs Safari iOS)

- Both support `getUserMedia`, `MediaRecorder`, WebSocket, service workers,
  and PWA install — with caveats:
  - iOS: PWA install is "Add to Home Screen" from the share sheet (no
    install prompt). Must include `apple-touch-icon` + meta tags.
  - iOS: `MediaRecorder` works on Safari 14.1+ but only supports a narrow
    set of codecs — we'll probe `isTypeSupported()` and fall back from
    `video/webm` to `video/mp4;codecs=h264` on iOS.
  - Android Chrome: full `video/webm;codecs=vp9,opus` support — preferred.
- We record on the device in whichever codec it supports, transcode on
  import if needed (ffmpeg handles both).

### 3.4 TLS strategy for the local server — **local CA (mkcert-style)**

Decision: Electron generates a small root CA on first launch and issues a
leaf cert for the Mac's current WiFi IP. That leaf cert is what the HTTPS
server uses.

Flow when the user adds a phone:
1. Mac UI shows QR for the companion URL.
2. It also surfaces a "Install certificate on this phone" helper that
   serves the root CA as a `.mobileconfig` profile (iOS) or `.crt`
   (Android) from a plain-HTTP bootstrap path, with on-screen instructions
   ("Settings → Profile Downloaded → Install").
3. Once the CA is trusted, the PWA URL loads with a green padlock, no
   warnings, `getUserMedia` works, and PWA install is available.

One-time per phone. After that it's seamless. We regenerate the leaf cert
(same CA) whenever the Mac's WiFi IP changes — no re-install needed on the
phone because the CA is already trusted.

Fallback: if the user refuses the profile install, the app also works with
"tap through the browser warning" self-signed mode — same cert, just
without the trust anchor. Camera access on iOS Safari becomes unreliable
in that mode, which is exactly why the CA install is the primary path.

### 3.5 Live mobile preview on the Mac (monitoring only)

The phone still records the **full-quality** clip locally and uploads on
stop — that's non-negotiable for quality. On top of that, the phone opens
a WebRTC peer connection to the Mac and sends a **low-bitrate, video-only**
stream (e.g. 360p, ~500 kbps) purely for live monitoring in the Mac UI.

- If WiFi hiccups and the preview stutters or drops, the recorded file is
  unaffected — they're independent pipelines.
- No audio on the preview (avoids echo when the Mac mic is also live).
- Preview frames are discarded; nothing from this stream ends up in the
  editor.

Signaling rides the existing Socket.IO WSS channel. Uses the browser's
built-in `RTCPeerConnection` on both ends — no media server, direct peer
connection on the local WiFi.

### 3.6 What v1 still does NOT do

- No remote-control of phone camera settings (exposure, zoom, front/back
  swap from the Mac).
- No resumable uploads — if the phone crashes mid-upload, re-upload from
  scratch. (The clip is still on the phone, so it's not lost.)

---

## 4. Editor

Look-and-feel: OpenScreen-style — large preview, timeline below, inspector
panel on the right for the selected scene.

### 4.1 Core model

```ts
Project {
  canvas: { width, height, orientation: 'portrait' | 'landscape' }
  tracks: Track[]         // raw, immutable
  scenes: Scene[]         // ordered, cover the full output duration
}

Scene {
  start, end              // in output time
  layout:
    | 'mobile-only'
    | 'laptop-screen-only'
    | 'laptop-cam-only'
    | 'split-horizontal'   // half / half
    | 'screen-with-bubble' // screen full, cam pip corner
  bubbleCorner?: 'tl' | 'tr' | 'bl' | 'br'
  audioSource: TrackId     // exactly one track's audio plays
}
```

Multi-cam layouts source from: `laptop-screen`, `laptop-cam`, `mobile-cam`.

### 4.2 Preview

- Canvas-based compositor that samples frames from underlying `<video>`
  elements at preview time. Fast enough for 1080p scrubbing on M-series Macs.
- Audio routed from the chosen track via a `<audio>` element or the
  source `<video>`'s audio track.

### 4.3 Cutting

- v1: **manual cuts only** — click timeline to split, drag handles to trim.
- v2 (nice-to-have): auto-silence-based cuts for the selected audio track.

### 4.4 Output resolutions

- Portrait (default): **1080×1920** (9:16)
- Landscape: **1920×1080** (16:9)
- Square: **1080×1080** (1:1)

### 4.5 Export

- Render each scene with ffmpeg:
  - Use `-filter_complex` to position inputs per the scene's layout (scale,
    crop, overlay).
  - Pick one audio stream per scene.
- Concat scenes with the concat demuxer or an overarching filter graph.
- Output: `libx264` + `aac`, mp4, yuv420p for compatibility.
- Progress events streamed from ffmpeg to the renderer for a progress bar.

---

## 5. UI structure

```
/Users/ashmilhussain/Documents/Personal-Projects/SnapScreen/
├── electron/
│   ├── main.ts
│   ├── preload.ts
│   ├── recorder/
│   │   ├── screen.ts
│   │   └── storage.ts
│   ├── companion/
│   │   ├── server.ts
│   │   ├── sync.ts
│   │   └── upload.ts
│   └── export/
│       └── ffmpeg.ts
├── src/                      # renderer
│   ├── app.tsx               # route between Home / Recorder / Editor
│   ├── recorder/             # Riverside-style studio
│   ├── editor/               # OpenScreen-style timeline
│   ├── components/ui/        # shadcn primitives
│   └── store/
├── mobile-pwa/
│   ├── index.html            # PWA shell served to phone
│   ├── manifest.webmanifest
│   ├── service-worker.ts
│   └── icons/
├── package.json
└── electron-builder.yml
```

---

## 6. Build order (milestones)

1. **Scaffold** — Electron + Vite + React + Tailwind; "hello" window packaged
   as a dmg.
2. **Laptop screen + cam recorder** — single-user, two tracks, writes to
   `~/Movies/SnapScreen/<project>/`. No editor yet — just file output.
3. **Minimal editor v0** — load a project, scrub, manual cut, pick layout,
   export to mp4 via ffmpeg. Proves the end-to-end loop.
4. **Mobile companion** — companion server, QR flow, time sync, upload,
   third track shows up in the editor. This is the big one.
5. **Polish editor** — OpenScreen-style UI, bubble corner picker, per-scene
   audio source, portrait/landscape toggle.
6. **Packaging** — signed & notarized .dmg so you can double-click install.

Each milestone ends with something you can actually use end-to-end; we don't
build the mobile half before the laptop half works.

---

## 7. Decisions (locked)

1. **TLS** — local CA, mkcert-style. Generated on first launch, installed
   once per phone. Details in §3.4.
2. **Recording format** — WebM (VP9 + Opus) during capture on devices that
   support it; iOS Safari falls back to `video/mp4;h264`. Everything is
   transcoded/remuxed to MP4 on export via ffmpeg. This is the reliable
   path — no weird native container hacks inside Electron.
3. **Output canvas sizes** — portrait 1080×1920 (default), landscape
   1920×1080, square 1080×1080. Picker lives in the editor's project
   settings; default is portrait.
4. **Audio** — every input device's mic is captured to its own track
   (laptop mic, mobile mic; plus the screen's system audio if the user
   opts into "share audio"). In the editor each scene picks exactly one
   audio source — so mixing is just a clip-level choice, no gain sliders
   in v1.
5. **Live mobile preview** — included, monitoring-only, low-bitrate WebRTC
   stream in parallel with the full-quality local recording. Details in §3.5.
6. **Scene cutting** — manual-only in v1. Auto-silence deferred.
7. **Packaging** — unsigned `.dmg` for v1. macOS Gatekeeper will block the
   first launch; the install readme tells the user to right-click → Open
   → confirm (one-time). We wire up the electron-builder config so adding
   code signing later is a flag change, not a rewrite.

## 8. Ready to start milestone 1?

Next step on approval: scaffold the Electron + Vite + React + Tailwind +
shadcn project with an empty Home screen, get `npm run dev` and
`npm run build` working, produce an unsigned `.dmg` that launches on your
Mac. No recording logic yet — just the shell we build everything else on.
