#version 300 es
precision highp float;
// White is opaque body colour: newly painted white hides part of the wet paint under it.
// Drawn with blending that multiplies the wet layer's rgb by this colour (alpha untouched).

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_settled;
uniform sampler2D u_merged;
uniform float u_cover;  // share of the paint underneath that white hides

void main() {
  float newlyCovered = max(texture(u_settled, v_uv).a - texture(u_merged, v_uv).a, 0.0);
  outColor = vec4(vec3(1.0 - u_cover * newlyCovered), 1.0);
}
