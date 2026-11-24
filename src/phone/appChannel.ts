// Resolves the sealed iOS app channel ("stable" | "nightly") from the native
// ApexAppInfo plugin exposed by iphone/App/App/SceneDelegate.swift.

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { HostChannel } from "./sshScripts.ts";

export interface AppInfoResult {
  bundleId?: string;
  channel?: string;
  displayName?: string;
  urlScheme?: string;
  pushTopic?: string;
}

export interface AppInfoPlugin {
  getInfo(): Promise<AppInfoResult>;
}

const cache = new WeakMap<AppInfoPlugin, Promise<HostChannel>>();
let registeredPlugin: AppInfoPlugin | null = null;

export function parseHostChannel(value: unknown): HostChannel | null {
  return value === "stable" || value === "nightly" ? value : null;
}

/**
 * Strict verification of native ApexAppInfo payloads. Returns null if the
 * payload is missing, unrecognized, or internally contradictory.
 */
export function verifiedChannelFromAppInfo(info: AppInfoResult | null | undefined): HostChannel | null {
  if (!info || typeof info !== "object") return null;
  const hasChannel = info.channel !== undefined && info.channel !== null && info.channel !== "";
  const explicit = hasChannel ? parseHostChannel(info.channel) : null;
  if (hasChannel && !explicit) return null;

  const hasBundle = info.bundleId !== undefined && info.bundleId !== null && info.bundleId !== "";
  const fromBundle: HostChannel | null =
    info.bundleId === "dev.apexdeck.phone.nightly"
      ? "nightly"
      : info.bundleId === "dev.apexdeck.phone"
        ? "stable"
        : null;
  if (hasBundle && !fromBundle) return null;
  if (explicit && fromBundle && explicit !== fromBundle) return null;
  return explicit ?? fromBundle;
}

export function channelFromAppInfo(info: AppInfoResult | null | undefined): HostChannel {
  const explicit = parseHostChannel(info?.channel);
  if (explicit) return explicit;
  if (info?.bundleId === "dev.apexdeck.phone.nightly") return "nightly";
  return "stable";
}

function isNativePlatform(): boolean {
  const g = globalThis as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
    webkit?: { messageHandlers?: { bridge?: unknown } };
  };
  if (typeof g.Capacitor?.isNativePlatform === "function") return Boolean(g.Capacitor.isNativePlatform());
  if (typeof g.Capacitor?.getPlatform === "function") return g.Capacitor.getPlatform() !== "web";
  if (g.webkit?.messageHandlers?.bridge) return true;
  return Capacitor.isNativePlatform();
}

function appInfoPlugin(): AppInfoPlugin | null {
  const fromGlobal = (globalThis as unknown as { Capacitor?: { Plugins?: { ApexAppInfo?: AppInfoPlugin } } }).Capacitor?.Plugins?.ApexAppInfo;
  if (fromGlobal?.getInfo) return fromGlobal;
  if (Capacitor.isPluginAvailable("ApexAppInfo")) {
    registeredPlugin ??= registerPlugin<AppInfoPlugin>("ApexAppInfo");
    return registeredPlugin;
  }
  return null;
}

/**
 * Sealed channel of the running iOS app.
 *
 * On native iOS (or whenever the ApexAppInfo bridge is present), fails closed
 * if identity cannot be verified and never caches a rejection so a subsequent
 * retry can succeed. Outside native mobile builds, defaults to "stable".
 */
export function resolveAppChannel(): Promise<HostChannel> {
  const plugin = appInfoPlugin();
  if (!plugin?.getInfo) {
    if (isNativePlatform()) {
      return Promise.reject(
        new Error("Couldn't verify whether this app is Stable or Nightly because the native app identity bridge isn't available. Try again."),
      );
    }
    return Promise.resolve("stable");
  }
  const existing = cache.get(plugin);
  if (existing) return existing;
  const pending: Promise<HostChannel> = Promise.resolve()
    .then(() => plugin.getInfo())
    .then(
      (info) => {
        const verified = verifiedChannelFromAppInfo(info);
        if (!verified) {
          if (cache.get(plugin) === pending) cache.delete(plugin);
          throw new Error("Couldn't verify whether this app is Stable or Nightly. Try again.");
        }
        return verified;
      },
      (error) => {
        if (cache.get(plugin) === pending) cache.delete(plugin);
        const detail = error instanceof Error ? error.message : String(error ?? "").trim();
        throw new Error(
          detail
            ? `Couldn't verify whether this app is Stable or Nightly (${detail}). Try again.`
            : "Couldn't verify whether this app is Stable or Nightly. Try again.",
        );
      },
    );
  cache.set(plugin, pending);
  return pending;
}
