#version 300 es
precision highp float;
// A round dab of pigment. Drawn with MAX blending, so overlapping dabs inside
// one stroke stay flat instead of building up.
// Uneven wash: the amount of pigment varies in soft blotches across the paper. The pattern
// is fixed to paper position (so a stroke crossing itself stays even) and offset per stroke
// (so overlapping strokes get different blotches).

in vec2 v_local;
in float v_edgeSoft;
in vec2 v_canvas;
out vec4 outColor;

uniform vec3 u_absorbance; // the paint color, as light absorbed per channel (already diluted by water)
uniform float u_unevenness; // 0 = perfectly flat wash, 1 = strongly blotchy
uniform vec2 u_blotchScale; // blotches across / down the stamp
uniform vec2 u_seed;        // this stroke's offset into the blotch pattern
uniform float u_softDab;    // 1 for the water brush: coverage fades from the centre out, so its blend has soft sides

// #include noise

void main() {
  float d = length(v_local);
  float coverage = mix(1.0 - smoothstep(1.0 - v_edgeSoft, 1.0, d), 1.0 - smoothstep(0.15, 1.0, d), u_softDab);
  if (coverage <= 0.0) discard;
  // Two sizes of soft blotch, -1..1.
  vec2 q = v_canvas * u_blotchScale + u_seed;
  float blotch = (valueNoise(q) * 0.65 + valueNoise(q * 2.4 + 17.0) * 0.35) * 2.0 - 1.0;
  float amount = max(1.0 + u_unevenness * blotch, 0.0);

  outColor = vec4(u_absorbance * amount * coverage, coverage); // alpha = where the stroke is
}
