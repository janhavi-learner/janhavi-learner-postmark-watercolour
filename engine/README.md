# Watercolor engine

WebGL2 watercolor painting on a canvas you provide. Copy this folder into the app unchanged.

```js
import { createEngine } from './engine/src/engine.js';

const engine = await createEngine(canvas, { tune: false, onError: (msg) => console.error(msg) });
engine.setBrush({ color: '#5f7d9c', water: 0.3, size: 32, wet: false, taper: 1.5 });
```

## Requirements

- Built with Vite: shaders are imported with `?raw` and the paper scan as `../paper.jpg`.
- `tweakpane` must be installed in the app, but it is only downloaded when `tune: true`
  (dynamic `import()`), so it is not part of the first load.
- WebGL2 with float render targets (`EXT_color_buffer_float`). `createEngine` rejects if missing.

## API

| Call | What it does |
| --- | --- |
| `createEngine(canvas, { tune, onError })` | Starts painting on `canvas`. Waits until the canvas has a CSS size. `tune: true` adds the Tweakpane panel. `onError(message)` receives shader/GPU errors (default: console). |
| `engine.resize()` | Re-reads the canvas's CSS size after the app changes it. |
| `engine.setBrush({ color, water, size, wet, taper, offsetPx, offsetRampPx, smoothing })` | Any subset. Applies from the next stroke. |
| `engine.setView({ scale, x, y })` | Zoom 1–5; `x, y` = the painting point (0..1, y down) at the centre of the canvas. Kept inside the painting. Drawn at full screen sharpness; touches map through it. `engine.getView()` returns the current view. |
| `engine.undo()`, `engine.redo()` | One stroke or one Clear per step; up to 20 steps (see memory below). Ignored mid-stroke. |
| `engine.clear()` | Clears the painting. Counts as one undo step. |
| `engine.cancelStroke()` | Removes the stroke in progress completely (no paint, no undo step; redo is kept). Its finger is ignored until it lifts. |
| `engine.setInputEnabled(bool)` | `false`: no new stroke can start (e.g. during a pinch). |
| `engine.onPointer(({ x, y, down }) => …)` | Where paint is landing, in client coordinates: on every move while painting, and once on lift/cancel (`down: false`). Returns an unsubscribe function. |
| `engine.drawPreview(ctx2d)` | Draws the whole painting, unzoomed, into a 2D canvas at that canvas's pixel size. |
| `engine.onHistoryChange(({ canUndo, canRedo }) => …)` | Called right away with the current state, then on every change. Returns an unsubscribe function. |
| `await engine.finishDrying({ durationMs = 1500 })` | Dries all wet paint in about `durationMs` (rims darken, granulation settles) and resolves when nothing is wet. No new stroke can start meanwhile. |
| `engine.onChange(() => …)` | Called after a stroke ends, and after undo, redo, clear and `finishDrying`. Returns an unsubscribe function. |
| `await engine.save()` | The painting as a `Blob`: dried and wet paint, and how far each wet part has dried. |
| `await engine.load(data)` | Restores a save (`Blob` or `ArrayBuffer`) into an engine with the same canvas shape; drying carries on. Undo history starts empty. Rejects with a readable error, leaving the painting untouched, if the data is from another format version, another canvas shape, or damaged. |

### Export

Draw the finished painting at the stored resolution with `drawPreview` on a 1200 × 1500 2D canvas
(after `finishDrying`, since wet paint is shown slightly darker). It uses the same drawing as the
screen, unzoomed, with the paper at full resolution.

### Brush

- `color`: hex. Near-white colours (every channel ≥ 235) paint as opaque white; all others are transparent glazes.
- `water` (0..1): dry → soaking wet. Wetter paint is paler, stays wet longer, bleeds further into dry paper
  and gets softer edges. Near 0 the edge stays crisp.
- `size`: diameter in CSS pixels **on screen**. Zoomed in with `setView`, the same size paints a finer
  line on the paper (at scale 4 a 6px brush is 1.5px on the unzoomed stamp).
- `wet`: `true` = water brush. It only blends: colours and values under it mix softly with their
  neighbours (dried with dried, wet with wet), reaching about a quarter of the brush's width. It adds
  no water or pigment and changes no wetness, so it leaves no new edges, rims or blooms.
- `taper`: length of the thin start/end, in brush widths (0 = none).
- `offsetPx`: paint lands this many on-screen pixels above the finger (0 = under the finger).
- `offsetRampPx`: the offset starts at 0 and grows smoothly to `offsetPx` over this much finger movement.
- `smoothing` (0..1): smooths the stroke path. 0 = off.

## Resolution and memory

- The painting is stored at 1200 px wide (1200 × 1500 for a 4:5 stamp), whatever the screen.
  Blending, bleeding and rim widths are scaled so they look the same in CSS pixels at any size.
- The wet simulation only runs inside the rectangle that may still be wet.
- GPU memory: about 120 MB of working layers (seven 1200 × 1500 half-float layers plus the rim-blur mask).
- Undo saves 64 × 64 px tiles, only where a step changes the painting (a stroke plus one tile around it),
  and only tiles that hold paint. A medium stroke costs about 3–6 MB. The undo store is capped at 128 MB:
  beyond it the oldest steps are forgotten, so a run of very large washes can keep fewer than 20 steps.
- Undo removes a step's changes in the tiles it touched. Paint elsewhere keeps drying; where restored
  paint and its neighbours are both wet, the restored paint keeps today's water level so they dry together.

## Save format

- Version 1: `'PMWC'`, the format version, a compression flag, then the gzip-compressed body.
- Only tiles with paint are stored, as the exact half-float values on the GPU (lossless: saving,
  loading and saving again gives identical data), delta-filtered so smooth paint compresses well.
- Wet tiles also store their wetness and how long ago they were wetted, so drying continues.
- A checksum and size checks catch damaged data.
- Measured: one medium stroke ≈ 220–260 KB; three strokes ≈ 600–690 KB. A fully painted stamp is
  expected around 1–2 MB (more while much of it is still wet).
- Reading the paint back happens in the background and the packing runs in a worker, so a save
  doesn't hold up painting.

## Notes

- The canvas's shape when the engine starts is the painting's shape; later resizes should keep it.
- The engine sets `touch-action: none` on the canvas and listens for pointer events on it (one finger paints).
- `onError` is shared by all engines on the page (the last one set wins).
