// What Add a machine runs on the server, as plain POSIX sh. Each script does one
// step of the list and reports `key=value` lines, so the phone decides what they
// mean and the tests can run them against a real Linux box.

export type HostChannel = "stable" | "nightly";

export interface ChannelScripts {
  channel: HostChannel;
  product: string;
  daemon: string;
  systemBin: string;
  userBin: string;
  dataDirName: string;
  systemUnitTemplate: string;
  userUnit: string;
  switchUnit: string;
  updaterDir: string;
  feedName: string;
  defaultFeedPath: string;
}

const CHANNELS: Record<HostChannel, ChannelScripts> = {
  stable: {
    channel: "stable",
    product: "Apex Deck",
    daemon: "apex-daemon",
    systemBin: "/usr/local/bin/apex-daemon",
    userBin: "$HOME/.local/bin/apex-daemon",
    dataDirName: "dev.apexdeck.app",
    systemUnitTemplate: "apex-daemon@.service",
    userUnit: "apex-daemon.service",
    switchUnit: "apex-deck-switch",
    updaterDir: "/etc/apex-deck-update",
    feedName: "apex-deck-update.json",
    defaultFeedPath: "latest/download/apex-deck-update.json",
  },
  nightly: {
    channel: "nightly",
    product: "Apex Deck Nightly",
    daemon: "apex-daemon-nightly",
    systemBin: "/usr/local/bin/apex-daemon-nightly",
    userBin: "$HOME/.local/bin/apex-daemon-nightly",
    dataDirName: "dev.apexdeck.app.nightly",
    systemUnitTemplate: "apex-daemon-nightly@.service",
    userUnit: "apex-daemon-nightly.service",
    switchUnit: "apex-deck-nightly-switch",
    updaterDir: "/etc/apex-deck-nightly-update",
    feedName: "apex-deck-nightly-update-linux.json",
    defaultFeedPath: "download/nightly/apex-deck-nightly-update-linux.json",
  },
};

export function hostChannelConfig(channel: HostChannel = "stable"): ChannelScripts {
  const cfg = CHANNELS[channel];
  if (!cfg) throw new Error(`Unsupported Deck channel: ${String(channel)}`);
  return cfg;
}

/** One word for sh, whatever it holds. */
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Where a user-only install lives, and ahead of the system on every step. */
const PATHS = `export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"\n`;

/** The bash login shell a daemon's agents see, so a tool's PATH changes count. */
export const loginShell = (script: string): string => `bash -lc ${shellQuote(script)}`;

/** Probe a Linux host for the target channel's binary, updater, systemd, and tools. */
export const probeScript = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `${PATHS}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "user=$(id -un)"
echo "uid=$(id -u)"
bin=$(command -v ${cfg.daemon} || true)
echo "bin=$bin"
[ -n "$bin" ] && echo "version=$("$bin" --version 2>/dev/null | head -n 1)"
[ -n "$bin" ] && command -v sha256sum >/dev/null 2>&1 && echo "sha256_bin=$(sha256sum "$bin" 2>/dev/null | cut -d' ' -f1)"
[ -d /run/systemd/system ] && echo "systemd=yes"
command -v bwrap >/dev/null 2>&1 && echo "bwrap=yes"
command -v sudo >/dev/null 2>&1 && echo "sudo=yes"
command -v sha256sum >/dev/null 2>&1 && echo "sha256=yes"
if command -v curl >/dev/null 2>&1; then echo "fetch=curl"; elif command -v wget >/dev/null 2>&1; then echo "fetch=wget"; fi
ls ${cfg.updaterDir} 2>/dev/null | grep -q . && echo "updater=yes"
exit 0
`;
};

export const PROBE = probeScript("stable");

export const probeBin = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; command -v ${cfg.daemon}`;
};

/** Print a URL to stdout with whichever fetcher the server has. */
export const readUrl = (url: string, seconds = 30): string =>
  `if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time ${seconds} ${shellQuote(url)}; else wget -qO- --timeout=${seconds} ${shellQuote(url)}; fi`;

export interface InstallPlan {
  url: string;
  sha256: string;
  /** The full path the binary ends up at. */
  target: string;
}

/**
 * Download beside the target, refuse anything whose checksum differs, check it
 * runs, then rename over the old one. The rename leaves a running daemon on
 * the old file, so this never interrupts anyone.
 */
export const install = ({ url, sha256, target }: InstallPlan): string => `set -eu
target=${shellQuote(target)}
mkdir -p "$(dirname "$target")"
fresh="$target.setup-new"
trap 'rm -f "$fresh"' EXIT
if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 600 -o "$fresh" ${shellQuote(url)}; else wget -qO "$fresh" --timeout=600 ${shellQuote(url)}; fi
got=$(sha256sum "$fresh" | cut -d' ' -f1)
if [ "$got" != ${shellQuote(sha256)} ]; then echo "checksum=bad"; exit 3; fi
chmod 0755 "$fresh"
"$fresh" --version >/dev/null
mv -f "$fresh" "$target"
trap - EXIT
echo "installed=yes"
`;

/** Bubblewrap from whichever package manager the server has. Run as root. */
export const INSTALL_BWRAP = `export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq bubblewrap
elif command -v dnf >/dev/null 2>&1; then dnf install -y -q bubblewrap
elif command -v yum >/dev/null 2>&1; then yum install -y -q bubblewrap
elif command -v zypper >/dev/null 2>&1; then zypper -n install bubblewrap
elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed bubblewrap
elif command -v apk >/dev/null 2>&1; then apk add bubblewrap
else echo "no-package-manager"; exit 4; fi >/dev/null 2>&1 || exit $?
command -v bwrap >/dev/null 2>&1
`;

/** packaging/systemd/apex-daemon[-nightly]@.service, for the machine-wide install. */
const systemUnit = (cfg: ChannelScripts): string => `[Unit]
Description=${cfg.product} daemon for %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
ExecStart=${cfg.systemBin} serve
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;

const userUnit = (bin: string, cfg: ChannelScripts): string => `[Unit]
Description=${cfg.product} daemon

[Service]
Type=simple
ExecStart=${bin} serve
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;

/** Run as root. Leaves an existing unit file alone. */
export const startSystem = (user: string, channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `set -e
unit=${cfg.daemon}@${user}.service
[ -f /etc/systemd/system/${cfg.systemUnitTemplate} ] || cat > /etc/systemd/system/${cfg.systemUnitTemplate} <<'UNIT'
${systemUnit(cfg)}UNIT
systemctl daemon-reload
systemctl enable --now "$unit" >/dev/null 2>&1
systemctl is-active "$unit" >/dev/null && echo "service=$unit"
`;
};

/**
 * Run as the user. A user service dies at sign-out unless lingering is on,
 * which most servers let a person set for themselves. `linger=no` is reported,
 * not hidden, because the machine then drops off when SSH signs out.
 */
export const startUser = (bin: string, channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `set -e
: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
mkdir -p "$HOME/.config/systemd/user"
[ -f "$HOME/.config/systemd/user/${cfg.userUnit}" ] || cat > "$HOME/.config/systemd/user/${cfg.userUnit}" <<'UNIT'
${userUnit(bin, cfg)}UNIT
loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now ${cfg.userUnit} >/dev/null 2>&1
systemctl --user is-active ${cfg.userUnit} >/dev/null && echo "service=${cfg.userUnit}"
[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] && echo "linger=yes" || echo "linger=no"
`;
};

/** A user service with no lingering ends at sign-out, so hand over to a plain process. */
export const stopUserService = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
systemctl --user disable --now ${cfg.userUnit} >/dev/null 2>&1
exit 0
`;
};

export const STOP_USER_SERVICE = stopUserService("stable");

// Linux truncates /proc/<pid>/comm at 15 chars ("apex-daemon-nig"), so Nightly
// matches the full command line for `<daemon> serve` instead of `-x`.
const plainRunningCheck = (cfg: ChannelScripts): string =>
  cfg.channel === "nightly"
    ? `pgrep -u "$(id -u)" -f '(^|/)${cfg.daemon} serve([[:space:]]|$)'`
    : `pgrep -u "$(id -u)" -x ${cfg.daemon}`;

/** No systemd or no lingering: run it now, and again at boot from cron when there is one. */
export const startPlain = (bin: string, channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `set -e
${plainRunningCheck(cfg)} >/dev/null 2>&1 || (setsid nohup ${shellQuote(bin)} serve </dev/null >/dev/null 2>&1 &)
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v -E '(^|/)${cfg.daemon} serve([[:space:]]|$)' ; echo "@reboot ${bin} serve" ) | crontab - && echo "boot=cron"
fi
echo "service=plain"
`;
};

/** What's already running for this channel, whichever way it was started. */
export const findService = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
user=$(id -un)
if systemctl is-active "${cfg.daemon}@$user.service" >/dev/null 2>&1; then echo "service=${cfg.daemon}@$user.service"; echo "scope=system"
elif systemctl --user is-active ${cfg.userUnit} >/dev/null 2>&1; then echo "service=${cfg.userUnit}"; echo "scope=user"
elif ${plainRunningCheck(cfg)} >/dev/null 2>&1; then echo "service=plain"; echo "scope=plain"; fi
exit 0
`;
};

export const FIND_SERVICE = findService("stable");

/** Whether only the daemon is alive in the service: nobot and no terminal running. */
const idle = (systemctl: string, service: string): string => `{ group=$(${systemctl} show -p ControlGroup --value ${service}); file="/sys/fs/cgroup$group/cgroup.procs"; [ -r "$file" ] && [ "$(wc -l < "$file")" -le 1 ]; }`;

/**
 * Restart onto the new binary now if nothing's running, otherwise once it's
 * quiet. The wait runs as its own transient service, so it outlives this SSH
 * session and a person's bots finish first.
 */
export const switchVersion = (scope: "system" | "user", service: string, channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  const systemctl = scope === "user" ? "systemctl --user" : "systemctl";
  const check = idle(systemctl, service);
  const wait = `until ${check}; do sleep 20; done; ${systemctl} restart ${service}`;
  return `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
if ${check}; then ${systemctl} restart ${service} && echo "switched=now"; exit 0; fi
systemd-run ${scope === "user" ? "--user " : ""}--collect --unit=${cfg.switchUnit} /bin/sh -c ${shellQuote(wait)} >/dev/null 2>&1 || true
echo "switched=later"
`;
};

/** Waits for this channel's daemon to answer, then turns phone access on. */
export const remoteOn = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `${PATHS}
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if ${cfg.daemon} remote on >/dev/null 2>&1 && ${cfg.daemon} remote info 2>/dev/null | grep -q '"enabled": true'; then echo "remote=on"; exit 0; fi
  sleep 1
done
${cfg.daemon} remote info 2>&1 | head -n 3
exit 5
`;
};

export const REMOTE_ON = remoteOn("stable");

/** Resolve the channel's Linux data directory once, matching apex-daemon's XDG and Stable legacy-store rules. */
const channelDataDir = (cfg: ChannelScripts): string => {
  const base = `data_root="\${XDG_DATA_HOME:-$HOME/.local/share}"; case "$data_root" in /*) ;; *) data_root="$HOME/.local/share" ;; esac; data_dir="\${data_root%/}/${cfg.dataDirName}"`;
  if (cfg.channel !== "stable") return base;
  const desktopHasData = `[ -d "$data_dir/saved-chats-v1" ] && ls -A "$data_dir/saved-chats-v1" 2>/dev/null | grep -q .`;
  const legacyHasData = `[ -d "$legacy_dir/saved-chats-v1" ] && ls -A "$legacy_dir/saved-chats-v1" 2>/dev/null | grep -q .`;
  const markerSelectsLegacy = `[ -f "$marker" ] && [ ! -L "$marker" ] && [ -r "$marker" ] && size=$(wc -c < "$marker" 2>/dev/null | tr -d '[:space:]') && [ -n "$size" ] && [ "$size" -le 4096 ] && grep -Eq '"version"[[:space:]]*:[[:space:]]*1([^0-9.]|$)' "$marker" && grep -Eq '"store"[[:space:]]*:[[:space:]]*"legacy-cli"' "$marker" && ! grep -Eq '"store"[[:space:]]*:[[:space:]]*"desktop"' "$marker"`;
  return `${base}; if [ -n "\${HOME:-}" ]; then legacy_dir="\${HOME%/}/.apex"; marker="$data_dir/shared-store-v1.json"; if [ -e "$marker" ] || [ -L "$marker" ]; then if ${markerSelectsLegacy} && [ -d "$legacy_dir" ]; then data_dir="$legacy_dir"; fi; elif ! { ${desktopHasData}; } && ${legacyHasData}; then data_dir="$legacy_dir"; fi; fi`;
};

/** Check whether this channel's data folder already exists before Deck starts. */
export const dataFolderCheck = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `${channelDataDir(cfg)}; if [ -d "$data_dir" ]; then printf '%s\\n' "$data_dir"; else echo __nodata__; fi`;
};

/** Read this channel's host-trust.json, if present. */
export const trustCheckScript = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `${channelDataDir(cfg)}; if [ -r "$data_dir/host-trust.json" ]; then cat "$data_dir/host-trust.json" || echo __notrust__; else echo __notrust__; fi`;
};

/** Mark this channel's host trusted without rebooting. */
export const trustHostCommand = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `${probeBin(channel)} >/dev/null 2>&1 && ${cfg.daemon} trust-host --no-reboot 2>&1 || ${cfg.userBin} trust-host --no-reboot 2>&1 || ${cfg.systemBin} trust-host --no-reboot 2>&1`;
};

/** The tools a fresh server gets, and what shows each is signed in. */
export const AI_TOOLS = `${PATHS}
arch=$(uname -m); [ "$arch" = arm64 ] && arch=aarch64
if ! command -v claude >/dev/null 2>&1; then
  ${readUrl("https://claude.ai/install.sh", 200)} | bash >/dev/null 2>&1 || true
fi
if ! command -v codex >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1 && [ -w "$(npm prefix -g 2>/dev/null)/lib" ]; then npm install -g @openai/codex >/dev/null 2>&1 || true; fi
fi
if ! command -v codex >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  tmp=$(mktemp -d)
  url="https://github.com/openai/codex/releases/latest/download/codex-$arch-unknown-linux-musl.tar.gz"
  if { curl -fsSL --max-time 200 "$url" 2>/dev/null || wget -qO- --timeout=200 "$url"; } | tar -xz -C "$tmp" 2>/dev/null; then
    mv "$tmp/codex-$arch-unknown-linux-musl" "$HOME/.local/bin/codex" 2>/dev/null && chmod 0755 "$HOME/.local/bin/codex"
  fi
  rm -rf "$tmp"
fi
for tool in claude codex; do command -v "$tool" >/dev/null 2>&1 && echo "$tool=installed" || echo "$tool=missing"; done
[ -s "$HOME/.claude/.credentials.json" ] && echo "claude-login=yes"
[ -s "$HOME/.codex/auth.json" ] && echo "codex-login=yes"
exit 0
`;

export const pairCommand = (channel: HostChannel = "stable"): string => {
  const cfg = hostChannelConfig(channel);
  return `${PATHS}exec ${cfg.daemon} pair --json`;
};

export const PAIR = pairCommand("stable");

/** `key=value` lines into a map. The last of a key wins. */
export function report(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) found[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return found;
}
