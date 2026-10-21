// Tiny WebGL2 helpers: compile shaders (with on-screen errors), load textures,
// and draw a full-screen triangle.
import { showError } from './errors.js';

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl) showError('WebGL2 is not available in this browser.');
  return gl;
}

// Shows the error log plus the offending source lines, e.g. "ERROR: 0:12: ...".
function reportCompileError(gl, shader, source, label) {
  const log = gl.getShaderInfoLog(shader) || '(no log)';
  const lines = source.split('\n');
  const context = [...log.matchAll(/ERROR:\s*\d+:(\d+)/g)]
    .map((m) => +m[1])
    .map((n) => `  ${n}: ${lines[n - 1] ?? ''}`)
    .join('\n');
  showError(`Shader compile error in ${label}:\n${log.trim()}${context ? '\n' + context : ''}`);
}

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    reportCompileError(gl, shader, source, label);
    return null;
  }
  return shader;
}

// Returns { program, uniforms } where uniforms maps name -> location.
export function createProgram(gl, vertSrc, fragSrc, name) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc, `${name}.vert`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, `${name}.frag`);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    showError(`Shader link error in ${name}:\n${gl.getProgramInfoLog(program)}`);
    return null;
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name: uName } = gl.getActiveUniform(program, i);
    uniforms[uName.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, uName);
  }
  return { program, uniforms };
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image ${url}`));
    img.src = url;
  });
}

export function createImageTexture(gl, image) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

// WebGL2 can only render into half-float textures with this extension.
// Paint values go above 1, so 8-bit textures won't do.
export function requireFloatTargets(gl) {
  const ok = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
  if (!ok) showError('This GPU cannot render to half-float textures (EXT_color_buffer_float missing).');
  return !!ok;
}

// A half-float texture you can draw into (via its framebuffer) and read from.
export function createTarget(gl, width, height) {
  if (width < 1 || height < 1) showError(`Paint layer has no size (${width} × ${height}).`);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) showError(`Framebuffer incomplete (0x${status.toString(16)}).`);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, width, height };
}

// A framebuffer that writes to several textures at once (one per `out` in the shader).
export function createMultiTarget(gl, textures) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  textures.forEach((tex, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0));
  gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) showError(`Multi-target framebuffer incomplete (0x${status.toString(16)}).`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

// Copies one paint layer into another of the same size.
export function copyTarget(gl, src, dst) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
  gl.blitFramebuffer(0, 0, src.width, src.height, 0, 0, dst.width, dst.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

export function clearTarget(gl, target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

// One triangle that covers the screen; positions come from gl_VertexID.
export function drawFullscreen(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
