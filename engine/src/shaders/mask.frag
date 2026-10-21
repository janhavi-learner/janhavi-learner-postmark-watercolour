#version 300 es
precision highp float;
// The wet area, ready to blur: pigment of wet pixels (rgb), and 1 wherever the paper is wet
// or damp (a). Mipmapped afterwards so the rim blur can read it at a coarser level.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_wet; // pigment (rgb), wetness state (a): > 1 wet, 0..1 damp, 0 dry

void main() {
  vec4 c = texture(u_wet, v_uv);
  outColor = vec4(c.rgb * step(1.0, c.a), step(1e-4, c.a));
}
