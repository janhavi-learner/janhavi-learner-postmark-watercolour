#version 300 es
precision highp float;
// One time step of wet paint.
//
// Each pixel's state (alpha) says how wet it is:
//   > 1      wet: holds water (state - 1) and pigment that can still move
//   0 .. 1   damp: just dried, pigment already on the dry layer; still counts as part
//            of the puddle, so neighbours drying a moment later don't draw a rim between them
//   0        dry paper (never painted, or dry long enough)
//
// Per step:
//  1. pigment and water flow between wet neighbours, so colors and values painted
//     wet-into-wet blend into soft gradients;
//  2. very wet paint bleeds into the dry paper next to it, carrying some pigment: feathered
//     edges. The paper's dips and fibres soak it up faster, so the edge comes out irregular.
//     It stops by itself once the water has spread thin or evaporated below BLEED_ABOVE;
//  3. water evaporates, damp pixels finish drying;
//  4. pixels that just dried hand their pigment to the dry layer, with extra pigment
//     near the puddle's edge (edge darkening: pigment is carried to the rim as it dries).

in vec2 v_uv;
layout(location = 0) out vec4 outWet;      // next state: pigment (rgb), wetness state (a)
layout(location = 1) out vec4 outDeposit;  // pigment that dried this step (added to the dry layer)

uniform sampler2D u_wet;
uniform sampler2D u_puddle;      // blurred puddle: wet pigment around here (rgb), shape (a: ~1 inside, ~0.5 at the edge)
uniform sampler2D u_paper;       // paper scan, for how absorbent each spot is
uniform vec2 u_paperScale;       // how many times the scan repeats across the stamp
uniform float u_paperMeanLum;    // average paper brightness
uniform float u_paperStd;        // typical brightness spread of the paper
uniform vec2 u_fiberScale;       // paper fibres across / down the stamp
uniform ivec2 u_offset;          // neighbour offset in whole pixels; its direction rotates every step
uniform float u_pigmentFlow;     // 0..0.24, how fast pigment evens out inside wet paint
uniform float u_waterFlow;       // 0..0.24, how fast water evens out (so a puddle dries as one)
uniform float u_bleed;           // how fast very wet paint pushes into dry paper
uniform float u_evaporate;       // water lost this step
uniform float u_dampFade;        // how much of the damp phase passes this step
uniform float u_edgeStrength;    // extra pigment at the rim when it dries, relative to the puddle's own
uniform float u_probePx;         // how far to look (paint px) when checking if the puddle around is drying

// Paint layers are half-float: around 1.0 they can only store steps of ~0.001. A state saved
// just above 1.0 could round down to exactly 1.0 and read as "already dry", skipping the
// deposit and losing its pigment. So anything this close to 1 counts as drying now.
const float DRY_LINE = 1.0 + 1.0 / 256.0;
// Only paint holding more water than this pushes into dry paper (a fresh default stroke holds 1.0).
const float BLEED_ABOVE = 0.85;
// Pigment travels with the bleeding water, but lags behind it: the bled fringe is lighter.
const float BLEED_CARRY = 0.7;

// #include noise

// Two neighbours exchange fully if both are wet. Even a barely-wet pixel (e.g. the fringe of
// a bleed) is fully linked, so the puddle tops it up and it dries together with the rest.
float link(float a, float b) { return (a > DRY_LINE && b > DRY_LINE) ? 1.0 : 0.0; }

// How readily the paper at this spot soaks up water: dips and fibres more, raised tooth less.
float absorbency(vec2 uv) {
  float lum = dot(texture(u_paper, uv * u_paperScale).rgb, vec3(0.299, 0.587, 0.114));
  float bump = clamp((lum - u_paperMeanLum) / (2.0 * u_paperStd), -1.0, 1.0);
  float fiber = valueNoise(uv * u_fiberScale) - 0.5;
  return clamp(0.55 - 0.45 * bump + fiber * 0.9, 0.05, 1.0);
}

// Water a wet pixel pushes into each dry neighbour per unit of absorbency.
float bleedPush(vec4 s) { return u_bleed * max(s.a - 1.0 - BLEED_ABOVE, 0.0); }

// The rim belongs to the moment the puddle dries, not to one edge pixel that dries early
// (e.g. a thin bled fringe). 1 if the wet paint around this pixel is nearly out of water
// too, 0 if it's still clearly wet.
float puddleDrying(ivec2 p, ivec2 size) {
  float water = 0.0;
  float count = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec4 s = texelFetch(u_wet, clamp(p + ivec2(round(vec2(cos(a), sin(a)) * u_probePx)), ivec2(0), size - 1), 0);
    if (s.a > 1.0) {
      water += s.a - 1.0;
      count += 1.0;
    }
  }
  return 1.0 - smoothstep(0.03, 0.15, count > 0.0 ? water / count : 0.0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_wet, 0);
  vec2 texel = 1.0 / vec2(size);
  vec4 c = texelFetch(u_wet, p, 0);
  outDeposit = vec4(0.0);

  // Four neighbours in a rotating direction: cheap, and over a few steps it reaches evenly all ways.
  // Exact pixels (no filtering), so whatever one pixel gives, its neighbour receives:
  // nothing leaks or appears from nowhere.
  ivec2 o1 = u_offset;
  ivec2 o2 = ivec2(-u_offset.y, u_offset.x);
  ivec2 q[4];
  q[0] = clamp(p + o1, ivec2(0), size - 1);
  q[1] = clamp(p - o1, ivec2(0), size - 1);
  q[2] = clamp(p + o2, ivec2(0), size - 1);
  q[3] = clamp(p - o2, ivec2(0), size - 1);
  vec4 n[4];
  for (int i = 0; i < 4; i++) n[i] = texelFetch(u_wet, q[i], 0);

  vec3 pigment;
  float state;

  if (c.a > 1.0) {
    // Wet: blend with wet neighbours, bleed into dry ones.
    float water = c.a - 1.0;
    vec3 concentration = c.rgb / max(water, 1e-3);
    float push = bleedPush(c);
    vec3 dPigment = vec3(0.0);
    float dWater = 0.0;
    float bledOut = 0.0;
    for (int i = 0; i < 4; i++) {
      float k = link(c.a, n[i].a);
      dPigment += k * (n[i].rgb - c.rgb);
      dWater += k * (n[i].a - c.a);
      if (n[i].a <= 1.0 && push > 0.0) bledOut += push * absorbency((vec2(q[i]) + 0.5) * texel);
    }
    pigment = max(c.rgb + u_pigmentFlow * dPigment - concentration * bledOut * BLEED_CARRY, 0.0);
    state = c.a + u_waterFlow * dWater - bledOut - u_evaporate;
  } else {
    // Dry or damp: soak up water (and some pigment) from very wet neighbours, if any.
    float bledIn = 0.0;
    vec3 pigmentIn = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      float push = n[i].a > 1.0 ? bleedPush(n[i]) : 0.0;
      if (push <= 0.0) continue;
      bledIn += push;
      pigmentIn += n[i].rgb / max(n[i].a - 1.0, 1e-3) * push * BLEED_CARRY;
    }
    if (bledIn <= 0.0) {
      // Nothing arrives: damp slowly turns fully dry.
      outWet = vec4(0.0, 0.0, 0.0, max(c.a - u_dampFade, 0.0));
      return;
    }
    // How readily this spot soaks it up (only looked up when something arrives: it's costly).
    float soak = absorbency(v_uv);
    pigment = pigmentIn * soak;
    state = 1.0 + bledIn * soak - u_evaporate;
    if (state <= DRY_LINE) {
      // Only a trace arrived and it dried at once: keep the trace of pigment, but the paper
      // stays as it was. Marking it damp would make the puddle look wider than its wet part
      // and weaken the rim at the real edge.
      outWet = vec4(0.0, 0.0, 0.0, max(c.a - u_dampFade, 0.0));
      outDeposit = vec4(pigment, 1.0);
      return;
    }
  }

  if (state > DRY_LINE) {
    outWet = vec4(pigment, state);
  } else {
    // Dried this step. Rim = 1 right at the puddle edge, fading inward.
    // The rim's extra pigment comes from the puddle around it (its average strength), not just
    // this pixel: a feathered, bled edge holds little pigment itself but still dries darker.
    // Only paint that was properly wet gets a rim: a pixel that just received a trace of
    // bled water and dries straight away keeps only the trace of pigment it received.
    vec4 puddle = texture(u_puddle, v_uv);
    float wasWet = c.a > 1.0 ? 1.0 : 0.0; // just-dried (damp) pixels sit at exactly 1.0: not wet
    float rim = pow(clamp((1.0 - puddle.a) * 2.0, 0.0, 1.0), 2.5) * wasWet * puddleDrying(p, size);
    vec3 puddlePigment = puddle.rgb / max(puddle.a, 0.05);
    outWet = vec4(0.0, 0.0, 0.0, 1.0); // start of the damp phase
    outDeposit = vec4(pigment + u_edgeStrength * rim * puddlePigment, 1.0);
  }
}
