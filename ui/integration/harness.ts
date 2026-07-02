/**
 * Integration harness: boots the REAL built `ppd` server on a temp DB + free
 * port, waits for /healthz, and installs a fetch base-URL shim so the UI's
 * relative `/api/...` calls resolve to the live server inside jsdom.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
export async function startServer(): Promise<LiveServer> {
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
