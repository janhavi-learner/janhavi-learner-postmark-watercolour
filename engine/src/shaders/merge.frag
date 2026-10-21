#version 300 es
precision highp float;
// Settled parts of the stroke join the wet layer, every frame while painting. Drawn straight onto
// the wet layer with blending (rgb added, alpha = max), only over the area under the brush.
// Where they land on wet paint they become part of the same puddle: pigments add, water is topped up.
// Only what's new since the last merge is added (settled minus already-merged), so a stroke
// is never counted twice.
// Water brush: also re-dissolves part of the dried pigment under it into the wet paint.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_settled;  // settled dabs of this stroke: absorbance (rgb), coverage (a)
uniform sampler2D u_merged;   // the part of u_settled already merged
uniform sampler2D u_dry;      // dried pigment
uniform float u_waterLevel;   // how much water this stroke carries (more = dries later)
uniform float u_lift;         // share of dried pigment re-dissolved by newly wetted paper (water brush)

void main() {
  vec4 settled = texture(u_settled, v_uv);
  vec4 merged = texture(u_merged, v_uv);
  vec3 added = max(settled.rgb - merged.rgb, 0.0);
  float newlyCovered = max(settled.a - merged.a, 0.0);
  vec3 lifted = texture(u_dry, v_uv).rgb * u_lift * newlyCovered;
  // Even the soft anti-aliased fringe counts as wet, so the puddle edge stays crisp.
  float water = settled.a > 0.01 ? 1.0 + u_waterLevel : 0.0; // wet state = 1 + water
  outColor = vec4(added + lifted, water);
}
