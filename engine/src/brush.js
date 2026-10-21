// Turns finger movement into evenly spaced brush dabs, in 0..1 canvas coordinates.
// Each dab is (x, y, size) where size 0..1 combines pressure and taper.
//
// A stroke's dabs far enough behind the finger can no longer change shape, so they are
// handed over while painting and join the wet paint right away (blending starts behind
// the brush). The last stretch near the finger stays a "tail" until lift, because the
// end taper is only known then.
//
// take() returns a queue of events in order:
//   { start: true, style }      a stroke began (before anything is drawn)
//   { commit: [...], style }    dabs that are settled: add them to the wet paint now
//   { end: [...], style }       the stroke finished: the remaining dabs, with their final taper
//   { cancel: true }            the stroke was cancelled (e.g. a pinch began): undo all of it
//   { tail: [...], style }      (last, while painting) the current unsettled tail, to preview
// `style` is whatever getStyle(rect) returned when the stroke started. It must include
// radiusPx, taperPx, offsetPx, offsetRampPx (on-screen CSS pixels) and smoothing (0..1).
//
// All lengths here are in on-screen pixels; toPaint() turns a point on the canvas (0..1, y down)
// into a point on the painting, through the current zoom.

const MIN_SIZE = 0.15;   // how thin the tips get, relative to full brush width
const START_SHARE = 0.5; // a brush lands quickly and lifts slowly: the start taper is half the end taper

// 0 -> MIN_SIZE, 1 -> full width, rising quickly then easing in (like a brush pressed down).
function taper(t) {
  const c = Math.min(Math.max(t, 0), 1);
  return MIN_SIZE + (1 - MIN_SIZE) * Math.sin(c * Math.PI * 0.5);
}

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// How hard the brush is pressed, 0..1, from the best signal this phone gives:
//   'pressure' real pressure (stylus, or phones that report it)
//   'contact'  finger contact size (a harder press flattens the fingertip)
//   'speed'    neither available: slow = pressed in, fast = light and thin
// Detection is sticky: once a phone shows a real signal, it's used from then on.
function createPressReader(canvas) {
  const reader = { source: 'speed' };
  // Some phones only expose force/size through the older Touch events; keep the latest values.
  const touch = { force: 0, radius: 0, firstForce: 0, firstRadius: 0 };
  const onTouch = (e) => {
    const t = e.changedTouches[0];
    if (!t) return;
    touch.force = t.force || 0;
    touch.radius = t.radiusX || 0;
    if (e.type === 'touchstart') {
      touch.firstForce = touch.force;
      touch.firstRadius = touch.radius;
    }
  };
  canvas.addEventListener('touchstart', onTouch, { passive: true });
  canvas.addEventListener('touchmove', onTouch, { passive: true });
  let contactMin = Infinity;
  let contactMax = 0;
  let firstContact = 0;
  let lastTime = 0;
  let lastX = 0;
  let lastY = 0;
  let speed = 0; // px per ms, smoothed

  reader.begin = (e) => {
    firstContact = (e.width + e.height) / 2;
    lastTime = e.timeStamp;
    lastX = e.clientX;
    lastY = e.clientY;
    speed = 0;
  };

  reader.read = (e) => {
    const contact = (e.width + e.height) / 2;

    // Phones without pressure hardware report exactly 0, 0.5 or 1.
    const pointerPressure = e.pressure > 0 && e.pressure !== 0.5 && e.pressure !== 1;
    const touchForce = touch.force > 0 && touch.force !== touch.firstForce;
    if (e.pointerType === 'pen' || pointerPressure || touchForce) reader.source = 'pressure';
    if (reader.source === 'speed') {
      const sizeChanges = (contact > 1 && Math.abs(contact - firstContact) > 0.5)
        || (touch.radius > 0 && Math.abs(touch.radius - touch.firstRadius) > 0.25);
      if (sizeChanges) reader.source = 'contact';
    }

    const dt = Math.max(e.timeStamp - lastTime, 1);
    const v = Math.hypot(e.clientX - lastX, e.clientY - lastY) / dt;
    speed += (v - speed) * Math.min(1, dt / 40); // ~40ms smoothing
    lastTime = e.timeStamp;
    lastX = e.clientX;
    lastY = e.clientY;

    if (reader.source === 'pressure') {
      return clamp01(e.pointerType === 'pen' || pointerPressure || touch.force === 0 ? e.pressure : touch.force);
    }
    if (reader.source === 'contact') {
      const size = contact > 1 ? contact : touch.radius * 2;
      // Range adapts to the user's own finger over time.
      contactMin = Math.min(contactMin, size);
      contactMax = Math.max(contactMax, size, contactMin + 4);
      return clamp01((size - contactMin) / (contactMax - contactMin));
    }
    return 1 - smoothstep(0.15, 2.5, speed);
  };

  return reader;
}

export function createBrushInput(canvas, { getPressureEffect, getStyle, toPaint, onPointer }) {
  const queue = [];
  const press = createPressReader(canvas);
  let points = [];     // whole current stroke, 5 numbers per dab: x, y (painting), distance-from-start, pressure size, live size
  let committed = 0;   // how many dabs have been handed over as settled
  let pointerId = null;
  let ignoredId = null; // a cancelled stroke's finger: ignored until it lifts
  let enabled = true;
  let last = null;     // last landing point (on-screen px within the canvas)
  let travelled = 0;   // stroke length so far, on-screen px
  let carry = 0;       // distance since the last dab
  let taperPx = 0;
  let style = null;
  let smooth = null;   // smoothed finger position
  let finger = null;   // raw finger position
  let fingerTravel = 0;

  function rectOf() {
    return canvas.getBoundingClientRect();
  }

  // Where paint lands for this finger sample: the smoothed finger position, lifted up by the
  // offset, which grows smoothly from 0 over the first offsetRampPx of finger movement.
  function landing(e, r, pressSize) {
    const f = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (finger) fingerTravel += Math.hypot(f.x - finger.x, f.y - finger.y);
    finger = f;
    const follow = 1 - 0.9 * style.smoothing; // 1 = no smoothing
    smooth = smooth ? { x: smooth.x + (f.x - smooth.x) * follow, y: smooth.y + (f.y - smooth.y) * follow } : f;
    const ramp = style.offsetRampPx > 0 ? Math.min(fingerTravel / style.offsetRampPx, 1) : 1;
    const offset = style.offsetPx * ramp * ramp * (3 - 2 * ramp);
    return { x: smooth.x, y: smooth.y - offset, w: r.width, h: r.height, size: pressSize };
  }

  function report(p, down) {
    if (!onPointer || !p) return;
    const r = rectOf();
    onPointer({ x: r.left + p.x, y: r.top + p.y, down });
  }

  // Pressure 0..1 -> width factor. Full press = full brush size; the slider sets how thin a light touch gets.
  function pressSize(e, smoothed) {
    const raw = 1 - getPressureEffect() * (1 - press.read(e));
    return smoothed === undefined ? raw : smoothed + (raw - smoothed) * 0.35; // smooth out jitter
  }

  function dab(p, dist) {
    // While painting we only know the start, so only the start tapers live.
    const live = p.size * (taperPx > 0 ? taper(dist / (taperPx * START_SHARE)) : 1);
    const [u, v] = toPaint(p.x / p.w, p.y / p.h);
    points.push(u, v, dist, p.size, live);
  }

  // Place a dab every `spacing` pixels along the segment from the last point,
  // blending pressure along the way.
  // Spacing is tight because thin tips need closely packed dabs to stay smooth.
  function lineTo(p) {
    const spacing = Math.max(0.75, style.radiusPx * 0.1);
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const dist = Math.hypot(dx, dy);
    let s = spacing - carry;
    while (s <= dist) {
      const t = s / dist;
      dab({ x: last.x + dx * t, y: last.y + dy * t, w: p.w, h: p.h, size: last.size + (p.size - last.size) * t }, travelled + s);
      s += spacing;
    }
    carry = dist - (s - spacing);
    travelled += dist;
    last = p;
  }

  // Hand over dabs that are at least a full end-taper (plus a brush radius) behind the finger.
  // Only once the stroke is long enough for its tapers to be final; a short stroke's shape
  // still depends on how long it ends up.
  function commitSettled() {
    if (travelled < taperPx * (1 + START_SHARE)) return;
    const settledBefore = travelled - taperPx - style.radiusPx;
    const out = [];
    while (committed * 5 < points.length && points[committed * 5 + 2] < settledBefore) {
      const i = committed * 5;
      out.push(points[i], points[i + 1], points[i + 4]);
      committed++;
    }
    if (out.length) queue.push({ commit: out, style });
  }

  // The not-yet-settled dabs as they look right now (start taper only).
  function tailDabs() {
    const out = [];
    for (let i = committed * 5; i < points.length; i += 5) out.push(points[i], points[i + 1], points[i + 4]);
    return out;
  }

  // Final shape once the length is known: taper both ends. Returns only the dabs not yet handed over.
  // Short strokes use shorter tapers; a tap with no movement stays a round blot.
  function finalDabs(radiusPx) {
    const length = travelled;
    const out = [];
    const tipPx = Math.min(taperPx, length / (1 + START_SHARE));
    for (let i = 0; i < points.length; i += 5) {
      const s = points[i + 2];
      const shape = length < radiusPx * 0.5 || tipPx <= 0 ? 1 : Math.min(taper(s / (tipPx * START_SHARE)), taper((length - s) / tipPx));
      out.push(points[i], points[i + 1], points[i + 3] * shape);
    }
    // Inside the tapers the width may only grow toward the middle and shrink toward
    // the tips. Otherwise slowing down before lifting (= "pressing harder") leaves a knob.
    const n = out.length / 3;
    for (let k = n - 2; k >= 0; k--) {
      if (points[k * 5 + 2] < tipPx * START_SHARE) out[k * 3 + 2] = Math.min(out[k * 3 + 2], out[k * 3 + 5]);
    }
    for (let k = 1; k < n; k++) {
      if (points[k * 5 + 2] > length - tipPx) out[k * 3 + 2] = Math.min(out[k * 3 + 2], out[k * 3 - 1]);
    }
    return out.slice(committed * 3);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!enabled || pointerId !== null || ignoredId !== null || e.button > 0) return; // one finger paints
    e.preventDefault();
    pointerId = e.pointerId;
    // Capture keeps events coming if the finger slides off the canvas. Some browsers
    // (e.g. inside an embedded frame) refuse it; move/up are also heard on window below.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* fine without it */ }
    const r = rectOf();
    // Sizes are in on-screen pixels: zoomed in, the same brush paints a finer line on the paper.
    style = getStyle(r);
    queue.push({ start: true, style });
    press.begin(e);
    finger = null;
    smooth = null;
    fingerTravel = 0;
    last = landing(e, r, pressSize(e));
    taperPx = style.taperPx;
    points = [];
    committed = 0;
    travelled = 0;
    carry = 0;
    dab(last, 0);
    report(last, true);
  });

  // Listen on window so the stroke keeps working even when capture was refused.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const r = rectOf();
    // Coalesced events give every touch sample the phone recorded, not just one per frame.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of events.length ? events : [e]) lineTo(landing(ce, r, pressSize(ce, last.size)));
    commitSettled();
    report(last, true);
  });

  const end = (e) => {
    if (e.pointerId === ignoredId) {
      ignoredId = null;
      return;
    }
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    queue.push({ end: finalDabs(style.radiusPx), style });
    report(last, false);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  return {
    // True while a finger is painting.
    get painting() { return pointerId !== null; },
    // Drop the stroke in progress; its finger is ignored until it lifts.
    cancel() {
      if (pointerId === null) return;
      ignoredId = pointerId;
      pointerId = null;
      queue.push({ cancel: true });
      report(last, false);
    },
    // false: no new stroke can start (a stroke already going is not affected).
    setEnabled(on) {
      enabled = !!on;
    },
    // Hands over everything recorded since the last frame, plus the current tail while painting.
    take() {
      const events = queue.splice(0, queue.length);
      if (pointerId !== null) events.push({ tail: tailDabs(), style });
      return events;
    },
  };
}
