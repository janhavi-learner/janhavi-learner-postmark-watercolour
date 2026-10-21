#version 300 es
precision highp float;
// Dried pigment that leaves the dry layer under the brush: dissolved by the water brush,
// or hidden by white. Subtracted from the dry layer afterwards.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_settled;
uniform sampler2D u_merged;
uniform sampler2D u_dry;
uniform float u_share; // water-brush lift + white cover

void main() {
  float newlyCovered = max(texture(u_settled, v_uv).a - texture(u_merged, v_uv).a, 0.0);
  outColor = vec4(texture(u_dry, v_uv).rgb * u_share * newlyCovered, 0.0);
}
