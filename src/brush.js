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
//   { tail: [...], style }      (last, while painting) the current unsettled tail, to preview
// `style` is whatever getStyle() returned when the stroke started.

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

export function createBrushInput(canvas, { getRadiusPx, getTaperPx, getPressureEffect, getStyle }) {
  const queue = [];
  const press = createPressReader(canvas);
  let points = [];     // whole current stroke, 5 numbers per dab: x, y, distance-from-start, pressure size, live size
  let committed = 0;   // how many dabs have been handed over as settled
  let pointerId = null;
  let last = null;
  let travelled = 0;   // stroke length so far, CSS px
  let carry = 0;       // distance since the last dab
  let taperPx = 0;
  let style = null;

  function local(e, pressSize) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height, size: pressSize };
  }

  // Pressure 0..1 -> width factor. Full press = full brush size; the slider sets how thin a light touch gets.
  function pressSize(e, smoothed) {
    const raw = 1 - getPressureEffect() * (1 - press.read(e));
    return smoothed === undefined ? raw : smoothed + (raw - smoothed) * 0.35; // smooth out jitter
  }

  function dab(p, dist) {
    // While painting we only know the start, so only the start tapers live.
    const live = p.size * (taperPx > 0 ? taper(dist / (taperPx * START_SHARE)) : 1);
    points.push(p.x / p.w, 1 - p.y / p.h, dist, p.size, live);
  }

  // Place a dab every `spacing` pixels along the segment from the last point,
  // blending pressure along the way.
  // Spacing is tight because thin tips need closely packed dabs to stay smooth.
  function lineTo(p) {
    const spacing = Math.max(0.75, getRadiusPx(p.w) * 0.1);
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
    const settledBefore = travelled - taperPx - getRadiusPx(last.w);
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
    if (pointerId !== null || e.button > 0) return; // one finger paints; extra fingers are ignored
    e.preventDefault();
    pointerId = e.pointerId;
    // Capture keeps events coming if the finger slides off the canvas. Some browsers
    // (e.g. inside an embedded frame) refuse it; move/up are also heard on window below.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* fine without it */ }
    style = getStyle();
    queue.push({ start: true, style });
    press.begin(e);
    last = local(e, pressSize(e));
    taperPx = getTaperPx(last.w);
    points = [];
    committed = 0;
    travelled = 0;
    carry = 0;
    dab(last, 0);
  });

  // Listen on window so the stroke keeps working even when capture was refused.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    // Coalesced events give every touch sample the phone recorded, not just one per frame.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of events.length ? events : [e]) lineTo(local(ce, pressSize(ce, last.size)));
    commitSettled();
  });

  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    queue.push({ end: finalDabs(getRadiusPx(last.w)), style });
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  return {
    // True while a finger is painting.
    get painting() { return pointerId !== null; },
    // Hands over everything recorded since the last frame, plus the current tail while painting.
    take() {
      const events = queue.splice(0, queue.length);
      if (pointerId !== null) events.push({ tail: tailDabs(), style });
      return events;
    },
  };
}
