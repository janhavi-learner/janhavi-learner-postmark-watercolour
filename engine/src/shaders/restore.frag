#version 300 es
precision highp float;
// Undo: puts one tile of the wet layer back as it was before the step.
// Pigment comes back exactly. Wetness comes back too, except where the paper was wet then and
// is still wet now: there it keeps today's water level, so the restored tile dries in step
// with the paint around it (no seam along the tile edge).

out vec4 outColor;

uniform sampler2D u_snap;     // undo store page
uniform sampler2D u_cur;      // copy of the tile as it is now
uniform ivec2 u_tileOrigin;   // tile's corner in the wet layer
uniform ivec2 u_snapOrigin;   // tile's corner in the undo store page
uniform float u_hasSnap;      // 0 = the tile was dry paper then

void main() {
  ivec2 local = ivec2(gl_FragCoord.xy) - u_tileOrigin;
  vec4 snap = u_hasSnap > 0.5 ? texelFetch(u_snap, u_snapOrigin + local, 0) : vec4(0.0);
  vec4 cur = texelFetch(u_cur, local, 0);
  float state = (snap.a > 1.0 && cur.a > 1.0) ? cur.a : snap.a;
  outColor = vec4(snap.rgb, state);
}
