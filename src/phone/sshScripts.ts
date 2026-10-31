// What Add a machine runs on the server, as plain POSIX sh. Each script does one
// step of the list and reports `key=value` lines, so the phone decides what they
// mean and the tests can run them against a real Linux box.

/** One word for sh, whatever it holds. */
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Where a user-only install lives, and ahead of the system on every step. */
const PATHS = `export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"\n`;

/** The bash login shell a daemon's agents see, so a tool's PATH changes count. */
export const loginShell = (script: string): string => `bash -lc ${shellQuote(script)}`;

export const PROBE = `${PATHS}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "user=$(id -un)"
echo "uid=$(id -u)"
bin=$(command -v apex-daemon || true)
echo "bin=$bin"
[ -n "$bin" ] && echo "version=$("$bin" --version 2>/dev/null | head -n 1)"
[ -d /run/systemd/system ] && echo "systemd=yes"
command -v bwrap >/dev/null 2>&1 && echo "bwrap=yes"
command -v sudo >/dev/null 2>&1 && echo "sudo=yes"
command -v sha256sum >/dev/null 2>&1 && echo "sha256=yes"
if command -v curl >/dev/null 2>&1; then echo "fetch=curl"; elif command -v wget >/dev/null 2>&1; then echo "fetch=wget"; fi
ls /etc/apex-deck-update 2>/dev/null | grep -q . && echo "updater=yes"
exit 0
`;

/** Print a URL to stdout with whichever fetcher the server has. */
export const readUrl = (url: string): string =>
  `if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 30 ${shellQuote(url)}; else wget -qO- --timeout=30 ${shellQuote(url)}; fi`;

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

/** packaging/systemd/apex-daemon@.service, for the machine-wide install. */
const SYSTEM_UNIT = `[Unit]
Description=Apex Deck daemon for %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
ExecStart=/usr/local/bin/apex-daemon serve
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;

const userUnit = (bin: string): string => `[Unit]
Description=Apex Deck daemon

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
export const startSystem = (user: string): string => `set -e
unit=apex-daemon@${user}.service
[ -f /etc/systemd/system/apex-daemon@.service ] || cat > /etc/systemd/system/apex-daemon@.service <<'UNIT'
${SYSTEM_UNIT}UNIT
systemctl daemon-reload
systemctl enable --now "$unit" >/dev/null 2>&1
systemctl is-active "$unit" >/dev/null && echo "service=$unit"
`;

/**
 * Run as the user. A user service dies at sign-out unless lingering is on,
 * which most servers let a person set for themselves. `linger=no` is reported,
 * not hidden, because the machine then drops off when SSH signs out.
 */
export const startUser = (bin: string): string => `set -e
: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
mkdir -p "$HOME/.config/systemd/user"
[ -f "$HOME/.config/systemd/user/apex-daemon.service" ] || cat > "$HOME/.config/systemd/user/apex-daemon.service" <<'UNIT'
${userUnit(bin)}UNIT
loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now apex-daemon.service >/dev/null 2>&1
systemctl --user is-active apex-daemon.service >/dev/null && echo "service=apex-daemon.service"
[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] && echo "linger=yes" || echo "linger=no"
`;

/** A user service with no lingering ends at sign-out, so hand over to a plain process. */
export const STOP_USER_SERVICE = `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
systemctl --user disable --now apex-daemon.service >/dev/null 2>&1
exit 0
`;

/** No systemd or no lingering: run it now, and again at boot from cron when there is one. */
export const startPlain = (bin: string): string => `set -e
pgrep -u "$(id -u)" -x apex-daemon >/dev/null 2>&1 || (setsid nohup ${shellQuote(bin)} serve </dev/null >/dev/null 2>&1 &)
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v 'apex-daemon serve' ; echo "@reboot ${bin} serve" ) | crontab - && echo "boot=cron"
fi
echo "service=plain"
`;

/** What's already running, whichever way it was started. */
export const FIND_SERVICE = `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
user=$(id -un)
if systemctl is-active "apex-daemon@$user.service" >/dev/null 2>&1; then echo "service=apex-daemon@$user.service"; echo "scope=system"
elif systemctl --user is-active apex-daemon.service >/dev/null 2>&1; then echo "service=apex-daemon.service"; echo "scope=user"
elif pgrep -u "$(id -u)" -x apex-daemon >/dev/null 2>&1; then echo "service=plain"; echo "scope=plain"; fi
exit 0
`;

/** Whether only the daemon is alive in the service: nobot and no terminal running. */
const idle = (systemctl: string, service: string): string => `{ group=$(${systemctl} show -p ControlGroup --value ${service}); file="/sys/fs/cgroup$group/cgroup.procs"; [ -r "$file" ] && [ "$(wc -l < "$file")" -le 1 ]; }`;

/**
 * Restart onto the new binary now if nothing's running, otherwise once it's
 * quiet. The wait runs as its own transient service, so it outlives this SSH
 * session and a person's bots finish first.
 */
export const switchVersion = (scope: "system" | "user", service: string): string => {
  const systemctl = scope === "user" ? "systemctl --user" : "systemctl";
  const check = idle(systemctl, service);
  const wait = `until ${check}; do sleep 20; done; ${systemctl} restart ${service}`;
  return `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
if ${check}; then ${systemctl} restart ${service} && echo "switched=now"; exit 0; fi
systemd-run ${scope === "user" ? "--user " : ""}--collect --unit=apex-deck-switch /bin/sh -c ${shellQuote(wait)} >/dev/null 2>&1 || true
echo "switched=later"
`;
};

/** Waits for the daemon to answer, then turns phone access on. */
export const REMOTE_ON = `${PATHS}
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if apex-daemon remote on >/dev/null 2>&1 && apex-daemon remote info 2>/dev/null | grep -q '"enabled": true'; then echo "remote=on"; exit 0; fi
  sleep 1
done
apex-daemon remote info 2>&1 | head -n 3
exit 5
`;

/** The tools a fresh server gets, and what shows each is signed in. */
export const AI_TOOLS = `${PATHS}
arch=$(uname -m); [ "$arch" = arm64 ] && arch=aarch64
if ! command -v claude >/dev/null 2>&1; then
  ${readUrl("https://claude.ai/install.sh")} | bash >/dev/null 2>&1 || true
fi
if ! command -v codex >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1 && [ -w "$(npm prefix -g 2>/dev/null)/lib" ]; then npm install -g @openai/codex >/dev/null 2>&1 || true; fi
fi
if ! command -v codex >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  tmp=$(mktemp -d)
  if ${readUrl("https://github.com/openai/codex/releases/latest/download/codex-${arch}-unknown-linux-musl.tar.gz")} | tar -xz -C "$tmp" 2>/dev/null; then
    mv "$tmp/codex-$arch-unknown-linux-musl" "$HOME/.local/bin/codex" 2>/dev/null && chmod 0755 "$HOME/.local/bin/codex"
  fi
  rm -rf "$tmp"
fi
for tool in claude codex; do command -v "$tool" >/dev/null 2>&1 && echo "$tool=installed" || echo "$tool=missing"; done
[ -s "$HOME/.claude/.credentials.json" ] && echo "claude-login=yes"
[ -s "$HOME/.codex/auth.json" ] && echo "codex-login=yes"
exit 0
`;

export const PAIR = `${PATHS}exec apex-daemon pair --json --tier full`;

/** `key=value` lines into a map. The last of a key wins. */
export function report(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) found[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return found;
}
