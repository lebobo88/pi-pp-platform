/**
 * Integration harness: boots the REAL built `ppd` server on a temp DB + free
 * port, waits for /healthz, and installs a fetch base-URL shim so the UI's
 * relative `/api/...` calls resolve to the live server inside jsdom.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as nodeHttp from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", ".."); // ui/integration → ui → repo root
export const PPD_BIN = join(REPO_ROOT, "packages", "server", "dist", "bin", "ppd.js");

export interface LiveServer {
  base: string; // http://127.0.0.1:<port>
  port: number;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base: string, timeoutMs = 25_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy at ${base}: ${String(lastErr)}`);
}

/** Boot ppd. Throws a clear error if the server dist is missing (build first). */
export async function startServer(extraEnv: Record<string, string> = {}): Promise<LiveServer> {
  if (!existsSync(PPD_BIN)) {
    throw new Error(`ppd not built at ${PPD_BIN} — run \`pnpm -F @pp/server build\` first`);
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbDir = mkdtempSync(join(tmpdir(), "pp-m5f-"));
  const dbPath = join(dbDir, "state.db");

  const child: ChildProcess = spawn(process.execPath, [PPD_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PP_DB_PATH: dbPath,
      PP_PORT: String(port),
      PP_UI_DIST: "", // do not serve the SPA in the test
      PP_ECOSYSTEM: "", // keep the ecosystem guard off
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (c) => {
    stderrTail = (stderrTail + c.toString()).slice(-2000);
  });
  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? -1;
  });

  try {
    await waitForHealth(base);
  } catch (e) {
    killTree(child.pid);
    throw new Error(`${(e as Error).message}\nexit=${exited}\nstderr:\n${stderrTail}`);
  }

  const stop = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        try {
          rmSync(dbDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        resolve();
      };
      if (child.exitCode !== null) return done();
      child.once("exit", done);
      killTree(child.pid);
      setTimeout(done, 3000); // last-resort resolve so afterAll never hangs
    });

  return { base, port, stop };
}

/**
 * Minimal Node EventSource polyfill for jsdom integration tests. Connects to
 * the live server (relative `/api` URLs are prefixed with `base`), parses the
 * text/event-stream, and dispatches named events the way the UI's SseManager
 * expects (addEventListener(type) + onmessage).
 */
export function installEventSource(base: string): () => void {
  const prev = (globalThis as { EventSource?: unknown }).EventSource;
  class NodeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    private listeners = new Map<string, Set<(e: { data: string; lastEventId: string }) => void>>();
    private req: nodeHttp.ClientRequest | null = null;
    private closed = false;

    constructor(url: string) {
      this.url = url.startsWith("http") ? url : base + url;
      this.req = nodeHttp.get(this.url, (res: nodeHttp.IncomingMessage) => {
        this.readyState = 1;
        this.onopen?.();
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this.dispatchBlock(block);
          }
        });
        res.on("end", () => { if (!this.closed) this.onerror?.(); });
      });
      this.req.on("error", () => { if (!this.closed) this.onerror?.(); });
    }

    private dispatchBlock(block: string): void {
      let type = "message";
      let data = "";
      let id = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
      }
      if (!data) return; // heartbeat comment
      const ev = { data, lastEventId: id, type } as { data: string; lastEventId: string };
      this.listeners.get(type)?.forEach((fn) => fn(ev));
      if (type === "message") this.onmessage?.(ev);
    }

    addEventListener(type: string, fn: (e: { data: string; lastEventId: string }) => void): void {
      let set = this.listeners.get(type);
      if (!set) { set = new Set(); this.listeners.set(type, set); }
      set.add(fn);
    }
    removeEventListener(type: string, fn: (e: { data: string; lastEventId: string }) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    close(): void {
      this.closed = true;
      this.readyState = 2;
      this.req?.destroy();
    }
  }
  (globalThis as { EventSource?: unknown }).EventSource = NodeEventSource as unknown;
  return () => { (globalThis as { EventSource?: unknown }).EventSource = prev; };
}

/**
 * Create a throwaway git project (init + one commit) for run-control tests.
 * `deep: true` nests the repo under many segments so the URL-encoded path is
 * long (>100 chars) — exercises the server's raised Fastify maxParamLength.
 */
export function makeTempGitProject(opts: { deep?: boolean } = {}): string {
  let dir = mkdtempSync(join(tmpdir(), "pp-e2e-proj-"));
  if (opts.deep) {
    dir = join(dir, "a", "very", "deeply", "nested", "example", "workspace", "packages", "app", "project-root");
    mkdirSync(dir, { recursive: true });
  }
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@pp.local", "-c", "user.name=pp-test", ...args], { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# temp\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  // Forward slashes so the path round-trips through the wire + URL encoding.
  return dir.replace(/\\/g, "/");
}

/** Reliable process-tree kill (Windows taskkill /T, POSIX SIGKILL). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Install a fetch shim that rewrites relative `/api` and `/healthz` requests to
 * the live server. Returns an uninstall fn. Used so the UI (which fetches
 * relative paths) hits the real daemon inside jsdom.
 */
export function installFetchBase(base: string): () => void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && (input.startsWith("/api") || input.startsWith("/healthz"))) {
      return real(`${base}${input}`, init);
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
