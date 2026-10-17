// Original GLSL for the landing texture, written for this repo's spec.
// Pass 1 (wind) writes one texel per cell: r=light, g=glow, b=rouse, a=calm.
// Pass 2 (glyph) draws one bufferless quad per cell from the glyph atlas.

export const FULLSCREEN_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const WIND_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform float uTime;
uniform vec2 uSize;
uniform vec2 uGrid;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform int uWakeCount;
uniform vec4 uWakes[48];    // xy center, z force, w age
uniform vec4 uWakeSegs[48]; // xy direction, z half-length
uniform int uTapCount;
uniform vec4 uTaps[6];      // xy center, z age, w shape (0 circle, 1 diamond)

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return v;
}
float shapeReach(vec2 d, float shape, float age) {
  float circle = length(d);
  if (shape < 0.5) return circle;
  float diamond = abs(d.x) + abs(d.y);
  return mix(circle, diamond, smoothstep(0.0, 0.2, age));
}

void main() {
  vec2 cell = gl_FragCoord.xy - 0.5;
  vec2 px = (cell + 0.5) * uSize / uGrid;

  vec2 drift = px - uWindDir * (uTime * uWindSpeed);
  float n = fbm(drift / 160.0 + 0.6 * fbm(drift / 320.0));
  float wind = clamp((n - 0.42) * 1.7, 0.0, 1.0);

  vec2 ec = vec2((px.x - uSize.x * 0.5) / 250.0, (px.y - uSize.y * 0.45) / 80.0);
  float calm = 1.0 - 0.7 * exp(-0.9 * dot(ec, ec));

  float warmSum = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= uWakeCount) break;
    vec4 w = uWakes[i];
    vec4 s = uWakeSegs[i];
    vec2 rel = px - w.xy;
    float along = clamp(dot(rel, s.xy), -s.z, s.z);
    vec2 off = rel - s.xy * along;
    float r = 50.0 + 40.0 * w.w;
    warmSum += w.z * exp(-w.w / 0.65) * exp(-dot(off, off) / (r * r));
  }
  float warm = 1.0 - exp(-1.5 * warmSum);

  vec2 warped = px + 24.0 * (vec2(vnoise(px / 95.0), vnoise(px / 95.0 + 7.31)) - 0.5);
  float glow = 0.0;
  float rouse = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= uTapCount) break;
    vec4 t = uTaps[i];
    float age = t.z;
    float reach = shapeReach(warped - t.xy, t.w, age);
    float behind = 620.0 * (1.0 - exp(-age / 1.3)) - reach;
    float w2 = 85.0 + 60.0 * age;
    float front = exp(-behind * behind / (w2 * w2)) * exp(-age / 1.5);
    rouse += front;
    // Glow trails behind the front only — no wash ahead of it.
    glow += front + 0.5 * exp(-age / 1.3) * exp(-max(behind, 0.0) / 260.0) * step(0.0, behind);
  }

  // The calm zone thins ambient wind and wakes behind the centered
  // copy, but a deliberate tap punches through it at full strength.
  float light = clamp((wind * 0.8 + warm * 0.85) * calm + rouse, 0.0, 1.0) + 0.03 * calm;
  outColor = vec4(light, clamp(glow, 0.0, 1.0), clamp(rouse, 0.0, 1.0), calm);
}
`;

export const GLYPH_VERT = `#version 300 es
precision highp float;
uniform sampler2D uWind;
uniform vec2 uSize;
uniform vec2 uGrid;
uniform float uTime;
uniform int uSeq[42];
uniform float uAtlasRows;
out vec2 vUv;
out vec3 vData; // light, glow, hue position seed
out vec2 vPx;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  int cellIndex = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  int cols = int(uGrid.x);
  ivec2 cell = ivec2(cellIndex % cols, cellIndex / cols);
  vec4 wind = texelFetch(uWind, cell, 0);
  float light = wind.r;
  if (light < 0.04) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vData = vec3(0.0);
    vPx = vec2(0.0);
    return;
  }
  vec2 c = vec2(0.0);
  if (corner == 1 || corner == 3) c.x = 1.0;
  if (corner == 2 || corner == 4) c.y = 1.0;
  if (corner == 5) c = vec2(1.0, 1.0);

  vec2 cellPx = uSize / uGrid;
  vec2 topLeft = vec2(cell) * cellPx;
  vec2 pos = topLeft + c * cellPx;
  vPx = topLeft + cellPx * 0.5;

  float h1 = hash21(vec2(cell));
  float h2 = hash21(vec2(cell) + 41.7);
  float pace = 0.6 + h2 * 0.8;
  float stepped = floor(h1 * 42.0 + uTime * 1.2 * pace + wind.b * 6.0);
  int seqIndex = int(mod(stepped, 42.0));
  int atlasIndex = uSeq[seqIndex];
  vec2 tile = vec2(float(atlasIndex % 16), float(atlasIndex / 16));
  vUv = (tile + vec2(c.x, 1.0 - c.y)) / vec2(16.0, uAtlasRows);
  vData = vec3(light, wind.g, wind.b);
  gl_Position = vec4(pos.x / uSize.x * 2.0 - 1.0, 1.0 - pos.y / uSize.y * 2.0, 0.0, 1.0);
}
`;

export const GLYPH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform float uTime;
uniform float uShown;
uniform int uMode; // 0 rainbow, 1 single
uniform vec3 uColor;
uniform float uRainbowSpeed;
in vec2 vUv;
in vec3 vData;
in vec2 vPx;
out vec4 outColor;

vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsl.z + hsl.y * (rgb - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}

void main() {
  float mask = texture(uAtlas, vUv).a;
  float light = vData.x;
  float glow = vData.y;
  vec3 color;
  if (uMode == 0) {
    float hue = mod(vPx.x * 0.55 + vPx.y * 0.35 + uTime * 45.0 * uRainbowSpeed, 360.0) / 360.0;
    color = hsl2rgb(vec3(hue, 0.9, 0.52 + glow * 0.16));
  } else {
    color = mix(uColor, vec3(1.0), 0.55 * glow);
  }
  float alpha = mask * (0.15 + light * 0.85) * uShown;
  outColor = vec4(color, alpha);
}
`;
