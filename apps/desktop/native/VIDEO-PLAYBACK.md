# macOS video playback

The Lightbox uses an in-process Node-API addon, `video-player.mm`, on macOS.
AVPlayer reads the original file and AVPlayerLayer draws it inside the
BrowserWindow. React owns playback controls; native decoded frames never
cross IPC and no playback proxy is generated on this path. This supports
ProRes originals that Chromium otherwise plays with audio and no picture.

`npm run build:native` builds `native/bin/video-player.node`. The addon uses
system AppKit/AVFoundation/QuartzCore, targets macOS 12, and uses stable
Node-API headers from the development dependency `node-api-headers`. The
existing Mac packaging includes it for each build's architecture.

`electron/ipc/nativeVideo.js` validates paths through the media allowlist,
owns one session per webContents, and rejects requests from subframes.
Session tokens isolate late replies and cleanup when users change clips.
Navigation, window destruction and app shutdown stop playback and detach
the layer. `useNativeVideo` also closes its session when the Lightbox closes.

Renderer bounds are CSS pixels. Main multiplies them by the webContents
zoom factor to obtain Cocoa points; Retina devicePixelRatio isn't involved.
The native view ignores hit testing, so clicks reach the React surface.
Arrow gutters preserve DOM navigation alongside the native layer. Anything
marked as a top layer (`src/utils/topLayer.js`: Settings, the confirm that
Delete opens, Add Tags) hides the layer while it is open, since the layer
sits above the whole page. During a live resize the view keeps its margins
to the window's edges, then takes the page's bounds.

On macOS the fullscreen control, for either engine, uses the shell's simple
fullscreen, since DOM fullscreen is unreliable with a transparent
BrowserWindow. Stepping to another clip stays fullscreen; leaving the
Lightbox restores the previous window mode.

Native player failures fall back to the existing HTML player and
compatibility proxy; Windows/Linux/web retain that path. A first frame is
waited for 15 seconds of the picture being visible before falling back.

## Verification

Run `npm run test:unit`, `npm run lint`, `npm run build` and
`npx playwright test e2e/14-video.spec.js` after compiling native helpers.
The playback test checks that AVPlayer really opened (no quiet fallback),
original dimensions, time advancing, pause, seeking and completion on macOS.

To exercise a local 4K ProRes clip in a disposable catalog:

```sh
AFTERFRAME_TEST_PRORES='/absolute/path/to/clip.MOV' \
  npx playwright test e2e/70-native-video.spec.js
```

Use `AFTERFRAME_PYTHON` to point to the project's Python environment when
needed. The optional test imports only into its isolated test catalog and
checks original resolution, absence of proxies, controls, Settings and the
Delete confirm over the picture, its placement after a resize, fullscreen
(kept across a clip change, restored on close), switching to a photo,
reopening and cleanup. It does not modify the source file or the user's
catalog.

On the supplied 8.935-second 4K ProRes 422 HQ clip, local tests confirmed
3840×2160 native playback and first display readiness about 0.42–0.56 seconds
after opening. These are local measurements, not a guaranteed startup time
for other disks, clips or Macs.
