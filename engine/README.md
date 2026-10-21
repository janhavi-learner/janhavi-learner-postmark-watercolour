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
| `engine.setBrush({ color, water, size, wet, taper })` | Any subset. Applies from the next stroke. |
| `engine.undo()`, `engine.redo()` | One stroke or one Clear per step; 20 steps kept. Ignored mid-stroke. |
| `engine.clear()` | Clears the painting. Counts as one undo step. |
| `engine.onHistoryChange(({ canUndo, canRedo }) => …)` | Called right away with the current state, then on every change. Returns an unsubscribe function. |

### Brush

- `color`: hex. Near-white colours (every channel ≥ 235) paint as opaque white; all others are transparent glazes.
- `water` (0..1): dry → soaking wet. Wetter paint is paler, stays wet longer, bleeds further into dry paper
  and gets softer edges. Near 0 the edge stays crisp.
- `size`: diameter in CSS pixels **on screen**. Measured against the canvas's on-screen box, so if the app
  zooms the canvas with a CSS transform, the same size paints a finer line on the paper.
- `wet`: `true` = water brush (clear water that re-wets dried paint and softens edges).
- `taper`: length of the thin start/end, in brush widths (0 = none).

## Notes

- The canvas's shape when the engine starts is the painting's shape; later resizes should keep it.
- The engine sets `touch-action: none` on the canvas and listens for pointer events on it (one finger paints).
- `onError` is shared by all engines on the page (the last one set wins).
