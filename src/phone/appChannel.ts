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

export function parseHostChannel(value: unknown): HostChannel | null {
  return value === "stable" || value === "nightly" ? value : null;
}

export function channelFromAppInfo(info: AppInfoResult | null | undefined): HostChannel {
  const explicit = parseHostChannel(info?.channel);
  if (explicit) return explicit;
  if (info?.bundleId === "dev.apexdeck.phone.nightly") return "nightly";
  return "stable";
}

function appInfoPlugin(): AppInfoPlugin | null {
  const fromGlobal = (globalThis as unknown as { Capacitor?: { Plugins?: { ApexAppInfo?: AppInfoPlugin } } }).Capacitor?.Plugins?.ApexAppInfo;
  if (fromGlobal?.getInfo) return fromGlobal;
  if (Capacitor.isPluginAvailable("ApexAppInfo")) return registerPlugin<AppInfoPlugin>("ApexAppInfo");
  return null;
}

/** Sealed channel of the running iOS app, defaulting to "stable" outside iPhone Nightly. */
export function resolveAppChannel(): Promise<HostChannel> {
  const plugin = appInfoPlugin();
  if (!plugin?.getInfo) return Promise.resolve("stable");
  const existing = cache.get(plugin);
  if (existing) return existing;
  const pending: Promise<HostChannel> = plugin.getInfo().then(
    (info) => channelFromAppInfo(info),
    (): HostChannel => "stable",
  );
  cache.set(plugin, pending);
  return pending;
}
