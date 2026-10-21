#version 300 es
precision highp float;
// Copies a texture; drawn with additive blending to add pigment onto the dry layer.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;

void main() {
  outColor = texture(u_src, v_uv);
}
