#version 300 es
precision highp float;
// One direction of a Gaussian blur of the wet area (run twice: across, then down).
// Alpha: the puddle's shape, ~1 deep inside, ~0.5 at the edge.
// RGB: the wet pigment around each pixel, so a drying edge knows how strong its puddle is.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;
uniform vec2 u_step;       // distance between taps, in 0..1 units, along the blur direction
uniform float u_fromWet;   // 1 = read the wet layer itself, 0 = read a previous blur pass

vec4 shape(vec2 uv) {
  vec4 c = texture(u_src, uv);
  // From the wet layer: pigment of wet pixels, and 1 wherever the paper is wet or damp.
  vec4 fromWet = vec4(c.rgb * step(1.0, c.a), step(1e-4, c.a));
  return mix(c, fromWet, u_fromWet);
}

void main() {
  // 13 taps, half a sigma apart, covering ±3 sigma.
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float x = float(i) * 0.5;
    float w = exp(-0.5 * x * x);
    sum += shape(v_uv + u_step * float(i)) * w;
    total += w;
  }
  outColor = sum / total;
}
