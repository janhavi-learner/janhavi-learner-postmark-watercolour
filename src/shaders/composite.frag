#version 300 es
precision highp float;
// Final image: paper, multiplied by every layer of paint on it.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_paper;
uniform sampler2D u_dry;      // absorbance of dried paint (rgb)
uniform sampler2D u_wet;      // absorbance of wet paint (rgb), wetness state (a: > 1 wet)
uniform sampler2D u_tail;     // the stroke's last stretch near the finger, not yet in the wet layer
uniform sampler2D u_settled;  // the rest of the stroke (already in the wet layer), to avoid counting overlap twice
uniform float u_wetDarken;    // wet paper looks slightly darker; shows where clear water was laid
uniform vec2 u_paperScale;    // how many times the scan repeats across the stamp (x, y)
uniform vec3 u_paperMean;     // average paper color, the pivot for contrast
uniform float u_grainContrast; // 1 = scan as-is, >1 = deeper tooth, <1 = smoother
uniform float u_darkPace;     // how quickly deep glazes approach black (higher = faster)
uniform float u_granulation;  // how strongly pigment settles into paper dips and clumps
uniform vec2 u_clumpScale;    // pigment clumps across / down the stamp (sets clump size)
uniform float u_paperStd;     // typical brightness spread of the paper, to normalise bump height

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(c, vec3(1.0 / 2.2)); }

// #include noise

void main() {
  // The paper tile (made seamless at load) repeats to make the grain finer.
  vec3 paper = texture(u_paper, v_uv * u_paperScale).rgb;

  // Bump height from brightness: lit paper peaks are lighter, dips are darker. -1 (dip) .. 1 (peak).
  float lum = dot(paper, vec3(0.299, 0.587, 0.114));
  float meanLum = dot(u_paperMean, vec3(0.299, 0.587, 0.114));
  float bump = clamp((lum - meanLum) / (2.0 * u_paperStd), -1.0, 1.0);

  paper = clamp(u_paperMean + (paper - u_paperMean) * u_grainContrast, 0.0, 1.0);

  // --- Granulation: how much pigment sits at this spot, relative to an even film.
  // Floating pigment (fresh paint) only follows the paper loosely: a thinner film on peaks.
  float floating = 1.0 - u_granulation * 0.6 * bump;
  // Settled pigment (dried paint) has sunk into the dips and clumped into specks.
  // -1..1, zero on average, so pigment is moved around rather than added.
  // Specks follow the paper's dips first; clumps (small flocks of particles) add irregularity,
  // and a large slow pattern makes some areas of a wash granulate more than others.
  float clump = valueNoise(v_uv * u_clumpScale) * 0.6 + valueNoise(v_uv * u_clumpScale * 0.45) * 0.4;
  float patches = mix(0.35, 1.25, valueNoise(v_uv * u_clumpScale * 0.08));
  float settle = clamp(-bump * 0.75 + (clump - 0.5) * 0.9, -1.0, 1.0) * patches;
  // Dips gain more than peaks lose: specks read as dark pigment, not as holes in the paint.
  float settled = max(1.0 + u_granulation * (settle > 0.0 ? 1.5 : 0.8) * settle, 0.0);

  vec3 dry = texture(u_dry, v_uv).rgb;
  vec4 wet = texture(u_wet, v_uv);
  vec4 tail = texture(u_tail, v_uv);
  vec3 stroke = max(tail.rgb - texture(u_settled, v_uv).rgb, 0.0);
  // Wet paint settles as it dries: wetness state goes from ~2 (fresh) down to 1 (dry).
  float settledShare = clamp(2.0 - wet.a, 0.0, 1.0);
  float wetFactor = mix(floating, settled, settledShare);

  // Absorbance adds up layer by layer (adding absorbance == multiplying colors): no ceiling.
  vec3 absorbance = dry + wet.rgb + stroke;
  vec3 granulated = dry * settled + wet.rgb * wetFactor + stroke * floating;
  float total = absorbance.r + absorbance.g + absorbance.b;
  float granulationRatio = total > 0.0 ? (granulated.r + granulated.g + granulated.b) / total : 1.0;

  // Pure multiplying makes late glazes invisible: each removes a % of almost nothing.
  // A log curve makes every glaze a visible step that shrinks slowly but never stops
  // (log has no upper limit). One factor scales all channels, so deep colors stay saturated.
  float strongest = max(max(absorbance.r, absorbance.g), absorbance.b);
  if (strongest > 0.0) absorbance *= u_darkPace * log(1.0 + strongest / u_darkPace) / strongest;

  // Applied after the darkening curve so the paper texture gets MORE visible as glazes
  // deepen, like real watercolor, instead of disappearing into the dark.
  absorbance *= granulationRatio;

  vec3 lit = toLinear(paper) * exp(-absorbance);
  float wetness = max(smoothstep(1.0, 1.1, wet.a), tail.a);
  lit *= 1.0 - u_wetDarken * wetness;
  outColor = vec4(toSrgb(lit), 1.0);
}
