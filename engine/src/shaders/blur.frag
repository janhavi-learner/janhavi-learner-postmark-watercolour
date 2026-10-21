#version 300 es
precision highp float;
// One direction of a Gaussian blur of the wet area (run twice: across, then down).
// Alpha: the puddle's shape, ~1 deep inside, ~0.5 at the edge.
// RGB: the wet pigment around each pixel, so a drying edge knows how strong its puddle is.
// The first pass reads the mask at a coarser mip level, so even a wide rim blur has its taps
// close together (no visible steps) and stays cheap.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;
uniform float u_lod;  // mip level to read (first pass), 0 for the second
uniform vec2 u_step;  // distance between taps, in 0..1 units, along the blur direction

void main() {
  // 13 taps, half a sigma apart, covering ±3 sigma.
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float x = float(i) * 0.5;
    float w = exp(-0.5 * x * x);
    sum += textureLod(u_src, v_uv + u_step * float(i), u_lod) * w;
    total += w;
  }
  outColor = sum / total;
}
