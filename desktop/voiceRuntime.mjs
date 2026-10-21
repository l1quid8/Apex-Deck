import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
const digest = async (file) => {
  const hash = crypto.createHash("sha256");
  for await (const b of createReadStream(file)) hash.update(b);
  return hash.digest("hex");
};
export async function downloadVerified(
  item,
  destination,
  {
    signal,
    progress = () => {},
    fetch: fetcher = globalThis.fetch,
    local,
  } = {},
) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (await fs.stat(destination).catch(() => null)) {
    if ((await digest(destination)) === item.sha256) {
      progress(item.size);
      return;
    }
    await fs.rm(destination);
  }
  const temporary = destination + ".partial";
  try {
    let input;
    if (local) input = createReadStream(local);
    else {
      const response = await fetcher(item.url, {
        signal: signal ?? AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw Error(`Voice download failed (${response.status})`);
      input = Readable.fromWeb(response.body);
    }
    let received = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > item.size + 1024)
          cb(Error("Voice download exceeds manifest size"));
        else {
          progress(chunk.length);
          cb(null, chunk);
        }
      },
    });
    await pipeline(input, count, createWriteStream(temporary), { signal });
    if ((await digest(temporary)) !== item.sha256)
      throw Error("Voice download hash mismatch");
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function acquireInstallLock(lock) {
  const owner = { pid: process.pid, id: crypto.randomUUID() };
  try {
    await fs.mkdir(lock);
  } catch {
    const existing = await fs
      .readFile(path.join(lock, "owner.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    let alive = true;
    if (Number.isInteger(existing?.pid)) {
      try {
        process.kill(existing.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
    } else {
      const stat = await fs.stat(lock);
      alive = Date.now() - stat.mtimeMs < 300000;
    }
    if (alive) throw Error("Voice setup is already running.");
    const stale = lock + ".stale-" + crypto.randomUUID();
    await fs.rename(lock, stale);
    await fs.rm(stale, { recursive: true, force: true });
    await fs.mkdir(lock);
  }
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify(owner));
  return async () => {
    const current = await fs
      .readFile(path.join(lock, "owner.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (current?.id === owner.id)
      await fs.rm(lock, { recursive: true, force: true });
  };
}
function execute(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let detail = "";
    child.stderr.on("data", (b) => {
      detail = (detail + b.toString()).slice(-2000);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error(`Voice setup command failed (${code}): ${detail}`)),
    );
  });
}
export class VoiceRuntimeManager {
  constructor({
    root,
    source,
    origins = ["app://deck", "null"],
    platform = process.platform,
    arch = process.arch,
    progress = () => {},
  }) {
    Object.assign(this, { root, source, origins, platform, arch, progress });
    this.owner = null;
    this.child = null;
    this.installing = null;
    this.abort = null;
    this.idle = null;
    this.starting = null;
  }
  async manifest() {
    return JSON.parse(
      await fs.readFile(
        path.join(this.source, "runtime-manifest.json"),
        "utf8",
      ),
    );
  }
  async status() {
    const supported = this.platform === "darwin" && this.arch === "arm64";
    const manifest = await this.manifest().catch(() => null);
    const version = manifest?.version ?? "1";
    const installed = !!(await fs
      .stat(path.join(this.root, version, "complete.json"))
      .catch(() => null));
    return {
      supported,
      installed,
      installing: !!this.installing,
      downloadBytes: manifest?.downloadBytes ?? 0,
      requiredDiskBytes: manifest?.requiredDiskBytes ?? 0,
    };
  }
  async install() {
    if (this.installing) return this.installing;
    if (!(await this.status()).supported)
      throw Error("Local voice requires Apple Silicon macOS");
    this.abort = new AbortController();
    this.installing = this.performInstall(this.abort.signal);
    try {
      return await this.installing;
    } finally {
      this.installing = null;
      this.abort = null;
    }
  }
  cancelInstall() {
    this.abort?.abort();
  }
  async performInstall(signal) {
    const manifest = await this.manifest();
    await fs.mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, "install.lock");
    const releaseLock = await acquireInstallLock(lock);
    const stage = path.join(this.root, manifest.version + ".staging");
    const final = path.join(this.root, manifest.version);
    let downloaded = 0;
    const report = (bytes = 0, stageName = "Downloading local voice") => {
      downloaded += bytes;
      this.progress({
        stage: stageName,
        downloaded,
        total: manifest.downloadBytes,
      });
    };
    try {
      const previous = manifest.previousVersion
        ? path.join(this.root, manifest.previousVersion)
        : null;
      const reuse = async (relative, item) => {
        const file = previous && path.join(previous, relative);
        return file &&
          (await fs.stat(file).catch(() => null)) &&
          (await digest(file)) === item.sha256
          ? { local: file }
          : {};
      };
      const disk = await fs.statfs(this.root);
      if (disk.bavail * disk.bsize < manifest.requiredDiskBytes)
        throw Error("Not enough disk space for local voice setup");
      await fs.mkdir(stage, { recursive: true });
      const cache = path.join(this.root, "downloads");
      await fs.mkdir(cache, { recursive: true });
      const archive = path.join(cache, "python.tar.gz");
      await downloadVerified(manifest.python, archive, {
        signal,
        progress: (n) => report(n),
      });
      if (signal.aborted) throw Error("Voice setup canceled");
      report(0, "Installing private Python runtime");
      await execute("/usr/bin/tar", ["-xzf", archive, "-C", stage], { signal });
      const python = path.join(stage, "python", "bin", "python3");
      const wheels = path.join(stage, "wheels");
      await fs.mkdir(wheels, { recursive: true });
      for (const item of manifest.wheels) {
        const file = path.join(wheels, item.filename);
        await downloadVerified(item, file, {
          signal,
          progress: (n) => report(n),
          ...(item.bundled
            ? { local: path.join(this.source, "wheels", item.filename) }
            : await reuse(path.join("wheels", item.filename), item)),
        });
      }
      report(0, "Installing speech engines");
      const environment = {
        ...process.env,
        PIP_NO_INDEX: "1",
        PYTHONNOUSERSITE: "1",
      };
      await execute(
        python,
        [
          "-I",
          "-m",
          "pip",
          "install",
          "--no-index",
          "--no-deps",
          ...manifest.wheels.map((w) => path.join(wheels, w.filename)),
        ],
        { signal, env: environment },
      );
      for (const item of manifest.models) {
        if (!item.path.startsWith("models/") || item.path.includes(".."))
          throw Error("Invalid model manifest");
        await downloadVerified(item, path.join(stage, item.path), {
          signal,
          progress: (n) => report(n),
          ...(await reuse(item.path, item)),
        });
      }
      report(0, "Verifying local speech imports");
      await execute(
        python,
        [
          "-I",
          "-c",
          'import mlx.core, mlx_whisper, mlx_audio, silero_vad, websockets; print("ok")',
        ],
        { signal, env: environment },
      );
      await fs.writeFile(
        path.join(stage, "complete.json"),
        JSON.stringify({
          version: manifest.version,
          manifestHash: crypto
            .createHash("sha256")
            .update(JSON.stringify(manifest))
            .digest("hex"),
        }),
      );
      if (signal.aborted) throw Error("Voice setup canceled");
      // Never replace a valid installed version in place. Versions are immutable.
      if (await fs.stat(final).catch(() => null))
        throw Error(
          "This runtime version already exists; update the runtime manifest version before replacing it",
        );
      await fs.rename(stage, final);
      report(0, "Ready");
      return this.status();
    } finally {
      await releaseLock();
    }
  }
  async start(owner) {
    if (!(await this.status()).supported)
      throw Error("Local voice requires Apple Silicon macOS");
    if (this.owner !== null && this.owner !== owner)
      throw Error("A voice call is already open in another window");
    this.owner = owner;
    clearTimeout(this.idle);
    if (this.starting) return this.starting;
    if (this.connection) return this.connection;
    this.starting = this.launch();
    try {
      return await this.starting;
    } catch (e) {
      this.owner = null;
      throw e;
    } finally {
      this.starting = null;
    }
  }
  async launch() {
    if (!(await this.status()).installed)
      throw Error("Set up local voice first");
    const manifest = await this.manifest();
    const root = path.join(this.root, manifest.version);
    const token = crypto.randomBytes(32).toString("hex");
    // The entry module is our signed app resource; the private runtime is writable data.
    const bootstrap =
      'import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("voice_sidecar.server",run_name="__main__")';
    const child = spawn(
      path.join(root, "python/bin/python3"),
      [
        "-I",
        "-c",
        bootstrap,
        this.source,
        "--root",
        root,
        "--token-fd",
        "0",
        ...this.origins.flatMap((x) => ["--origin", x]),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: process.env.HOME,
          PATH: "/usr/bin:/bin",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HOME: path.join(root, "cache"),
          PYTHONNOUSERSITE: "1",
          TOKENIZERS_PARALLELISM: "false",
        },
      },
    );
    this.child = child;
    child.stdin.end(token + "\n");
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Local voice warmup timed out"));
      }, 90000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) {
          child.kill();
          reject(Error("Invalid helper handshake"));
          return;
        }
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          try {
            const m = JSON.parse(line);
            if (
              m.type === "ready" &&
              m.protocolVersion === 1 &&
              Number.isInteger(m.port) &&
              m.port > 0 &&
              m.port < 65536
            ) {
              clearTimeout(timer);
              this.connection = { port: m.port, token, protocolVersion: 1 };
              resolve(this.connection);
            }
          } catch {}
        }
      });
      child.stderr.on("data", () => {}); // Never print session content or credentials.
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        this.child = null;
        this.connection = null;
        this.owner = null;
        reject(Error("Local voice helper stopped"));
      });
    });
  }
  async stop(owner) {
    if (this.owner !== owner) return;
    this.owner = null;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.shutdown(), 120000);
    this.idle.unref?.();
  }
  async shutdown() {
    clearTimeout(this.idle);
    this.abort?.abort();
    this.child?.kill();
    this.connection = null;
    this.child = null;
    this.owner = null;
  }
}
