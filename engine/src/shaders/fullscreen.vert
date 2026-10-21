#version 300 es
// Full-screen triangle generated from the vertex index; no buffers needed.
out vec2 v_uv;

void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); // (0,0) (2,0) (0,2)
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
