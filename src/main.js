import './errors.js';
import { Pane } from 'tweakpane';
import {
  createContext, createProgram, loadImage, createImageTexture, drawFullscreen,
  requireFloatTargets, createTarget, createMultiTarget, clearTarget, copyTarget,
} from './gl.js';
import { createBrushInput } from './brush.js';
import { preparePaper } from './paper.js';
import paperUrl from '../paper.jpg';
import fullscreenVert from './shaders/fullscreen.vert?raw';
import compositeFrag from './shaders/composite.frag?raw';
import stampVert from './shaders/stamp.vert?raw';
import stampFrag from './shaders/stamp.frag?raw';
import addFrag from './shaders/add.frag?raw';
import blurFrag from './shaders/blur.frag?raw';
import mergeFrag from './shaders/merge.frag?raw';
import wetFrag from './shaders/wet.frag?raw';
import noiseGlsl from './shaders/noise.glsl?raw';

// Shaders that need the shared noise helpers mark the spot with "// #include noise".
const withNoise = (src) => src.replace('// #include noise', noiseGlsl);

const STAMP_ASPECT = 4 / 5; // width / height
// Paint is stored at up to 1.5 pixels per CSS pixel. Watercolor is soft, so this
// looks identical to full resolution but keeps later effects cheap on 3x phones.
const PAINT_DENSITY = 1.5;
// On big screens (desktop panels) paint is capped at this width; it keeps undo memory sane.
const PAINT_MAX_W = 720;

// Undo/redo keeps this many steps (each stroke and each Clear is one step).
const HISTORY_STEPS = 20;
// Water brush: share of the dried pigment under it that dissolves back into the wet paint.
const WATER_LIFT = 0.4;
// Wet paper looks slightly darker than dry; this is how much (also shows where clear water is).
const WET_DARKEN = 0.06;

// Every visual number lives here and gets a slider.
// After a pixel dries it stays "damp" for this fraction of the drying time.
// Neighbours drying within that window join the same rim instead of drawing a line between them.
const DAMP_SHARE = 0.4;

const params = {
  brushSize: 10,       // diameter, % of stamp width
  taper: 1.5,          // length of the thin start/end, in brush widths
  pressure: 0.7,       // 0 = pressure ignored, 1 = a light touch is very thin
  color: '#5f7d9c',    // muted blue, as pure pigment
  waterBrush: false,   // paint clear water instead of pigment (softens edges, re-wets dried paint)
  water: 0.3,          // how dilute each stroke is; at 0.3 about two glazes reach the picked color
  darkPace: 4,         // how fast deep glazes head toward black; they never reach it
  unevenness: 0.3,     // how blotchy a flat wash is (new strokes)
  granulation: 0.6,    // how strongly pigment settles into paper dips and clumps as it dries
  dryingTime: 20,      // seconds a stroke stays wet (at the default water amount)
  spread: 0.5,         // how fast colors and values blend inside wet paint
  edgeStrength: 3,     // how much darker the drying rim is
  edgeWidth: 3,        // how far the rim reaches into the puddle, CSS px
  grainSize: 0.5,      // 1 = one copy of the scan across the stamp, smaller = finer grain
  grainContrast: 1.6,
};

const canvas = document.getElementById('stamp');
const gl = createContext(canvas);

// iOS Safari ignores user-scalable=no for pinch; block its gesture events directly.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// Color picker hex -> how much light one stroke absorbs per channel.
// The picked color is the rich, fully loaded pigment. Water dilutes each stroke:
// water 0 = one full-strength stroke; water 1 = about seven times more dilute.
// Glazes simply add, so there is no ceiling.
function hexToAbsorbance(hex, water) {
  const n = parseInt(hex.slice(1, 7), 16);
  const load = Math.pow(0.15, water);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => -Math.log(Math.max(Math.pow(v / 255, 2.2), 0.005)) * load);
}

// Fit a 4:5 stamp into the screen with a margin, rendered at device pixel ratio.
// Some hosts (e.g. an embedded panel that is still opening) start with no size at all.
// Paint layers need a real size, so wait until the stamp is at least this wide.
const MIN_STAMP_PX = 80;
function waitForSize() {
  return new Promise((done) => {
    const check = () => {
      resize();
      if (parseFloat(canvas.style.width) >= MIN_STAMP_PX) done();
      else requestAnimationFrame(check);
    };
    check();
  });
}

function resize() {
  const margin = 24;
  const historyRow = 44 + 12; // undo/redo buttons and the gap above them
  const availW = window.innerWidth - margin * 2;
  const availH = window.innerHeight - margin * 2 - historyRow;
  const cssW = Math.max(0, Math.floor(Math.min(availW, availH * STAMP_ASPECT)));
  const cssH = Math.floor(cssW / STAMP_ASPECT);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}

function buildPane(onClear) {
  const pane = new Pane({ title: 'Tuning', expanded: false });
  const brush = pane.addFolder({ title: 'Brush' });
  brush.addBinding(params, 'brushSize', { label: 'size %', min: 2, max: 30, step: 0.5 });
  brush.addBinding(params, 'taper', { label: 'taper', min: 0, max: 8, step: 0.1 });
  brush.addBinding(params, 'pressure', { label: 'pressure', min: 0, max: 1, step: 0.01 });
  brush.addBinding(params, 'color', { label: 'color' });
  brush.addBinding(params, 'waterBrush', { label: 'water brush' });
  const paint = pane.addFolder({ title: 'Paint' });
  paint.addBinding(params, 'water', { label: 'water', min: 0, max: 1, step: 0.01 });
  paint.addBinding(params, 'darkPace', { label: 'dark pace', min: 1, max: 8, step: 0.1 });
  paint.addBinding(params, 'unevenness', { label: 'wash unevenness', min: 0, max: 1, step: 0.01 });
  paint.addBinding(params, 'granulation', { label: 'granulation', min: 0, max: 1.5, step: 0.01 });
  const wet = pane.addFolder({ title: 'Wet & drying' });
  wet.addBinding(params, 'dryingTime', { label: 'drying time s', min: 0.5, max: 40, step: 0.5 });
  wet.addBinding(params, 'spread', { label: 'spread speed', min: 0, max: 1, step: 0.01 });
  const edge = pane.addFolder({ title: 'Edge darkening' });
  edge.addBinding(params, 'edgeStrength', { label: 'strength', min: 0, max: 5, step: 0.05 });
  edge.addBinding(params, 'edgeWidth', { label: 'width px', min: 1, max: 20, step: 0.5 });
  const paper = pane.addFolder({ title: 'Paper' });
  paper.addBinding(params, 'grainSize', { label: 'grain size', min: 0.15, max: 1.5, step: 0.01 });
  paper.addBinding(params, 'grainContrast', { label: 'grain depth', min: 0, max: 4, step: 0.05 });
  pane.addButton({ title: 'Clear' }).on('click', onClear);
  return pane;
}

// White (every channel at least this bright) is painted as opaque body colour, like Chinese white:
// it covers the paint under it instead of glazing over it. All other colours stay transparent.
const WHITE_FROM = 235;
function isWhite(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].every((v) => v >= WHITE_FROM);
}

// A stroke's look is locked in when it starts, so changing a slider mid-stroke
// (or right after lifting) never changes a stroke that's already down.
function currentStyle() {
  const white = !params.waterBrush && isWhite(params.color);
  return {
    absorbance: params.waterBrush || white ? [0, 0, 0] : hexToAbsorbance(params.color, params.water),
    lift: params.waterBrush ? WATER_LIFT : 0,
    // Share of the paint underneath one white stroke hides; more water = thinner white.
    cover: white ? 0.9 - 0.6 * params.water : 0,
    radiusX: (params.brushSize / 100) * 0.5,
    waterLevel: (0.5 + params.water) / 0.8, // more water = stays wet longer; 1.0 at the default
    unevenness: params.unevenness,
    seed: [Math.random() * 100, Math.random() * 100], // each stroke gets its own blotches
  };
}

async function start() {
  if (!gl || !requireFloatTargets(gl)) return;
  const programs = {
    composite: createProgram(gl, fullscreenVert, withNoise(compositeFrag), 'composite'),
    stamp: createProgram(gl, stampVert, withNoise(stampFrag), 'stamp'),
    add: createProgram(gl, fullscreenVert, addFrag, 'add'),
    blur: createProgram(gl, fullscreenVert, blurFrag, 'blur'),
    merge: createProgram(gl, fullscreenVert, mergeFrag, 'merge'),
    wet: createProgram(gl, fullscreenVert, withNoise(wetFrag), 'wet'),
  };
  if (Object.values(programs).some((p) => !p)) return;

  const paperImage = await loadImage(paperUrl);
  const paper = preparePaper(paperImage);
  const paperTex = createImageTexture(gl, paper.pixels);
  const paperMean = paper.mean;
  const paperStd = paper.lumStd;
  const paperAspect = paperImage.width / paperImage.height; // width / height
  const paperMeanLum = 0.299 * paperMean[0] + 0.587 * paperMean[1] + 0.114 * paperMean[2];
  // How many times the scan repeats across / down the stamp, without stretching it.
  const paperRepeat = () => [1 / params.grainSize, paperAspect / STAMP_ASPECT / params.grainSize];

  await waitForSize();
  window.addEventListener('resize', resize);

  // Paint layers are created once and addressed in 0..1 coordinates,
  // so a resize never wipes or distorts the painting.
  const paintW = Math.min(Math.round(parseFloat(canvas.style.width) * PAINT_DENSITY), PAINT_MAX_W);
  const paintH = Math.round(paintW / STAMP_ASPECT);
  // The stroke being painted, in three parts:
  const settled = createTarget(gl, paintW, paintH); // dabs that won't change shape any more
  const merged = createTarget(gl, paintW, paintH);  // the part of `settled` already added to the wet paint
  const tail = createTarget(gl, paintW, paintH);    // the last stretch near the finger, redrawn every frame
  const dry = createTarget(gl, paintW, paintH);     // paint that has dried
  const lift = createTarget(gl, paintW, paintH);    // dried pigment the water brush takes back up this frame
  const deposit = createTarget(gl, paintW, paintH); // pigment that dried this frame, on its way to `dry`
  // Wet paint, ping-pong: each step reads one and writes the other, then they swap.
  let wetRead = createTarget(gl, paintW, paintH);
  let wetWrite = createTarget(gl, paintW, paintH);
  // The wet step writes the next wet state and the deposit at once.
  const wetStepFbo = new Map([
    [wetRead, createMultiTarget(gl, [wetWrite.tex, deposit.tex])],
    [wetWrite, createMultiTarget(gl, [wetRead.tex, deposit.tex])],
  ]);
  // Merging writes the next wet state and the lifted pigment at once.
  const mergeFbo = new Map([
    [wetRead, createMultiTarget(gl, [wetWrite.tex, lift.tex])],
    [wetWrite, createMultiTarget(gl, [wetRead.tex, lift.tex])],
  ]);
  // The puddle-shape blur only needs to be soft, so it runs at half resolution.
  const halfW = Math.ceil(paintW / 2);
  const halfH = Math.ceil(paintH / 2);
  const puddleA = createTarget(gl, halfW, halfH);
  const puddleB = createTarget(gl, halfW, halfH);
  // Simulated seconds since paint last joined the wet layer. Counted in simulation time, not the
  // clock, so slow frames or switching apps never stop the simulation with paint still half-wet.
  let simSinceMerge = Infinity;
  // Nothing can still be wet after this long (wettest stroke + damp phase, with margin).
  // Uses the current slider, so raising the drying time mid-way never freezes paint half-wet.
  const mayBeWet = () => simSinceMerge < (((0.5 + 1) / 0.8) * 1.2 + DAMP_SHARE) * params.dryingTime + 1;

  const swapWet = () => { [wetRead, wetWrite] = [wetWrite, wetRead]; };

  const brushInput = createBrushInput(canvas, {
    getRadiusPx: (cssW) => (params.brushSize / 100) * cssW * 0.5,
    getTaperPx: (cssW) => params.taper * (params.brushSize / 100) * cssW,
    getPressureEffect: () => params.pressure,
    getStyle: currentStyle,
  });

  // --- Undo / redo: a copy of the dried and wet paint before each step.
  // Copies live on the GPU; spare ones are kept in a pool and reused.
  const spare = [];
  const takeLayer = () => spare.pop() || createTarget(gl, paintW, paintH);
  const undoStack = [];
  const redoStack = [];
  const undoButton = document.getElementById('undo');
  const redoButton = document.getElementById('redo');

  function snapshot() {
    // Nothing wet? Then there's no need to keep a copy of the (empty) wet layer.
    const snap = { dry: takeLayer(), wet: mayBeWet() ? takeLayer() : null, sim: simSinceMerge };
    copyTarget(gl, dry, snap.dry);
    if (snap.wet) copyTarget(gl, wetRead, snap.wet);
    return snap;
  }
  function release(snap) {
    spare.push(snap.dry);
    if (snap.wet) spare.push(snap.wet);
  }
  function restore(snap) {
    copyTarget(gl, snap.dry, dry);
    if (snap.wet) copyTarget(gl, snap.wet, wetRead);
    else clearTarget(gl, wetRead);
    simSinceMerge = snap.sim; // wet paint carries on drying from where it was
    release(snap);
  }
  function updateHistoryButtons() {
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
  }
  // Call before a step changes the painting.
  function rememberStep() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_STEPS) release(undoStack.shift());
    redoStack.splice(0).forEach(release); // a new step makes the undone ones unreachable
    updateHistoryButtons();
  }
  function stepBack(from, to) {
    if (!from.length || brushInput.painting) return;
    to.push(snapshot());
    restore(from.pop());
    updateHistoryButtons();
  }
  undoButton.addEventListener('click', () => stepBack(undoStack, redoStack));
  redoButton.addEventListener('click', () => stepBack(redoStack, undoStack));

  buildPane(() => {
    rememberStep();
    for (const t of [settled, merged, tail, dry, wetRead, wetWrite]) clearTarget(gl, t);
    simSinceMerge = Infinity;
  });

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

  // Draw a batch of dabs into one of the stroke layers. MAX blending keeps one stroke an even wash.
  function drawStamps(target, dabs, style) {
    if (!dabs.length) return;
    const { program, uniforms: u } = programs.stamp;
    const radiusX = style.radiusX;
    const radiusPx = radiusX * paintW;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, paintW, paintH);
    gl.useProgram(program);
    gl.uniform2f(u.u_radius, radiusX, radiusX * STAMP_ASPECT);
    gl.uniform1f(u.u_radiusPx, radiusPx);
    gl.uniform1f(u.u_edgePx, 1.5);
    gl.uniform3fv(u.u_absorbance, style.absorbance);
    gl.uniform1f(u.u_unevenness, style.unevenness);
    gl.uniform2f(u.u_seed, style.seed[0], style.seed[1]);
    // Blotches about a tenth of the stamp across, kept round on the 4:5 stamp.
    gl.uniform2f(u.u_blotchScale, 10, 10 / STAMP_ASPECT);
    gl.bindVertexArray(stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, stampBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dabs), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dabs.length / 3);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  // Add what's newly settled in the stroke to the wet layer (and any wet puddle it touches).
  // Runs every frame while painting, so blending starts right behind the brush.
  function mergeSettled(style) {
    const { program, uniforms: u } = programs.merge;
    gl.bindFramebuffer(gl.FRAMEBUFFER, mergeFbo.get(wetRead));
    gl.viewport(0, 0, paintW, paintH);
    gl.useProgram(program);
    bindTextures(u, { u_wet: wetRead.tex, u_settled: settled.tex, u_merged: merged.tex, u_dry: dry.tex });
    gl.uniform1f(u.u_waterLevel, style.waterLevel);
    gl.uniform1f(u.u_lift, style.lift);
    gl.uniform1f(u.u_cover, style.cover);
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
    swapWet();

    // Water brush / white: re-dissolved or covered pigment leaves the dry layer (dry minus lift).
    if (style.lift > 0 || style.cover > 0) {
      const add = programs.add;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dry.fbo);
      gl.useProgram(add.program);
      bindTextures(add.uniforms, { u_src: lift.tex });
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawFullscreen(gl);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
    }

    copyTarget(gl, settled, merged);
    simSinceMerge = 0;
  }

  // Blur the wet area's shape (across, then down) so drying pixels know how close they are to the puddle edge.
  function blurPuddleShape() {
    const { program, uniforms: u } = programs.blur;
    const sigmaPx = (params.edgeWidth * PAINT_DENSITY) / 2; // CSS px -> half-res paint px
    gl.useProgram(program);
    gl.viewport(0, 0, halfW, halfH);
    gl.bindVertexArray(emptyVao);
    const passes = [[wetRead, puddleA, [0.5 * sigmaPx / halfW, 0], 1], [puddleA, puddleB, [0, 0.5 * sigmaPx / halfH], 0]];
    for (const [src, dst, step, fromWet] of passes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      bindTextures(u, { u_src: src.tex });
      gl.uniform2f(u.u_step, step[0], step[1]);
      gl.uniform1f(u.u_fromWet, fromWet);
      drawFullscreen(gl);
    }
  }

  // One step of wet paint: blend, evaporate, and drop dried pigment (with its rim) onto the dry layer.
  let stepCount = 0;
  function wetStep(dt) {
    blurPuddleShape();

    const { program, uniforms: u } = programs.wet;
    gl.bindFramebuffer(gl.FRAMEBUFFER, wetStepFbo.get(wetRead));
    gl.viewport(0, 0, paintW, paintH);
    gl.useProgram(program);
    bindTextures(u, { u_wet: wetRead.tex, u_puddle: puddleB.tex, u_paper: paperTex });
    const paperScale = paperRepeat();
    gl.uniform2f(u.u_paperScale, paperScale[0], paperScale[1]);
    gl.uniform1f(u.u_paperMeanLum, paperMeanLum);
    gl.uniform1f(u.u_paperStd, paperStd);
    // Fibres about 1.5 CSS px across.
    const cssW = parseFloat(canvas.style.width);
    gl.uniform2f(u.u_fiberScale, cssW / 1.5, cssW / STAMP_ASPECT / 1.5);
    // Neighbour distance grows with spread speed; its direction turns by the golden angle each step.
    // Every other step uses the nearest pixel, so all pixels stay linked to each other.
    const reachPx = stepCount % 2 ? 1 : 1 + 4 * params.spread;
    const angle = stepCount++ * 2.39996;
    let ox = Math.round(Math.cos(angle) * reachPx);
    let oy = Math.round(Math.sin(angle) * reachPx);
    if (ox === 0 && oy === 0) ox = 1;
    gl.uniform2i(u.u_offset, ox, oy);
    // Flow per step scales with frame time, so 60Hz and 120Hz screens blend at the same speed.
    const perStep = Math.min(dt * 60, 1);
    gl.uniform1f(u.u_pigmentFlow, params.spread > 0 ? 0.24 * perStep : 0);
    gl.uniform1f(u.u_waterFlow, 0.24 * perStep);
    // Outward bleeding follows spread speed too (0.5 = the default rate).
    gl.uniform1f(u.u_bleed, 0.5 * params.spread * perStep);
    gl.uniform1f(u.u_evaporate, (dt * 0.8) / params.dryingTime);
    gl.uniform1f(u.u_dampFade, dt / (DAMP_SHARE * params.dryingTime));
    gl.uniform1f(u.u_edgeStrength, params.edgeStrength);
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
    swapWet();

    // Add this frame's dried pigment onto the dry layer.
    const add = programs.add;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dry.fbo);
    gl.useProgram(add.program);
    bindTextures(add.uniforms, { u_src: deposit.tex });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    drawFullscreen(gl);
    gl.disable(gl.BLEND);
  }

  let tailCover = 0; // the stroke being painted, if white: how much it covers (shown before it settles)
  function composite() {
    const { program, uniforms: u } = programs.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const paperScale = paperRepeat();
    gl.useProgram(program);
    bindTextures(u, { u_paper: paperTex, u_dry: dry.tex, u_wet: wetRead.tex, u_tail: tail.tex, u_settled: settled.tex });
    gl.uniform1f(u.u_wetDarken, WET_DARKEN);
    gl.uniform1f(u.u_tailCover, tailCover);
    gl.uniform2f(u.u_paperScale, paperScale[0], paperScale[1]);
    gl.uniform3fv(u.u_paperMean, paperMean);
    gl.uniform1f(u.u_grainContrast, params.grainContrast);
    gl.uniform1f(u.u_darkPace, params.darkPace);
    gl.uniform1f(u.u_granulation, params.granulation);
    // Pigment clumps about 2 CSS px across, whatever the phone's pixel density.
    const cssW = parseFloat(canvas.style.width);
    gl.uniform2f(u.u_clumpScale, cssW / 2, cssW / STAMP_ASPECT / 2);
    gl.uniform1f(u.u_paperStd, paperStd);
    gl.bindVertexArray(emptyVao);
    drawFullscreen(gl);
  }

  let lastTime = 0;
  function frame(ms) {
    const now = ms / 1000;
    const dt = Math.min(lastTime ? now - lastTime : 1 / 60, 1 / 20); // cap so a hiccup doesn't dry paint in one jump
    lastTime = now;

    // Replay this frame's input in order.
    let mergeStyle = null; // set when settled dabs are waiting to join the wet paint
    for (const event of brushInput.take()) {
      if (event.start) {
        rememberStep();
      } else if (event.commit) {
        drawStamps(settled, event.commit, event.style);
        mergeStyle = event.style;
      } else if (event.end) {
        // The rest of the stroke, with its final end taper, joins the wet paint; the stroke layers empty.
        drawStamps(settled, event.end, event.style);
        mergeSettled(event.style);
        for (const t of [settled, merged, tail]) clearTarget(gl, t);
        mergeStyle = null;
        tailCover = 0;
      } else if (event.tail) {
        clearTarget(gl, tail);
        drawStamps(tail, event.tail, event.style);
        tailCover = event.style.cover;
      }
    }
    if (mergeStyle) mergeSettled(mergeStyle);
    // Only simulate while something can still be wet; dry paint costs nothing.
    if (mayBeWet()) {
      wetStep(dt);
      simSinceMerge += dt;
    }

    composite();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start();
