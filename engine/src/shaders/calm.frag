#version 300 es
precision highp float;
// Marks where the water brush has been (drawn with MAX blending). The wet step carries the mark
// along wherever that water spreads; paint drying under it gets no rim (no dark edge or bloom line).

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_settled; // the water brush's coverage (a)

void main() {
  outColor = vec4(texture(u_settled, v_uv).a);
}
