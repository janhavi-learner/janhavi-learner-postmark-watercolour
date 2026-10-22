#version 300 es
precision highp float;
// Water brush: blends the paint under it with its neighbours, right away, the first time the
// brush covers each pixel. Dried paint blends with dried paint, wet with wet; nothing gets wetter
// or drier, so no new edge, rim or bloom appears. Written to two outputs (wet, dry) and copied back.

layout(location = 0) out vec4 outWet;
layout(location = 1) out vec4 outDry;

uniform sampler2D u_wet;      // pigment (rgb), wetness state (a: > 1 wet)
uniform sampler2D u_dry;      // dried pigment
uniform sampler2D u_settled;  // this stroke's coverage so far (a)
uniform sampler2D u_merged;   // the part already blended
uniform float u_radiusPx;     // how far the blend reaches, paint px

const int TAPS = 32;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_dry, 0);
  vec4 wet = texelFetch(u_wet, p, 0);
  vec4 dry = texelFetch(u_dry, p, 0);
  float newlyCovered = max(texelFetch(u_settled, p, 0).a - texelFetch(u_merged, p, 0).a, 0.0);
  if (newlyCovered <= 0.0) {
    outWet = wet;
    outDry = dry;
    return;
  }

  // Soft disc of neighbours (a spiral, evenly spread), weighted by distance.
  bool isWet = wet.a > 1.0;
  float sigma = u_radiusPx * 0.5;
  vec3 drySum = dry.rgb;
  float dryWeight = 1.0;
  vec3 wetSum = wet.rgb;
  float wetWeight = 1.0;
  for (int i = 0; i < TAPS; i++) {
    float r = u_radiusPx * sqrt((float(i) + 0.5) / float(TAPS));
    float a = float(i) * 2.39996;
    ivec2 q = clamp(p + ivec2(round(vec2(cos(a), sin(a)) * r)), ivec2(0), size - 1);
    float w = exp(-0.5 * r * r / (sigma * sigma));
    drySum += texelFetch(u_dry, q, 0).rgb * w;
    dryWeight += w;
    vec4 s = texelFetch(u_wet, q, 0);
    if (isWet && s.a > 1.0) {
      wetSum += s.rgb * w;
      wetWeight += w;
    }
  }
  outDry = vec4(mix(dry.rgb, drySum / dryWeight, newlyCovered), dry.a);
  outWet = isWet ? vec4(mix(wet.rgb, wetSum / wetWeight, newlyCovered), wet.a) : wet;
}
