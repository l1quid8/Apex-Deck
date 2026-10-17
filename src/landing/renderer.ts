// WebGL2 renderer for the landing texture: wind pass to an offscreen
// framebuffer (one texel per cell), then a bufferless glyph pass.
// Fails soft: createLandingRenderer returns null and the surface keeps
// its normal background. Nothing here throws into the pane.

import {
  ATLAS_CHARS, CELL_H, CELL_W, SEQUENCE, createFieldState, frameIntervalMs,
  gridSize, hexToRgb, idleVisibility, pointerLeave, pointerMove, pointerTap,
  prune, type FieldState,
} from "./engine.ts";
import { FULLSCREEN_VERT, GLYPH_FRAG, GLYPH_VERT, WIND_FRAG } from "./shaders.ts";
import type { LandingTextureSettings } from "../settings.ts";

const MAX_DEVICE_PIXELS = 21_000_000;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("landing texture shader failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("landing texture program failed:", gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

/** Rasterize the atlas chars once on a 2D canvas: 16 columns, 2x tiles. */
function buildAtlas(gl: WebGL2RenderingContext): { texture: WebGLTexture; rows: number } | null {
  const tileW = Math.ceil(CELL_W * 2);
  const tileH = Math.ceil(CELL_H * 2);
  const rows = Math.ceil(ATLAS_CHARS.length / 16);
  const canvas = document.createElement("canvas");
  canvas.width = tileW * 16;
  canvas.height = tileH * rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "18px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  [...ATLAS_CHARS].forEach((ch, i) => {
    ctx.fillText(ch, (i % 16) * tileW + tileW / 2, Math.floor(i / 16) * tileH + tileH / 2 + 1);
  });
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, rows };
}

function isSoftwareRenderer(gl: WebGL2RenderingContext): boolean {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return false;
    const name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
    return /swiftshader|llvmpipe|software/i.test(name);
  } catch { return false; }
}

export interface LandingRenderer {
  resize(cssWidth: number, cssHeight: number): void;
  setSettings(settings: LandingTextureSettings): void;
  pointerMove(x: number, y: number, pointerType: string): void;
  pointerDown(x: number, y: number): void;
  pointerLeave(): void;
  /** Draw one frame and stop (reduced-motion path). */
  drawStatic(): void;
  start(): void;
  destroy(): void;
}

class Renderer implements LandingRenderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private windProg: WebGLProgram;
  private glyphProg: WebGLProgram;
  private atlas: WebGLTexture;
  private atlasRows: number;
  private windTex: WebGLTexture | null = null;
  private windFbo: WebGLFramebuffer | null = null;
  private vao: WebGLVertexArrayObject | null;
  private settings: LandingTextureSettings;
  private state: FieldState;
  private startedAt = performance.now() / 1000;
  private raf = 0;
  private running = false;
  private destroyed = false;
  private lastFrameAt = 0;
  private shown = 1;
  private cssW = 0;
  private cssH = 0;
  private cols = 0;
  private rows = 0;
  private windDir: [number, number];
  private windSpeed: number;
  private seq: Int32Array;
  private loseCtx: WEBGL_lose_context | null;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, windProg: WebGLProgram, glyphProg: WebGLProgram, atlas: { texture: WebGLTexture; rows: number }, settings: LandingTextureSettings) {
    this.canvas = canvas;
    this.gl = gl;
    this.windProg = windProg;
    this.glyphProg = glyphProg;
    this.atlas = atlas.texture;
    this.atlasRows = atlas.rows;
    this.settings = settings;
    this.state = createFieldState(0);
    this.vao = gl.createVertexArray();
    const heading = (18 + Math.random() * 24) * (Math.PI / 180);
    this.windDir = [Math.cos(heading), Math.sin(heading)];
    this.windSpeed = 42 + Math.random() * 22;
    this.seq = new Int32Array([...SEQUENCE].map((ch) => ATLAS_CHARS.indexOf(ch)));
    this.loseCtx = gl.getExtension("WEBGL_lose_context");
  }

  private now(): number { return performance.now() / 1000 - this.startedAt; }

  resize(cssWidth: number, cssHeight: number): void {
    if (this.destroyed || cssWidth <= 0 || cssHeight <= 0) return;
    this.cssW = cssWidth;
    this.cssH = cssHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    while (cssWidth * dpr * cssHeight * dpr > MAX_DEVICE_PIXELS && dpr > 0.5) dpr -= 0.25;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    const { cols, rows } = gridSize(cssWidth, cssHeight);
    if (cols === this.cols && rows === this.rows && this.windTex) return;
    this.cols = cols;
    this.rows = rows;
    const gl = this.gl;
    if (this.windTex) gl.deleteTexture(this.windTex);
    if (this.windFbo) gl.deleteFramebuffer(this.windFbo);
    this.windTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.windTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, Math.max(cols, 1), Math.max(rows, 1), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.windFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.windFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.windTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setSettings(settings: LandingTextureSettings): void { this.settings = settings; }

  pointerMove(x: number, y: number, pointerType: string): void {
    pointerMove(this.state, x, y, this.now(), pointerType);
  }
  pointerDown(x: number, y: number): void {
    pointerTap(this.state, x, y, this.now(), this.settings.rippleShape);
  }
  pointerLeave(): void { pointerLeave(this.state); }

  private draw(): void {
    const gl = this.gl;
    if (this.destroyed || this.cols <= 0 || this.rows <= 0 || !this.windTex || !this.windFbo) return;
    const t = this.now();
    prune(this.state, t);
    gl.bindVertexArray(this.vao);

    // Pass 1: wind + wakes + taps into the per-cell texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.windFbo);
    gl.viewport(0, 0, this.cols, this.rows);
    gl.useProgram(this.windProg);
    const wu = (name: string) => gl.getUniformLocation(this.windProg, name);
    gl.uniform1f(wu("uTime"), t);
    gl.uniform2f(wu("uSize"), this.cssW, this.cssH);
    gl.uniform2f(wu("uGrid"), this.cols, this.rows);
    gl.uniform2f(wu("uWindDir"), this.windDir[0], this.windDir[1]);
    gl.uniform1f(wu("uWindSpeed"), this.windSpeed);
    const wakes = new Float32Array(48 * 4);
    const segs = new Float32Array(48 * 4);
    this.state.wakes.forEach((w, i) => {
      wakes.set([w.x, w.y, w.force, t - w.at], i * 4);
      segs.set([w.dx, w.dy, w.len, 0], i * 4);
    });
    gl.uniform1i(wu("uWakeCount"), this.state.wakes.length);
    gl.uniform4fv(wu("uWakes[0]"), wakes);
    gl.uniform4fv(wu("uWakeSegs[0]"), segs);
    const taps = new Float32Array(6 * 4);
    this.state.taps.forEach((tap, i) => taps.set([tap.x, tap.y, t - tap.at, tap.shape === "diamond" ? 1 : 0], i * 4));
    gl.uniform1i(wu("uTapCount"), this.state.taps.length);
    gl.uniform4fv(wu("uTaps[0]"), taps);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2: glyphs to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.glyphProg);
    const gu = (name: string) => gl.getUniformLocation(this.glyphProg, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.windTex);
    gl.uniform1i(gu("uWind"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.uniform1i(gu("uAtlas"), 1);
    gl.uniform2f(gu("uSize"), this.cssW, this.cssH);
    gl.uniform2f(gu("uGrid"), this.cols, this.rows);
    gl.uniform1f(gu("uTime"), t);
    gl.uniform1f(gu("uShown"), this.shown);
    gl.uniform1f(gu("uAtlasRows"), this.atlasRows);
    gl.uniform1iv(gu("uSeq[0]"), this.seq);
    gl.uniform1i(gu("uMode"), this.settings.mode === "rainbow" ? 0 : 1);
    const rgb = hexToRgb(this.settings.color) ?? [0.24, 0.94, 0.57];
    gl.uniform3f(gu("uColor"), rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(gu("uRainbowSpeed"), this.settings.rainbowSpeed);
    gl.drawArrays(gl.TRIANGLES, 0, 6 * this.cols * this.rows);
    gl.bindVertexArray(null);
  }

  private loop = (): void => {
    if (!this.running || this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const nowMs = performance.now();
    const t = this.now();
    if (document.hidden || !document.hasFocus()) return;
    if (nowMs - this.lastFrameAt < frameIntervalMs(this.state, t)) return;
    const dt = this.lastFrameAt ? (nowMs - this.lastFrameAt) / 1000 : 0.04;
    this.lastFrameAt = nowMs;
    const target = idleVisibility(this.state, t);
    this.shown = target > this.shown ? Math.min(target, this.shown + dt / 3) : target;
    this.draw();
  };

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.lastFrameAt = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  drawStatic(): void {
    this.shown = 1;
    this.draw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    const gl = this.gl;
    try {
      gl.deleteProgram(this.windProg);
      gl.deleteProgram(this.glyphProg);
      gl.deleteTexture(this.atlas);
      if (this.windTex) gl.deleteTexture(this.windTex);
      if (this.windFbo) gl.deleteFramebuffer(this.windFbo);
      if (this.vao) gl.deleteVertexArray(this.vao);
    } catch { /* context may already be gone */ }
    this.loseCtx?.loseContext();
  }
}

/** Create a renderer, or null when WebGL2 is unavailable or software-rendered. */
export function createLandingRenderer(canvas: HTMLCanvasElement, settings: LandingTextureSettings): LandingRenderer | null {
  try {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl || isSoftwareRenderer(gl)) return null;
    const windProg = program(gl, FULLSCREEN_VERT, WIND_FRAG);
    const glyphProg = program(gl, GLYPH_VERT, GLYPH_FRAG);
    const atlas = buildAtlas(gl);
    if (!windProg || !glyphProg || !atlas) return null;
    return new Renderer(canvas, gl, windProg, glyphProg, atlas, settings);
  } catch {
    return null;
  }
}

