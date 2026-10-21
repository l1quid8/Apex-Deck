// React wrapper for the landing texture: canvas lifecycle, pointer
// tracking on the host surface, and the accessibility kill switches.
// Rendering math lives in engine.ts / renderer.ts.

import { useEffect, useRef } from "react";
import { createLandingRenderer } from "./renderer.ts";
import type { LandingTextureSettings } from "../settings.ts";
import "./landing-texture.css";

function blockedByMedia(): "off" | "static" | "live" {
  if (typeof window === "undefined" || !window.matchMedia) return "off";
  if (window.matchMedia("(forced-colors: active)").matches) return "off";
  if (window.matchMedia("(prefers-contrast: more)").matches) return "off";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "static";
  return "live";
}

/** The glyph field behind an empty surface. Renders nothing when disabled
 *  or when the environment asks for no decoration. */
export function LandingTexture({ settings }: { settings: LandingTextureSettings }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const rendererRef = useRef<ReturnType<typeof createLandingRenderer>>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || !settingsRef.current.enabled) return;
    const mode = blockedByMedia();
    if (mode === "off") return;
    // Cached threads can mount under display:none, where offsetParent is null.
    // Choose the surface structurally so listeners still cover the rain when
    // that thread is revealed, rather than staying on the small welcome block.
    const host = wrap.closest<HTMLElement>(".chat-body, .agents-empty") ?? wrap.parentElement;
    if (!host) return;
    const renderer = createLandingRenderer(canvas, settingsRef.current);
    if (!renderer) return;
    rendererRef.current = renderer;

    const resize = () => {
      // Measure the wrap, not the host: the wrap is what the canvas fills, and
      // it grows past the host with `bottom: calc(-1 * var(--composer-h))`.
      // Measuring the host left the backing store at the old size, so the
      // drawing was stretched whenever the composer grew.
      const rect = wrap.getBoundingClientRect();
      renderer.resize(rect.width, rect.height);
      if (mode === "static") renderer.drawStatic();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const toLocal = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onMove = (event: PointerEvent) => {
      const { x, y } = toLocal(event);
      renderer.pointerMove(x, y, event.pointerType);
    };
    // Capture phase, no target filter: a tap anywhere on the empty
    // surface ripples, including over its copy and buttons (the ripple
    // is decoration and never consumes the click), and capture keeps
    // it working where a descendant stops bubble-phase propagation.
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const { x, y } = toLocal(event);
      renderer.pointerDown(x, y);
      if (mode === "static") renderer.drawStatic();
    };
    const onLeave = () => renderer.pointerLeave();
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("pointerleave", onLeave);
    if (mode === "live") renderer.start();

    return () => {
      observer.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("pointerleave", onLeave);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [settings.enabled]);

  // Live settings changes reach the running renderer without a remount.
  useEffect(() => {
    rendererRef.current?.setSettings(settings);
  }, [settings]);

  if (!settings.enabled) return null;
  return (
    <div ref={wrapRef} className="landing-texture-wrap" aria-hidden="true">
      <canvas ref={canvasRef} className="landing-texture" />
    </div>
  );
}
