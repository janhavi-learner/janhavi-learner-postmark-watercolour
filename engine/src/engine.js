// The watercolor engine. Paints on a canvas you give it; the page around it is yours.
//
//   const engine = await createEngine(canvas, { tune: false, onError });
//   engine.setBrush({ color: '#5f7d9c', water: 0.3, size: 32, wet: false, taper: 1.5 });
//   engine.setView({ scale: 2, x: 0.5, y: 0.5 });  // zoom and pan
//   engine.undo(); engine.redo(); engine.clear();
//   engine.onHistoryChange(({ canUndo, canRedo }) => { ... });
//   engine.resize(); // after the app changes the canvas's CSS size
//
// The app sizes the canvas with CSS. The canvas's shape when the engine starts is the shape
// of the painting (Postmark's stamp is 4:5); later resizes should keep that shape.
import {
  createContext, createProgram, loadImage, createImageTexture, drawFullscreen,
  requireFloatTargets, createTarget, createMultiTarget, createMipTarget, createByteTarget,
  clearTarget, copyRect,
} from './gl.js';
import { setErrorHandler } from './errors.js';
import { createBrushInput } from './brush.js';
import { preparePaper } from './paper.js';
import SaveWorker from './save-worker.js?worker&inline';
import paperUrl from '../paper.jpg';
import fullscreenVert from './shaders/fullscreen.vert?raw';
import compositeFrag from './shaders/composite.frag?raw';
import stampVert from './shaders/stamp.vert?raw';
import stampFrag from './shaders/stamp.frag?raw';
import addFrag from './shaders/add.frag?raw';
import blurFrag from './shaders/blur.frag?raw';
import maskFrag from './shaders/mask.frag?raw';
import mergeFrag from './shaders/merge.frag?raw';
import coverFrag from './shaders/cover.frag?raw';
import liftFrag from './shaders/lift.frag?raw';
import blendFrag from './shaders/blend.frag?raw';
import restoreFrag from './shaders/restore.frag?raw';
import wetFrag from './shaders/wet.frag?raw';
import noiseGlsl from './shaders/noise.glsl?raw';

// Shaders that need the shared noise helpers mark the spot with "// #include noise".
const withNoise = (src) => src.replace('// #include noise', noiseGlsl);

// The painting is stored at this width (1200 × 1500 for a 4:5 stamp), whatever the screen:
// sharp at 4× zoom and big enough to export. Fixed, so the painting looks the same on any phone.
const PAINT_W = 1200;
// The look was tuned at 1.5 paint pixels per CSS pixel; distances in the wet simulation are
// scaled from that, so blending, bleeding and rims keep the same size on screen.
const TUNED_DENSITY = 1.5;

// Undo/redo keeps this many steps (each stroke and each Clear is one step).
const HISTORY_STEPS = 20;
// Undo saves the painting in square tiles, only where a step changes it.
const TILE = 64;
// Tiles saved around a stroke, so paint that blends or bleeds a little past it is undone too.
const MARGIN_TILES = 1;
// Undo store: pages of 16 × 16 tiles (8 MB each). Above this many pages, the oldest steps go.
const STORE_PAGE = 1024;
const STORE_BUDGET_PAGES = 16; // 128 MB

// finishDrying runs the wet simulation in long steps, at most this many per frame. While paint is
// still fresh (it bleeds outward in its first seconds) the steps are shorter, so the bleed
// matches natural drying.
const FAST_STEP = 1 / 10;
const FAST_STEP_FRESH = 1 / 30;
const FRESH_SECONDS = 6;
const FAST_STEPS_PER_FRAME = 6;

// Water brush: blends paint across about this share of the brush's width (radius of the blend
// relative to the brush radius).
const BLEND_REACH = 0.5;
// Wet paper looks slightly darker than dry; this is how much (also shows where clear water is).
const WET_DARKEN = 0.06;
// After a pixel dries it stays "damp" for this fraction of the drying time.
// Neighbours drying within that window join the same rim instead of drawing a line between them.
const DAMP_SHARE = 0.4;

// The brush, as the app sets it with setBrush(). Changes apply from the next stroke.
const BRUSH_DEFAULTS = {
  color: '#5f7d9c', // pigment colour; white is painted as opaque body colour
  water: 0.3,       // 0 = dry brush (crisp, strong) .. 1 = soaking wet (pale, spreads, soft edges, dries slowly)
  size: 32,         // diameter in on-screen CSS pixels
  wet: false,       // true = water brush: clear water that re-wets and softens paint
  taper: 1.5,       // length of the thin start/end, in brush widths
  offsetPx: 0,      // paint lands this far above the finger (on-screen px)
  offsetRampPx: 40, // ...reached smoothly over this much finger movement, starting from 0
  smoothing: 0,     // 0 = off .. 1 = strongly smoothed stroke path
};

// Look-and-feel numbers, the same for every brush. Shown as sliders with { tune: true }.
const TUNING_DEFAULTS = {
  pressure: 0.07,      // how much faster strokes get thinner (0 = no effect)
  darkPace: 4,         // how fast deep glazes head toward black; they never reach it
  unevenness: 0.32,    // how blotchy a flat wash is (new strokes)
  granulation: 0.49,   // how strongly pigment settles into paper dips and clumps as it dries
  dryingTime: 24,      // seconds a stroke stays wet (at the default water amount)
  spread: 0.65,        // how fast colours blend inside wet paint and bleed into dry paper
  edgeStrength: 2.3,   // how much darker the drying rim is
  edgeWidth: 20,       // how far the rim reaches into the puddle, CSS px
  grainSize: 0.37,     // 1 = one copy of the paper scan across the canvas, smaller = finer grain
  grainContrast: 0.6,  // paper grain depth
};

// Color picker hex -> how much light one stroke absorbs per channel.
// The picked color is the rich, fully loaded pigment. Water dilutes each stroke:
// water 0 = one full-strength stroke; water 1 = about seven times more dilute.
// Glazes simply add, so there is no ceiling.
function hexToAbsorbance(hex, water) {
  const n = parseInt(hex.slice(1, 7), 16);
  const load = Math.pow(0.15, water);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => -Math.log(Math.max(Math.pow(v / 255, 2.2), 0.005)) * load);
}

// White (every channel at least this bright) is painted as opaque body colour, like Chinese white:
// it covers the paint under it instead of glazing over it. All other colours stay transparent.
const WHITE_FROM = 235;
function isWhite(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].every((v) => v >= WHITE_FROM);
}

// A stroke's look is locked in when it starts, so changing the brush mid-stroke
// (or right after lifting) never changes a stroke that's already down.
// `rect` is the canvas on screen; `scale` the zoom, so the brush keeps its on-screen size.
function strokeStyle(brush, tuning, rect, scale) {
  const white = !brush.wet && isWhite(brush.color);
  const radiusPx = brush.size / 2;
  return {
    absorbance: brush.wet || white ? [0, 0, 0] : hexToAbsorbance(brush.color, brush.water),
    blend: brush.wet, // the water brush only blends: it adds no water and no pigment
    // Share of the paint underneath one white stroke hides; more water = thinner white.
    cover: white ? 0.9 - 0.6 * brush.water : 0,
    radiusPx,
    taperPx: brush.taper * brush.size,
    offsetPx: brush.offsetPx,
    offsetRampPx: brush.offsetRampPx,
    smoothing: Math.min(Math.max(brush.smoothing, 0), 1),
    radiusX: radiusPx / Math.max(rect.width * scale, 1), // in 0..1 of the painting's width
    waterLevel: (0.5 + brush.water) / 0.8, // more water = stays wet longer; 1.0 at the default
    unevenness: tuning.unevenness,
    seed: [Math.random() * 100, Math.random() * 100], // each stroke gets its own blotches
  };
}

// Some hosts (e.g. an embedded panel that is still opening) start with no size at all.
// Paint layers need a real size, so wait until the canvas has one.
function waitForSize(canvas) {
  return new Promise((done) => {
    const check = () => {
      if (canvas.clientWidth >= 1 && canvas.clientHeight >= 1) done();
      else requestAnimationFrame(check);
    };
    check();
  });
}

export async function createEngine(canvas, { tune = false, onError } = {}) {
  if (onError) setErrorHandler(onError);
  const gl = createContext(canvas);
  if (!gl || !requireFloatTargets(gl)) throw new Error('This browser cannot run the watercolor engine (WebGL2 with float render targets).');
  const programs = {
    composite: createProgram(gl, fullscreenVert, withNoise(compositeFrag), 'composite'),
    stamp: createProgram(gl, stampVert, withNoise(stampFrag), 'stamp'),
    add: createProgram(gl, fullscreenVert, addFrag, 'add'),
    blur: createProgram(gl, fullscreenVert, blurFrag, 'blur'),
    mask: createProgram(gl, fullscreenVert, maskFrag, 'mask'),
    merge: createProgram(gl, fullscreenVert, mergeFrag, 'merge'),
    cover: createProgram(gl, fullscreenVert, coverFrag, 'cover'),
    lift: createProgram(gl, fullscreenVert, liftFrag, 'lift'),
    blend: createProgram(gl, fullscreenVert, blendFrag, 'blend'),
    restore: createProgram(gl, fullscreenVert, restoreFrag, 'restore'),
    wet: createProgram(gl, fullscreenVert, withNoise(wetFrag), 'wet'),
  };
  if (Object.values(programs).some((p) => !p)) throw new Error('A watercolor shader failed to compile (details were reported to onError).');

  const brush = { ...BRUSH_DEFAULTS };
  const tuning = { ...TUNING_DEFAULTS };
  // Zoom: scale 1..5, and the painting point (0..1, y down) at the centre of the canvas.
  const view = { scale: 1, x: 0.5, y: 0.5 };

  // The engine paints with one finger; the canvas must not scroll or zoom the page.
  canvas.style.touchAction = 'none';

  // Render at device pixel ratio; the app decides the CSS size.
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }
  await waitForSize(canvas);
  resize();
  const layoutW = canvas.clientWidth;           // CSS width when the engine started
  const aspect = layoutW / canvas.clientHeight; // width / height of the painting

  const paperImage = await loadImage(paperUrl);
  const paper = preparePaper(paperImage);
  const paperTex = createImageTexture(gl, paper.pixels);
  const paperMean = paper.mean;
  const paperStd = paper.lumStd;
  const paperAspect = paperImage.width / paperImage.height; // width / height
  const paperMeanLum = 0.299 * paperMean[0] + 0.587 * paperMean[1] + 0.114 * paperMean[2];
  // How many times the scan repeats across / down the painting, without stretching it.
  const paperRepeat = () => [1 / tuning.grainSize, paperAspect / aspect / tuning.grainSize];

  // Paint layers are addressed in 0..1 coordinates, so resizing never wipes or distorts them.
  const W = PAINT_W;
  const H = Math.round(W / aspect);
  const paintPerCss = W / layoutW;              // paint pixels per CSS pixel of the unzoomed canvas
  const simScale = paintPerCss / TUNED_DENSITY; // wet-simulation distances, relative to the tuned look
  // The stroke being painted, in three parts:
  const settled = createTarget(gl, W, H); // dabs that won't change shape any more
  const merged = createTarget(gl, W, H);  // the part of `settled` already added to the wet paint
  const tail = createTarget(gl, W, H);    // the last stretch near the finger, redrawn every frame
  const dry = createTarget(gl, W, H);     // paint that has dried
  // Scratch: pigment that dried this step (on its way to `dry`), or that the water brush
  // or white takes out of `dry`.
  const transfer = createTarget(gl, W, H);
  // Wet paint, ping-pong: each step reads one and writes the other, then they swap.
  let wetRead = createTarget(gl, W, H);
  let wetWrite = createTarget(gl, W, H);
  // The wet step writes the next wet state and the dried pigment at once.
  const wetStepFbo = new Map([
    [wetRead, createMultiTarget(gl, [wetWrite.tex, transfer.tex])],
    [wetWrite, createMultiTarget(gl, [wetRead.tex, transfer.tex])],
  ]);
  const swapWet = () => { [wetRead, wetWrite] = [wetWrite, wetRead]; };
  // The wet area, mipmapped, for the rim blur.
  const mask = createMipTarget(gl, W, H);
  let puddle = null; // { level, a, b }: blurred wet area, at a resolution that suits the rim width

  // --- Where the paint is. The painting is cut into tiles; JS keeps track of which tiles
  // hold paint and which may still be wet, so the wet simulation and undo only touch those.
  const tilesX = Math.ceil(W / TILE);
  const tilesY = Math.ceil(H / TILE);
  const wetSince = new Float64Array(tilesX * tilesY).fill(-Infinity); // sim time each tile was last wetted
  const wetLevel = new Float32Array(tilesX * tilesY);                  // most water put on it since (stroke water level)
  const painted = new Uint8Array(tilesX * tilesY);                     // 1 once a tile has any paint
  let simClock = 0;
  // Water evaporates at 0.8 / dryingTime per second, so `level` water takes level / 0.8 drying times.
  const evaporateTime = (level) => (level / 0.8) * tuning.dryingTime;
  // How long after its last wetting a tile can still be wet or damp (its water, the damp phase,
  // and a safety margin). Uses the current slider, so changing the drying time mid-way never
  // freezes paint half-wet.
  const wetDuration = (i) => evaporateTime(wetLevel[i]) * 1.2 + DAMP_SHARE * tuning.dryingTime + 1;
  const tileWet = (i) => simClock - wetSince[i] < wetDuration(i);
  // Wets tile i now with `level` water (keeps the most water it has had while wet).
  function wetTile(i, level) {
    wetLevel[i] = tileWet(i) ? Math.max(wetLevel[i], level) : level;
    wetSince[i] = simClock;
  }
  // The wettest stroke's water level, for tiles whose own level isn't known (undo, load).
  const MAX_LEVEL = (0.5 + 1) / 0.8;
  const tileRect = (i) => {
    const x = (i % tilesX) * TILE;
    const y = Math.floor(i / tilesX) * TILE;
    return { x, y, w: Math.min(TILE, W - x), h: Math.min(TILE, H - y) };
  };
  // Tile indices covering a pixel rectangle, grown by `margin` tiles.
  function tilesIn(r, margin) {
    const out = [];
    const x0 = Math.max(0, Math.floor(r.x0 / TILE) - margin);
    const y0 = Math.max(0, Math.floor(r.y0 / TILE) - margin);
    const x1 = Math.min(tilesX - 1, Math.floor(r.x1 / TILE) + margin);
    const y1 = Math.min(tilesY - 1, Math.floor(r.y1 / TILE) + margin);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push(ty * tilesX + tx);
    return out;
  }
  // The rectangle (paint px) around every tile that may be wet, or null.
  function wetBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < wetSince.length; i++) {
      if (!tileWet(i)) continue;
      const tx = i % tilesX;
      const ty = Math.floor(i / tilesX);
      x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
    }
    if (x1 < 0) return null;
    const x = x0 * TILE;
    const y = y0 * TILE;
    return { x, y, w: Math.min((x1 + 1) * TILE, W) - x, h: Math.min((y1 + 1) * TILE, H) - y };
  }
  let wasWet = false;

  // --- Undo / redo. Before a step changes a tile for the first time, the tile (dried and wet
  // paint) is copied into the undo store. Undoing puts those tiles back.
  const pages = [];
  const freeSlots = [];
  const undoStack = [];
  const redoStack = [];
  let pendingRedo = []; // redo steps put aside while a stroke is going (a cancel brings them back)
  let activeStep = null; // the step of the stroke being painted
  const historyListeners = new Set();
  const historyState = () => ({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  const notifyHistory = () => historyListeners.forEach((cb) => cb(historyState()));
  // onChange listeners hear about strokes, undo, redo, clear and finished drying, at the end of
  // the frame they happen in (so a save() they start sees the finished change).
  const changeListeners = new Set();
  let changed = false;

  function allocSlot() {
    for (;;) {
      if (freeSlots.length) return freeSlots.pop();
      if (pages.length < STORE_BUDGET_PAGES || !dropOldestStep()) {
        const page = createTarget(gl, STORE_PAGE, STORE_PAGE);
        pages.push(page);
        for (let y = 0; y < STORE_PAGE; y += TILE) for (let x = 0; x < STORE_PAGE; x += TILE) freeSlots.push({ page, x, y });
      }
    }
  }
  // Over budget: forget the oldest history (never the step being painted).
  function dropOldestStep() {
    if (pendingRedo.length) { releaseStep(pendingRedo.shift()); return true; }
    if (undoStack.length && undoStack[0] !== activeStep) { releaseStep(undoStack.shift()); notifyHistory(); return true; }
    if (redoStack.length) { releaseStep(redoStack.shift()); notifyHistory(); return true; }
    return false;
  }
  function releaseStep(step) {
    for (const t of step.tiles.values()) {
      if (t.dry) freeSlots.push(t.dry);
      if (t.wet) freeSlots.push(t.wet);
    }
    step.tiles.clear();
  }
  function saveTile(layer, i) {
    const slot = allocSlot();
    const r = tileRect(i);
    copyRect(gl, layer.fbo, r.x, r.y, slot.page.fbo, slot.x, slot.y, r.w, r.h);
    return slot;
  }
  // The tile as it is now (dry tiles with no paint and tiles that aren't wet need no copy).
  const captureTile = (i) => ({ dry: painted[i] ? saveTile(dry, i) : null, wet: tileWet(i) ? saveTile(wetRead, i) : null });
  // Make sure `step` can put these tiles back as they are right now.
  function touch(step, tiles) {
    for (const i of tiles) if (!step.tiles.has(i)) step.tiles.set(i, captureTile(i));
  }
  const newStep = () => ({ tiles: new Map() });
  // A step that would put the same tiles back as they are now (for redo).
  function captureLike(step) {
    const now = newStep();
    for (const i of step.tiles.keys()) now.tiles.set(i, captureTile(i));
    return now;
  }
  const scratch = createTarget(gl, TILE, TILE);
  function restoreStep(step) {
    for (const [i, t] of step.tiles) {
      const r = tileRect(i);
      if (t.dry) copyRect(gl, t.dry.page.fbo, t.dry.x, t.dry.y, dry.fbo, r.x, r.y, r.w, r.h);
      else clearRect(dry, r);
      // Wet tile: through the restore shader, so restored paint dries in step with its neighbours.
      copyRect(gl, wetRead.fbo, r.x, r.y, scratch.fbo, 0, 0, r.w, r.h);
      const { program, uniforms: u } = programs.restore;
      gl.bindFramebuffer(gl.FRAMEBUFFER, wetRead.fbo);
      gl.viewport(r.x, r.y, r.w, r.h);
      gl.useProgram(program);
      bindTextures(u, { u_snap: (t.wet || t.dry || { page: scratch }).page.tex, u_cur: scratch.tex });
      gl.uniform2i(u.u_tileOrigin, r.x, r.y);
      gl.uniform2i(u.u_snapOrigin, t.wet ? t.wet.x : 0, t.wet ? t.wet.y : 0);
      gl.uniform1f(u.u_hasSnap, t.wet ? 1 : 0);
      gl.bindVertexArray(emptyVao);
      drawFullscreen(gl);
      if (t.wet) wetTile(i, MAX_LEVEL);
      if (t.dry || t.wet) painted[i] = 1;
    }
  }
  function clearRect(target, r) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, r.y, r.w, r.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }
  // A new step goes on the undo stack (oldest steps beyond the limit are forgotten).
  function pushStep(step) {
    undoStack.push(step);
    while (undoStack.length > HISTORY_STEPS) releaseStep(undoStack.shift());
  }
  function stepBack(from, to) {
    if (!from.length || brushInput.painting) return;
    const step = from.pop();
    to.push(captureLike(step));
    restoreStep(step);
    releaseStep(step);
    notifyHistory();
    changed = true;
  }
  // Clear is one undo step.
  function clear() {
    if (brushInput.painting) return;
    const step = newStep();
    pushStep(step);
    redoStack.splice(0).forEach(releaseStep);
    const all = [];
    for (let i = 0; i < wetSince.length; i++) if (painted[i] || tileWet(i)) all.push(i);
    touch(step, all);
    for (const t of [settled, merged, tail, dry, wetRead, wetWrite]) clearTarget(gl, t);
    painted.fill(0);
    wetSince.fill(-Infinity);
    notifyHistory();
    changed = true;
  }

  const emptyVao = gl.createVertexArray();
  const stampVao = gl.createVertexArray();
  const stampBuffer = gl.createBuffer();
  gl.bindVertexArray(stampVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, stampBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); // x, y, size
  gl.vertexAttribDivisor(0, 1);

  function bindTextures(u, textures) {
    Object.entries(textures).forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u[name], i);
    });
  }

  // Limit drawing to a rectangle of paint pixels.
  function scissorTo(r) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, r.y, r.w, r.h);
  }

  // The view the touch points go through: a point on the canvas (0..1, y down) -> painting (y up).
  function toPaint(sx, sy) {
    const u = view.x + (sx - 0.5) / view.scale;
    const yDown = view.y + (sy - 0.5) / view.scale;
    return [u, 1 - yDown];
  }

  const pointerListeners = new Set();
  const brushInput = createBrushInput(canvas, {
    getPressureEffect: () => tuning.pressure,
    getStyle: (rect) => strokeStyle(brush, tuning, rect, view.scale),
    toPaint,
    onPointer: (p) => pointerListeners.forEach((cb) => cb(p)),
  });

  // Draw a batch of dabs into one of the stroke layers. MAX blending keeps one stroke an even wash.
  function drawStamps(target, dabs, style) {
    if (!dabs.length) return;
    const { program, uniforms: u } = programs.stamp;
    const radiusX = style.radiusX;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(program);
    gl.uniform2f(u.u_radius, radiusX, radiusX * aspect);
    gl.uniform1f(u.u_radiusPx, radiusX * W);
    gl.uniform1f(u.u_edgePx, 1.5);
    gl.uniform3fv(u.u_absorbance, style.absorbance);
    gl.uniform1f(u.u_softDab, style.blend ? 1 : 0);
    gl.uniform1f(u.u_unevenness, style.unevenness);
    gl.uniform2f(u.u_seed, style.seed[0], style.seed[1]);
    // Blotches about a tenth of the painting across, kept round whatever its shape.
    gl.uniform2f(u.u_blotchScale, 10, 10 / aspect);
    gl.bindVertexArray(stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, stampBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dabs), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dabs.length / 3);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  // The paint-pixel rectangle covered by a batch of dabs (grown into `into`).
  function growByDabs(into, dabs, style) {
    const r = into || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const reach = style.radiusX * W + 3;
    for (let i = 0; i < dabs.length; i += 3) {
      const x = dabs[i] * W;
      const y = dabs[i + 1] * H;
      const s = reach * dabs[i + 2];
      r.x0 = Math.min(r.x0, x - s); r.y0 = Math.min(r.y0, y - s);
      r.x1 = Math.max(r.x1, x + s); r.y1 = Math.max(r.y1, y + s);
    }
    return r;
  }

  // Add what's newly settled in the stroke to the wet layer (and any wet puddle it touches).
  // Runs every frame while painting, only over the area under the brush, so blending starts
  // right behind the brush.
  function mergeSettled(style, area) {
    if (style.blend) return blendSettled(style, area);
    const tiles = tilesIn(area, MARGIN_TILES);
    if (activeStep) touch(activeStep, tiles); // save these tiles for undo before changing them
    for (const i of tiles) {
      wetTile(i, style.waterLevel);
      painted[i] = 1;
    }
    const r = { x: Math.max(0, Math.floor(area.x0)), y: Math.max(0, Math.floor(area.y0)) };
    r.w = Math.min(W, Math.ceil(area.x1) + 1) - r.x;
    r.h = Math.min(H, Math.ceil(area.y1) + 1) - r.y;
    if (r.w <= 0 || r.h <= 0) return;
    gl.viewport(0, 0, W, H);
    gl.bindVertexArray(emptyVao);
    scissorTo(r);
    const takesFromDry = style.cover > 0;

    // White: what it hides in the dry layer here.
    if (takesFromDry) {
      const { program, uniforms: u } = programs.lift;
      gl.bindFramebuffer(gl.FRAMEBUFFER, transfer.fbo);
      gl.useProgram(program);
      bindTextures(u, { u_settled: settled.tex, u_merged: merged.tex, u_dry: dry.tex });
      gl.uniform1f(u.u_share, style.cover);
      drawFullscreen(gl);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, wetRead.fbo);
    gl.enable(gl.BLEND);
    // White hides part of the wet paint under it (wet rgb multiplied, water untouched).
    if (style.cover > 0) {
      const { program, uniforms: u } = programs.cover;
      gl.useProgram(program);
      bindTextures(u, { u_settled: settled.tex, u_merged: merged.tex });
      gl.uniform1f(u.u_cover, style.cover);
      gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
      drawFullscreen(gl);
    }
    // New pigment and water: pigment adds, water level is topped up (max).
    const { program, uniforms: u } = programs.merge;
    gl.useProgram(program);
    bindTextures(u, { u_settled: settled.tex, u_merged: merged.tex });
    gl.uniform1f(u.u_waterLevel, style.waterLevel);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    drawFullscreen(gl);
    gl.blendEquation(gl.FUNC_ADD);
    // ...and the dry layer gives up what white covered (dry minus transfer).
    if (takesFromDry) {
      const add = programs.add;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dry.fbo);
      gl.useProgram(add.program);
      bindTextures(add.uniforms, { u_src: transfer.tex });
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      drawFullscreen(gl);
      gl.blendEquation(gl.FUNC_ADD);
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    copyRect(gl, settled.fbo, r.x, r.y, merged.fbo, r.x, r.y, r.w, r.h);
  }

  // Water brush: blend the paint newly under the brush with its neighbours (dried with dried, wet
  // with wet). Adds no water or pigment and leaves wetness as it was, so no rim or bloom follows.
  function blendSettled(style, area) {
    const reach = style.radiusX * W * BLEND_REACH; // paint px
    const grown = { x0: area.x0 - reach, y0: area.y0 - reach, x1: area.x1 + reach, y1: area.y1 + reach };
    if (activeStep) touch(activeStep, tilesIn(grown, MARGIN_TILES)); // save for undo before changing
    const r = { x: Math.max(0, Math.floor(area.x0)), y: Math.max(0, Math.floor(area.y0)) };
    r.w = Math.min(W, Math.ceil(area.x1) + 1) - r.x;
    r.h = Math.min(H, Math.ceil(area.y1) + 1) - r.y;
    if (r.w <= 0 || r.h <= 0) return;
    const { program, uniforms: u } = programs.blend;
    gl.bindFramebuffer(gl.FRAMEBUFFER, wetStepFbo.get(wetRead)); // writes wetWrite + transfer
    gl.viewport(0, 0, W, H);
    scissorTo(r);
    gl.useProgram(program);
    bindTextures(u, { u_wet: wetRead.tex, u_dry: dry.tex, u_settled: settled.tex, u_merged: merged.tex });
    gl.uniform1f(u.u_radiusPx, Math.max(2, reach));
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
    gl.disable(gl.SCISSOR_TEST);
    copyRect(gl, wetWrite.fbo, r.x, r.y, wetRead.fbo, r.x, r.y, r.w, r.h);
    copyRect(gl, transfer.fbo, r.x, r.y, dry.fbo, r.x, r.y, r.w, r.h);
    copyRect(gl, settled.fbo, r.x, r.y, merged.fbo, r.x, r.y, r.w, r.h);
  }

  // Blur the wet area's shape so drying pixels know how close they are to the puddle edge.
  // The mask is read at a mip level where the blur is ~4 pixels wide: smooth and cheap at any rim width.
  function blurPuddleShape(bounds) {
    const sigma = tuning.edgeWidth * paintPerCss; // paint px
    const level = Math.max(0, Math.min(6, Math.floor(Math.log2(sigma / 4))));
    if (!puddle || puddle.level !== level) {
      const pw = Math.max(1, W >> level);
      const ph = Math.max(1, H >> level);
      puddle = { level, a: createTarget(gl, pw, ph), b: createTarget(gl, pw, ph) };
    }
    // Mask of the wet area (cleared first, so old puddles never linger in the mip levels).
    clearTarget(gl, mask);
    gl.bindFramebuffer(gl.FRAMEBUFFER, mask.fbo);
    gl.viewport(0, 0, W, H);
    scissorTo(bounds);
    const m = programs.mask;
    gl.useProgram(m.program);
    bindTextures(m.uniforms, { u_wet: wetRead.tex });
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    const { program, uniforms: u } = programs.blur;
    const pw = puddle.a.width;
    const ph = puddle.a.height;
    const s = sigma / (1 << level); // sigma at this level
    const margin = Math.ceil(3 * s) + 2;
    const k = 1 / (1 << level);
    const r = { x: Math.max(0, Math.floor(bounds.x * k) - margin), y: Math.max(0, Math.floor(bounds.y * k) - margin) };
    r.w = Math.min(pw, Math.ceil((bounds.x + bounds.w) * k) + margin) - r.x;
    r.h = Math.min(ph, Math.ceil((bounds.y + bounds.h) * k) + margin) - r.y;
    gl.useProgram(program);
    gl.viewport(0, 0, pw, ph);
    scissorTo(r);
    const passes = [[mask, puddle.a, [0.5 * s / pw, 0], level], [puddle.a, puddle.b, [0, 0.5 * s / ph], 0]];
    for (const [src, dst, step, lod] of passes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      bindTextures(u, { u_src: src.tex });
      gl.uniform2f(u.u_step, step[0], step[1]);
      gl.uniform1f(u.u_lod, lod);
      drawFullscreen(gl);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // One step of wet paint: blend, evaporate, and drop dried pigment (with its rim) onto the dry layer.
  // Only runs inside the rectangle that may be wet. finishDrying uses long steps (up to 1/10 s),
  // and `blur: false` reuses the last rim blur to save time.
  let stepCount = 0;
  let lastBounds = null;
  function wetStep(dt, { blur = true, forceDry = false, area = null } = {}) {
    const bounds = area || wetBounds();
    if (!bounds) {
      // Everything should have dried. Any pixel still holding water (e.g. the drying time was
      // shortened mid-way) dries now, with its rim, so no paint is ever lost; then both wet
      // layers are emptied until the next stroke.
      if (wasWet) {
        wetStep(dt, { forceDry: true, area: lastBounds });
        clearTarget(gl, wetRead);
        clearTarget(gl, wetWrite);
        wasWet = false;
      }
      return;
    }
    wasWet = true;
    lastBounds = bounds;
    if (blur || !puddle) blurPuddleShape(bounds);

    const { program, uniforms: u } = programs.wet;
    gl.bindFramebuffer(gl.FRAMEBUFFER, wetStepFbo.get(wetRead));
    gl.viewport(0, 0, W, H);
    scissorTo(bounds);
    gl.useProgram(program);
    bindTextures(u, { u_wet: wetRead.tex, u_puddle: puddle.b.tex, u_paper: paperTex });
    const paperScale = paperRepeat();
    gl.uniform2f(u.u_paperScale, paperScale[0], paperScale[1]);
    gl.uniform1f(u.u_paperMeanLum, paperMeanLum);
    gl.uniform1f(u.u_paperStd, paperStd);
    // Fibres about 1.5 CSS px across.
    gl.uniform2f(u.u_fiberScale, layoutW / 1.5, layoutW / aspect / 1.5);
    // A step longer than a 60Hz frame (slow phones, finishDrying) reaches further, so paint spreads
    // the same amount per second of drying however the time is cut into steps.
    const frames = Math.max(dt * 60, 1);
    // Neighbour distance grows with spread speed; its direction turns by the golden angle each step.
    // Steps cycle through far, middle and nearest neighbours, so all pixels stay linked.
    const far = (1 + 4 * tuning.spread) * simScale * Math.sqrt(frames);
    const reachPx = [far, Math.max(1, far / 3), 1][stepCount % 3];
    const angle = stepCount++ * 2.39996;
    let ox = Math.round(Math.cos(angle) * reachPx);
    let oy = Math.round(Math.sin(angle) * reachPx);
    if (ox === 0 && oy === 0) ox = 1;
    gl.uniform2i(u.u_offset, ox, oy);
    // Flow per step scales with frame time, so 60Hz and 120Hz screens blend at the same speed.
    const perStep = Math.min(dt * 60, 1);
    gl.uniform1f(u.u_pigmentFlow, tuning.spread > 0 ? 0.24 * perStep : 0);
    gl.uniform1f(u.u_waterFlow, 0.24 * perStep);
    // Outward bleeding follows spread speed too (capped so a long step can't push out more water than there is).
    gl.uniform1f(u.u_bleed, 0.5 * tuning.spread * perStep * Math.min(frames, 1.25));
    gl.uniform1f(u.u_evaporate, forceDry ? 100 : (dt * 0.8) / tuning.dryingTime);
    gl.uniform1f(u.u_allDrying, forceDry ? 1 : 0);
    gl.uniform1f(u.u_dampFade, dt / (DAMP_SHARE * tuning.dryingTime));
    gl.uniform1f(u.u_edgeStrength, tuning.edgeStrength);
    gl.uniform1f(u.u_probePx, Math.max(2, Math.round(4 * simScale)));
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
    swapWet();

    // Add this step's dried pigment onto the dry layer.
    const add = programs.add;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dry.fbo);
    gl.useProgram(add.program);
    bindTextures(add.uniforms, { u_src: transfer.tex });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    drawFullscreen(gl);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }

  let tailCover = 0; // the stroke being painted, if white: how much it covers (shown before it settles)
  let tailWet = 1;   // 0 while the water brush is going: it lays no water, so nothing looks wet
  // Draw the painting on paper into `fbo` (null = the canvas), `w` × `h` pixels, through `v`.
  function composite(fbo, w, h, v) {
    const { program, uniforms: u } = programs.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    const paperScale = paperRepeat();
    gl.useProgram(program);
    bindTextures(u, { u_paper: paperTex, u_dry: dry.tex, u_wet: wetRead.tex, u_tail: tail.tex, u_settled: settled.tex });
    gl.uniform3f(u.u_view, v.scale, v.x, 1 - v.y);
    gl.uniform1f(u.u_wetDarken, WET_DARKEN);
    gl.uniform1f(u.u_tailCover, tailCover);
    gl.uniform1f(u.u_tailWet, tailWet);
    gl.uniform2f(u.u_paperScale, paperScale[0], paperScale[1]);
    gl.uniform3fv(u.u_paperMean, paperMean);
    gl.uniform1f(u.u_grainContrast, tuning.grainContrast);
    gl.uniform1f(u.u_darkPace, tuning.darkPace);
    gl.uniform1f(u.u_granulation, tuning.granulation);
    // Pigment clumps about 2 CSS px across (at no zoom).
    gl.uniform2f(u.u_clumpScale, layoutW / 2, layoutW / aspect / 2);
    gl.uniform1f(u.u_paperStd, paperStd);
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
  }

  // Undo everything the cancelled stroke did, as if it never happened.
  function cancelStroke() {
    for (const t of [settled, merged, tail]) clearTarget(gl, t);
    tailCover = 0;
    if (!activeStep) return;
    restoreStep(activeStep);
    releaseStep(activeStep);
    undoStack.splice(undoStack.indexOf(activeStep), 1);
    redoStack.push(...pendingRedo);
    pendingRedo = [];
    activeStep = null;
    notifyHistory();
  }

  const endOfFrame = []; // callbacks for the end of the next frame
  // The whole current stroke's area, so it can be given an even water level when the finger lifts.
  let strokeArea = null;
  let lastTime = 0;
  function frame(ms) {
    const now = ms / 1000;
    const dt = Math.min(lastTime ? now - lastTime : 1 / 60, 1 / 20); // cap so a hiccup doesn't dry paint in one jump
    lastTime = now;

    // Replay this frame's input in order.
    let mergeStyle = null; // set when settled dabs are waiting to join the wet paint
    let mergeArea = null;
    for (const event of brushInput.take()) {
      if (event.start) {
        activeStep = newStep();
        pushStep(activeStep);
        strokeArea = null;
        pendingRedo = redoStack.splice(0); // put aside: a cancelled stroke gives them back
        notifyHistory();
      } else if (event.commit) {
        drawStamps(settled, event.commit, event.style);
        mergeArea = growByDabs(mergeArea, event.commit, event.style);
        strokeArea = growByDabs(strokeArea, event.commit, event.style);
        mergeStyle = event.style;
      } else if (event.end) {
        // The rest of the stroke, with its final end taper, joins the wet paint; the stroke layers empty.
        // The merge covers the whole stroke once more: parts laid down earlier lost a little
        // water while painting, and this tops the whole stroke up to the same level, so it
        // dries as one puddle.
        drawStamps(settled, event.end, event.style);
        strokeArea = growByDabs(strokeArea, event.end, event.style);
        if (strokeArea.x1 >= strokeArea.x0) mergeSettled(event.style, strokeArea);
        strokeArea = null;
        for (const t of [settled, merged, tail]) clearTarget(gl, t);
        pendingRedo.forEach(releaseStep);
        pendingRedo = [];
        activeStep = null;
        mergeStyle = null;
        mergeArea = null;
        tailCover = 0;
        changed = true;
      } else if (event.cancel) {
        cancelStroke();
        strokeArea = null;
        mergeStyle = null;
        mergeArea = null;
      } else if (event.tail) {
        clearTarget(gl, tail);
        drawStamps(tail, event.tail, event.style);
        tailCover = event.style.cover;
        tailWet = event.style.blend ? 0 : 1;
      }
    }
    if (mergeStyle) mergeSettled(mergeStyle, mergeArea);

    if (finishing && !brushInput.painting) {
      fastForward(now);
    } else {
      wetStep(dt);
      simClock += dt;
    }

    composite(null, canvas.width, canvas.height, view);
    if (changed) {
      changed = false;
      changeListeners.forEach((cb) => cb());
    }
    endOfFrame.splice(0).forEach((resolve) => resolve());
    requestAnimationFrame(frame);
  }

  // --- Finish drying: run the drying faster so it ends in about `durationMs`.
  // Steps are longer than a frame but spread paint just as natural drying does (see wetStep).
  let finishing = null; // { resolve, promise, endAt }
  let appInput = true;  // what the app asked for with setInputEnabled
  const applyInput = () => brushInput.setEnabled(appInput && !finishing);
  let lastFast = 0;
  let fastSteps = 0;
  function fastForward(now) {
    // Simulated drying left: until the last wet tile has dried (and finished its damp phase).
    // (The damp phase is left out: nothing visible happens in it once the paint around has dried.)
    let left = 0;
    let youngest = Infinity;
    for (let i = 0; i < wetSince.length; i++) {
      if (!tileWet(i)) continue;
      left = Math.max(left, wetSince[i] + evaporateTime(wetLevel[i]) * 1.05 + 0.25 - simClock);
      youngest = Math.min(youngest, simClock - wetSince[i]);
    }
    if (left > 0) {
      const step = youngest < FRESH_SECONDS ? FAST_STEP_FRESH : FAST_STEP;
      const frameTime = Math.min(lastFast ? now - lastFast : 1 / 60, 0.1);
      const timeLeft = Math.max(finishing.endAt - now, 1 / 60);
      const steps = Math.min(Math.max(Math.ceil((left * Math.min(frameTime / timeLeft, 1)) / step), 1), FAST_STEPS_PER_FRAME);
      for (let k = 0; k < steps; k++) {
        wetStep(step, { blur: (fastSteps++ % 3) === 0 });
        simClock += step;
      }
      lastFast = now;
      return;
    }
    // Estimated dry: one last step dries any pixel still holding water on the spot (with its rim),
    // then the wet layers are emptied.
    wetStep(FAST_STEP, { forceDry: true });
    wetSince.fill(-Infinity);
    wetStep(FAST_STEP);
    const done = finishing;
    finishing = null;
    lastFast = 0;
    applyInput();
    changed = true;
    done.resolve();
  }
  function finishDrying({ durationMs = 1500 } = {}) {
    if (!finishing) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      finishing = { resolve, promise, endAt: performance.now() / 1000 + durationMs / 1000 };
      applyInput();
    }
    return finishing.promise;
  }

  // --- Save and load. Paint layers are read back as half floats (exact), only where there's paint.
  // Reading uses GPU buffers that fill in the background (no waiting on the GPU), and the packing
  // and compression run in a worker, so a save doesn't stall painting.
  let readsHalf = null; // can this GPU read half floats directly? (otherwise floats, converted in the worker)
  // Starts reading a rectangle of a layer; resolves with its pixels (RGBA, rows bottom-up).
  function readLater(target, r) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    if (readsHalf === null) {
      readsHalf = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA
        && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.HALF_FLOAT;
    }
    const count = r.w * r.h * 4;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, count * (readsHalf ? 2 : 4), gl.STREAM_READ);
    gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, readsHalf ? gl.HALF_FLOAT : gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return () => {
      const pixels = readsHalf ? new Uint16Array(count) : new Float32Array(count);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(buffer);
      return pixels;
    };
  }
  // Resolves once the GPU has done everything asked of it so far (checked once per frame).
  function gpuDone() {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve) => {
      const check = () => {
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) return requestAnimationFrame(check);
        gl.deleteSync(sync);
        resolve();
      };
      check();
    });
  }
  // The rectangle around these tiles.
  function tilesRect(indices) {
    const rects = indices.map(tileRect);
    const x = Math.min(...rects.map((t) => t.x));
    const y = Math.min(...rects.map((t) => t.y));
    return { x, y, w: Math.max(...rects.map((t) => t.x + t.w)) - x, h: Math.max(...rects.map((t) => t.y + t.h)) - y };
  }

  const worker = new SaveWorker();
  let jobId = 0;
  const jobs = new Map();
  worker.onmessage = ({ data }) => {
    const job = jobs.get(data.id);
    jobs.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data);
  };
  function runJob(message, transfer) {
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  // Ask once, now: the first query can make the browser wait for the GPU, which a save shouldn't.
  gl.bindFramebuffer(gl.FRAMEBUFFER, dry.fbo);
  readsHalf = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA
    && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.HALF_FLOAT;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Resolves at the end of the next frame, once input that already arrived has been painted in.
  const afterFrame = () => new Promise((resolve) => endOfFrame.push(resolve));

  const layout = { width: W, height: H, tile: TILE };
  async function save() {
    // A stroke that has ended but not been painted in yet belongs in this save.
    if (brushInput.hasPendingInput) await afterFrame();
    const dryIdx = [];
    const wetIdx = [];
    for (let i = 0; i < painted.length; i++) {
      if (painted[i]) dryIdx.push(i);
      if (tileWet(i)) wetIdx.push(i);
    }
    // Both reads are queued now, so the save is exactly this moment's painting.
    const dryRect = dryIdx.length ? tilesRect(dryIdx) : null;
    const wetRect = wetIdx.length ? tilesRect(wetIdx) : null;
    const dryPixels = dryRect && readLater(dry, dryRect);
    const wetPixels = wetRect && readLater(wetRead, wetRect);
    const ages = wetIdx.map((i) => simClock - wetSince[i]);
    await gpuDone();
    const job = { op: 'encode', layout };
    const transfer = [];
    if (dryRect) {
      job.dry = { pixels: dryPixels(), rect: dryRect, indices: dryIdx };
      transfer.push(job.dry.pixels.buffer);
    }
    if (wetRect) {
      job.wet = { pixels: wetPixels(), rect: wetRect, indices: wetIdx, ages };
      transfer.push(job.wet.pixels.buffer);
    }
    return (await runJob(job, transfer)).blob;
  }
  function uploadTile(target, index, rgba) {
    const t = tileRect(index);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, t.x, t.y, t.w, t.h, gl.RGBA, gl.HALF_FLOAT, rgba);
  }
  async function load(data) {
    // Unpacked in the worker; throws (a clear message) before anything here changes.
    const { dryTiles, wetTiles } = (await runJob({ op: 'decode', data, layout }, [])).result;
    brushInput.cancel();
    for (const t of [settled, merged, tail, dry, wetRead, wetWrite]) clearTarget(gl, t);
    [...undoStack, ...redoStack, ...pendingRedo].forEach(releaseStep);
    undoStack.length = 0;
    redoStack.length = 0;
    pendingRedo = [];
    activeStep = null;
    painted.fill(0);
    wetSince.fill(-Infinity);
    for (const { index, values } of dryTiles) {
      const rgba = new Uint16Array((values.length / 3) * 4);
      for (let i = 0, o = 0; i < values.length; i += 3, o += 4) rgba.set(values.subarray(i, i + 3), o);
      uploadTile(dry, index, rgba);
      painted[index] = 1;
    }
    for (const { index, age, values } of wetTiles) {
      uploadTile(wetRead, index, values);
      uploadTile(wetWrite, index, values);
      wetLevel[index] = MAX_LEVEL;
      wetSince[index] = simClock - age; // drying carries on from where it was
      painted[index] = 1;
    }
    wasWet = wetTiles.length > 0;
    notifyHistory();
  }
  requestAnimationFrame(frame);

  // Small 8-bit target for the corner preview, (re)made at the preview canvas's size.
  let preview = null;
  let previewPixels = null;
  function drawPreview(ctx) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    if (w < 1 || h < 1) return;
    if (!preview || preview.width !== w || preview.height !== h) {
      preview = createByteTarget(gl, w, h);
      previewPixels = new Uint8ClampedArray(w * h * 4);
    }
    composite(preview.fbo, w, h, { scale: 1, x: 0.5, y: 0.5 });
    gl.bindFramebuffer(gl.FRAMEBUFFER, preview.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, previewPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GPU rows run bottom-up; the 2D canvas wants top-down.
    const image = new ImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) image.data.set(previewPixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    ctx.putImageData(image, 0, 0);
  }

  const pane = tune ? await createTuningPaneLazily() : null;
  async function createTuningPaneLazily() {
    const { createTuningPane } = await import('./tuning.js');
    return createTuningPane({ tuning, brush, onClear: clear });
  }

  return {
    // Re-read the canvas's CSS size (call after the app resizes it).
    resize,
    // Change the brush; values apply from the next stroke. Unknown keys are ignored.
    setBrush(next) {
      for (const key of Object.keys(BRUSH_DEFAULTS)) {
        if (next[key] !== undefined) brush[key] = next[key];
      }
      pane?.refresh();
    },
    // Zoom and pan: scale 1..5, and the painting point (0..1, y down) at the centre of the canvas.
    // The centre is kept far enough in that the view never leaves the painting.
    setView({ scale = view.scale, x = view.x, y = view.y } = {}) {
      view.scale = Math.min(Math.max(scale, 1), 5);
      const half = 0.5 / view.scale;
      view.x = Math.min(Math.max(x, half), 1 - half);
      view.y = Math.min(Math.max(y, half), 1 - half);
    },
    getView: () => ({ ...view }),
    undo: () => stepBack(undoStack, redoStack),
    redo: () => stepBack(redoStack, undoStack),
    clear,
    // Drop the stroke in progress completely (no paint, no undo step). Its finger is ignored until it lifts.
    cancelStroke: () => brushInput.cancel(),
    // false: no new stroke can start (e.g. during a pinch).
    setInputEnabled(on) {
      appInput = !!on;
      applyInput();
    },
    // Runs the drying faster so all wet paint settles in about `durationMs`; resolves when nothing
    // is wet. No new stroke can start meanwhile.
    finishDrying,
    // Called after a stroke ends, and after undo, redo, clear and finishDrying. Returns an unsubscribe function.
    onChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    // The painting (dried and wet paint, and how far it has dried) as a Blob.
    save,
    // Restores a save into this engine (same canvas shape); drying carries on. Undo history starts empty.
    // Rejects with a clear error, leaving the painting untouched, if the data is old or damaged.
    load,
    // Called with { x, y, down } in client coordinates of where paint lands: on every move while
    // painting, and once on lift (down: false). Returns a function that unsubscribes.
    onPointer(cb) {
      pointerListeners.add(cb);
      return () => pointerListeners.delete(cb);
    },
    // Draws the whole painting (unzoomed) into a 2D canvas, at that canvas's pixel size.
    drawPreview,
    // Called now with the current state, then on every change. Returns a function that unsubscribes.
    onHistoryChange(cb) {
      historyListeners.add(cb);
      cb(historyState());
      return () => historyListeners.delete(cb);
    },
  };
}
