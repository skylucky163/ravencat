/**
 * 改编自 img-fx 0.6.0 的 Chromium Flow 像素场：
 * https://github.com/Jakubantalik/img-fx/tree/2098279964046e23bad86d9f42f41a3b06dca735
 * 仅保留这一种效果；MIT 原文同时随 shader 字符串进入应用包。
 */

// 第一遍只计算每个格子的颜色与高光，避免在整块画布上重复计算噪声。
const FIELD = `
/*
MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
precision highp float;
uniform vec2 u_grid;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_intensity;
uniform float u_direction;
uniform vec3 u_color1, u_color2, u_color3, u_color4, u_color5;
const float u_complexity = 0.2;
const float u_distortion = 0.3;
const float u_alpha1 = 1.0, u_alpha2 = 1.0, u_alpha3 = 1.0, u_alpha4 = 1.0, u_alpha5 = 1.0;

vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }

vec2 mod289v2(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }

vec3 permute(vec3 x) { return mod289((x * 34.0 + 1.0) * x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289v2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x_ = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x_) - 0.5;
    vec3 ox = floor(x_ + 0.5);
    vec3 a0 = x_ - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

float fbm(vec2 p, float oct) {
    float val = 0.0, amp = 0.5;
    int n = int(oct);
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      val += amp * snoise(p);
      p *= 2.0;
      amp *= 0.5;
    }
    return val;
  }

float nfbm(vec2 p) { return fbm(p, 2.0 + u_complexity * 2.0); }

vec3 softBlend(float a, float b, float c) {
    a = clamp(a, 0.0, 1.0); a *= a;
    b = clamp(b, 0.0, 1.0); b *= b;
    c = clamp(c, 0.0, 1.0); c *= c;
    float d = clamp(a * 0.7 + c * 0.3, 0.0, 1.0); d *= d;
    float e = clamp(b * 0.5 + c * 0.5, 0.0, 1.0); e *= e;
    a *= u_alpha1; b *= u_alpha2; c *= u_alpha3; d *= u_alpha4; e *= u_alpha5;
    float total = a + b + c + d + e;
    float floorW = max(0.001 - total, 0.0);
    vec3 fallback = (u_color1 + u_color2 + u_color3 + u_color4 + u_color5) * 0.2;
    return (u_color1 * a + u_color2 * b + u_color3 * c + u_color4 * d + u_color5 * e + fallback * floorW) / (total + floorW);
  }

vec2 warp(vec2 p, float t) {
    float str = u_distortion * 2.0;
    return vec2(
      nfbm(p + vec2(t * 0.1, 0.0)),
      nfbm(p + vec2(0.0, t * 0.12) + 5.0)
    ) * str;
  }

vec3 effect(vec2 uv, float aspect, float t) {
  vec2 p = uv - 0.5;
  p.x *= aspect;
  p += vec2(cos(u_direction), sin(u_direction)) * t * 0.15;
  vec2 w = warp(p * 0.7, t * 0.5);
  vec2 w2 = warp(p * 0.4 + w * 0.3, t * 0.3);
  vec2 wp = p + w * (0.4 + u_distortion * 0.6);
  float n1 = snoise(wp * (1.4 + u_complexity * 1.6) + t * 0.14);
  float n2 = snoise((wp + w2 * u_distortion * 0.4) * (2.0 + u_complexity * 2.0) + vec2(3.0, 7.0) - t * 0.1);
  float ridge1 = pow(1.0 - abs(n1), 5.0 + 0.52 * 12.0);
  float ridge2 = pow(1.0 - abs(n2), 4.0 + 0.52 * 10.0);
  float base = (n1 + n2) * 0.25 + 0.5;
  return softBlend(
    (base * 0.6 + ridge1 * 1.2) * u_intensity,
    ((1.0 - base) * 0.6 + ridge2) * u_intensity,
    (ridge1 * 0.8 + ridge2 * 0.6) * u_intensity
  );
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_grid;
  float aspect = u_resolution.x / u_resolution.y;
  float t = u_time * 0.3;
  vec3 color = effect(uv, aspect, t) * 0.4;
  color += effect(uv + vec2(0.02, 0.0), aspect, t) * 0.15;
  color += effect(uv - vec2(0.02, 0.0), aspect, t) * 0.15;
  color += effect(uv + vec2(0.0, 0.02), aspect, t) * 0.15;
  color += effect(uv - vec2(0.0, 0.02), aspect, t) * 0.15;
  vec2 p = uv - 0.5;
  p.x *= aspect;
  float wave = (sin(p.x * 3.0 + t * 1.5) * 0.5 + 0.5) * (sin(p.y * 2.5 - t * 1.1) * 0.5 + 0.5);
  wave += (snoise(p * 2.0 + t * 0.6) * 0.5 + 0.5) * 0.3;
  float highlight = clamp(wave, 0.0, 1.0);
  gl_FragColor = vec4(color, highlight * highlight);
}
`;

// 第二遍只采样小纹理、绘制方格和溶解遮罩；原图仍由 RN Image 展示。
const COMPOSITE = `
precision highp float;
uniform sampler2D u_field;
uniform vec2 u_grid;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform vec3 u_cardBg;
uniform float u_dark;
uniform float u_reveal;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 cell = floor(uv * u_grid);
  vec4 field = texture2D(u_field, (cell + 0.5) / u_grid);
  vec2 local = fract(uv * u_grid);
  float boost = 1.0 + smoothstep(0.2, 0.8, field.a) * 0.8 * 1.2;
  float gap = 0.14 * 0.35 / boost;
  float mask = step(gap, local.x) * step(gap, 1.0 - local.x) * step(gap, local.y) * step(gap, 1.0 - local.y);
  vec2 cssRes = u_resolution / u_dpr;
  vec2 coord = uv * cssRes;
  float edge = min(min(coord.x, cssRes.x - coord.x), min(coord.y, cssRes.y - coord.y));
  mask *= smoothstep(0.0, mix(20.0, 24.0, u_dark), edge);
  float alpha = mix(mix(0.18, 0.44, u_dark), 0.68, mask);
  float luminance = dot(field.rgb, vec3(0.299, 0.587, 0.114));
  float background = dot(u_cardBg, vec3(0.299, 0.587, 0.114));
  alpha *= smoothstep(0.0, mix(0.16, 0.33, u_dark), abs(luminance - background));
  float highlight = field.a * mix(0.7, 0.2, u_dark);
  vec3 color = field.rgb * (1.0 + highlight * 2.5) + vec3(highlight * highlight * 0.3);
  float vignette = smoothstep(0.0, 1.0, edge * edge / (71.2 * 71.2));
  color *= mix(1.0, vignette, 0.26 * u_dark);
  vec2 center = (uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);
  alpha *= mix(0.3, 1.0, smoothstep(0.04, 0.3, length(center)));
  float random = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  float threshold = 0.15 + random * 0.65 + (1.0 - field.a) * 0.2;
  alpha *= 1.0 - smoothstep(threshold - 0.12, threshold + 0.12, u_reveal * 1.3);
  gl_FragColor = vec4(color, alpha);
}
`;

export const IMAGE_GENERATION_PIXEL_SHADERS = { field: FIELD, composite: COMPOSITE } as const;

