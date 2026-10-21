#version 300 es
// One brush dab per instance: a small square around each stamp position.
layout(location = 0) in vec3 a_dab; // xy = center in 0..1 canvas coords, z = size (taper) 0..1

uniform vec2 u_radius;    // full brush radius in 0..1 units (x and y differ because the canvas isn't square)
uniform float u_radiusPx; // full brush radius in paint pixels
uniform float u_edgePx;   // anti-aliased rim width in paint pixels

out vec2 v_local;       // -1..1 across the dab
out vec2 v_canvas;      // position on the stamp, 0..1
out float v_edgeSoft;   // rim width relative to this dab's radius

void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0; // triangle strip corners
  v_local = corner;
  v_edgeSoft = min(0.5, u_edgePx / (u_radiusPx * a_dab.z));
  vec2 p = a_dab.xy + corner * u_radius * a_dab.z;
  v_canvas = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
