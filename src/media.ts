// Image and video bots: the choices actually sent and what a message costs.
// Must match `resolve` in crates/apex-adapters/src/media.rs.

import type { ApiModel, MediaSettings, MediaSpec } from "./types";

export type MediaKind = "image" | "video";

/** The kind of a provider model, or null for a text model. */
export function mediaKind(model: ApiModel | undefined | null): MediaKind | null {
  return model?.kind === "image" || model?.kind === "video" ? model.kind : null;
}

export interface ResolvedMedia {
  aspect_ratio?: string;
  resolution?: string;
  quality?: string;
  duration?: string;
  /** Sent only when the model lets sound be switched. */
  audio?: boolean;
  build_on_last: boolean;
}

const seconds = (d: string) => Number.parseFloat(d) || 0;

/** The saved choice when the model lists it, otherwise the default. Unlisted settings are left out. */
export function resolveMedia(kind: MediaKind, spec: MediaSpec, saved: MediaSettings | null | undefined): ResolvedMedia {
  const s = saved ?? {};
  const pick = (list: string[] | undefined, chosen: string | null | undefined, ...fallbacks: (string | null | undefined)[]) => {
    if (!list?.length) return undefined;
    if (chosen && list.includes(chosen)) return chosen;
    return fallbacks.find((f): f is string => Boolean(f) && list.includes(f!)) ?? list[0];
  };
  const durations = spec.durations ?? [];
  const atLeastFive = [...durations].sort((a, b) => seconds(a) - seconds(b)).find((d) => seconds(d) >= 5);
  const out: ResolvedMedia = { build_on_last: s.build_on_last ?? true };
  const aspect = pick(spec.aspect_ratios, s.aspect_ratio, kind === "video" ? "16:9" : null, spec.default_aspect_ratio);
  const resolution = pick(spec.resolutions, s.resolution, kind === "video" ? "720p" : null, spec.default_resolution);
  const quality = pick(spec.qualities, s.quality, spec.default_quality);
  const duration = pick(durations, s.duration, atLeastFive);
  if (aspect) out.aspect_ratio = aspect;
  if (resolution) out.resolution = resolution;
  if (quality) out.quality = quality;
  if (duration) out.duration = duration;
  if (kind === "video" && spec.audio && spec.audio_configurable) out.audio = s.audio ?? true;
  return out;
}

/** Dollars per picture for these choices, or null when the model lists no price. */
export function imagePrice(spec: MediaSpec, resolved: ResolvedMedia, editing = false): number | null {
  if (editing && spec.edit_price != null) return spec.edit_price;
  const prices = spec.prices ?? {};
  if (resolved.resolution && resolved.quality && prices[`${resolved.resolution}/${resolved.quality}`] != null) return prices[`${resolved.resolution}/${resolved.quality}`];
  if (resolved.resolution && prices[resolved.resolution] != null) return prices[resolved.resolution];
  return spec.price ?? null;
}

/** "~$0.04", "~$1.44". */
export function priceLabel(usd: number): string {
  return `~$${usd < 0.1 ? usd.toFixed(3).replace(/0$/, "") : usd.toFixed(2)}`;
}
