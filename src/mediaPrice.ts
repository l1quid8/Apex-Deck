// Pictures and videos: what a message will cost, and the lines that say so.
// Pure apart from the provider quote, which is cached per model and settings.

import type { ApiModel, MediaSettings, MediaSpec, ParticipantConfig } from './types';
import { imagePrice, mediaKind, resolveMedia, type MediaKind, type ResolvedMedia } from './media.ts';

/** $1.40, or $0.075 under a dollar. */
export function dollars(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3).replace(/(\.\d\d)0$/, '$1') : usd.toFixed(2)}`;
}

/** The sum of the known prices, or null when none is known. */
export function sumPrices(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** The key a provider's model list is kept under. */
export function sourceKey(baseUrl: string, apiKeyEnv: string | null): string {
  return `${baseUrl}\n${apiKeyEnv ?? ''}`;
}

/** The quiet line under a picture or video model in the menu. Empty for text models. */
export function mediaMenuLine(model: ApiModel): string {
  const kind = mediaKind(model);
  if (kind === 'image') {
    const price = imagePrice(model.media ?? {}, resolveMedia('image', model.media ?? {}, null));
    return price != null ? `${dollars(price)} per picture` : 'Price on send';
  }
  if (kind === 'video') return ['Price on send', model.media?.needs_image ? 'Needs a picture' : ''].filter(Boolean).join(' · ');
  return '';
}

/** The price line in settings for a picture model. */
export function pictureLine(spec: MediaSpec, resolved: ResolvedMedia): string {
  const price = imagePrice(spec, resolved);
  return [price != null ? `${dollars(price)} per picture` : 'Price on send', spec.edit_model ? 'edits an attached picture' : ''].filter(Boolean).join(' · ');
}

/** What the provider quotes for a video. Only the price field is read. */
export interface QuoteSource {
  apiQuote(baseUrl: string, apiKeyEnv: string | null, model: string, media: MediaSettings | null): Promise<number | null>;
}

const quotes = new Map<string, Promise<number | null>>();

/** The provider's price for these settings. Asked once per model and settings; a failed ask is not kept. */
export function quoteFor(source: QuoteSource, baseUrl: string, apiKeyEnv: string | null, model: string, media: ResolvedMedia): Promise<number | null> {
  const settings: MediaSettings = {
    aspect_ratio: media.aspect_ratio ?? null,
    resolution: media.resolution ?? null,
    quality: media.quality ?? null,
    duration: media.duration ?? null,
    audio: media.audio ?? null,
  };
  const key = JSON.stringify([baseUrl, apiKeyEnv, model, settings]);
  let hit = quotes.get(key);
  if (!hit) {
    hit = source.apiQuote(baseUrl, apiKeyEnv, model, settings);
    quotes.set(key, hit);
    hit.catch(() => quotes.delete(key));
  }
  return hit;
}

/** A picture or video bot that will get this message. */
export interface MediaSend {
  name: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  model: string;
  kind: MediaKind;
  spec: MediaSpec;
  resolved: ResolvedMedia;
  /** Pictures: the message has pictures attached, and the model edits them. */
  editing: boolean;
  /** The message has a picture attached. */
  hasPicture: boolean;
}

/** The picture and video bots among `ids`, with what each will make for this message. */
export function mediaSendsFor(ids: string[], participants: ParticipantConfig[], lists: Record<string, ApiModel[]>, pictures: boolean): MediaSend[] {
  return ids.flatMap(id => {
    const p = participants.find(x => x.id === id);
    if (!p || p.backend.kind !== 'open_ai_compatible') return [];
    const { base_url: baseUrl, api_key_env: apiKeyEnv, model } = p.backend;
    const found = (lists[sourceKey(baseUrl, apiKeyEnv)] ?? []).find(m => m.id === model);
    const kind = mediaKind(found);
    if (!found || !kind) return [];
    const spec = found.media ?? {};
    return [{ name: p.display_name, baseUrl, apiKeyEnv, model, kind, spec, resolved: resolveMedia(kind, spec, p.media), editing: kind === 'image' && pictures && Boolean(spec.edit_model), hasPicture: pictures }];
  });
}

/** The total for these sends (null when no price is known), and a video bot that needs a picture it does not have. */
export async function priceSend(sends: MediaSend[], source: QuoteSource): Promise<{ usd: number | null; missing: MediaSend | null }> {
  const missing = sends.find(s => s.kind === 'video' && s.spec.needs_image && !s.hasPicture) ?? null;
  const prices = await Promise.all(sends.map(s => s.kind === 'image'
    ? imagePrice(s.spec, s.resolved, s.editing)
    : quoteFor(source, s.baseUrl, s.apiKeyEnv, s.model, s.resolved).catch(() => null)));
  return { usd: sumPrices(prices), missing };
}
