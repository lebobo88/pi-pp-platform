/**
 * Real browser drive for the browser-validation stage.
 *
 * `playwrightDrive` launches headless chromium, navigates each route, and
 * records console errors, page errors, and failed network responses into the
 * core `Finding` shape. `bootDevServer` spawns the project's dev server and
 * waits for it to advertise a local URL. Both are best-effort: callers catch
 * failures and degrade open (record "unavailable", never block the run).
 *
 * The driver is injectable (`BrowserDriver`) so the phase's finding→finalize
 * severity logic is testable with a fake driver — no chromium binary required.
 */
import { spawn } from "node:child_process";
import type { Finding } from "@pp/core";
import type { RuntimeSmokeTestSpec } from "@pp/core";

/** Drives a set of routes against a running base URL and returns findings. */
export type BrowserDriver = (baseUrl: string, routes: string[]) => Promise<Finding[]>;

const DEFAULT_READY = ["Local:", "localhost:", "ready in", "Ready in", "➜", "ready started server", "listening on"];
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?\/?/i;

/**
 * The production driver: headless chromium via Playwright. Requires the
 * `playwright` package AND an installed chromium binary (`npx playwright install
 * chromium`); throws otherwise, which the phase treats as "unavailable".
 */
export const playwrightDrive: BrowserDriver = async (baseUrl, routes) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const findings: Finding[] = [];
  try {
    const context = await browser.newContext();
    for (const route of routes) {
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const networkErrors: Array<{ url: string; status: number }> = [];
      page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
      page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
      page.on("response", (res) => { const s = res.status(); if (s >= 400) networkErrors.push({ url: res.url(), status: s }); });
      // requestfailed is recorded (status 0) for visibility but does NOT by itself
      // fail the route — it fires for benign aborts (favicon, cancelled prefetch).
      page.on("requestfailed", (req) => networkErrors.push({ url: req.url(), status: 0 }));

      const url = baseUrl.replace(/\/+$/, "") + (route.startsWith("/") ? route : `/${route}`);
      let navFailed = false;
      try {
        const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
        if (resp && resp.status() >= 400) networkErrors.push({ url, status: resp.status() });
        await page.waitForTimeout(400); // let late console errors flush
      } catch (err) {
        navFailed = true;
        consoleErrors.push(`[navigation] ${(err as Error).message}`);
      }
      const status: Finding["status"] =
        navFailed || consoleErrors.length > 0 || networkErrors.some((n) => n.status >= 400) ? "fail" : "pass";
      findings.push({ route, step: "load", status, console_errors: consoleErrors, network_errors: networkErrors });
      await page.close();
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return findings;
};

export interface DevServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/**
 * Spawn the project's dev server and resolve once it advertises a local URL.
 * Rejects on timeout or early exit. The caller MUST call stop() to tear it down.
 */
export function bootDevServer(cwd: string, spec: RuntimeSmokeTestSpec | undefined, signal?: AbortSignal): Promise<DevServer> {
  const cmd = spec?.dev_cmd ?? "npm run dev";
  const readyPatterns = spec?.ready_patterns?.length ? spec.ready_patterns : DEFAULT_READY;
  const timeoutMs = spec?.timeout_ms ?? 60_000;

  const child = spawn(cmd, {
    cwd,
    shell: true,
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", CI: "1" },
  });

  const stop = (): Promise<void> =>
    new Promise((res) => {
      try {
        if (process.platform === "win32" && child.pid) {
          // Kill the whole tree — npm/pnpm spawn a child node the dev server runs in.
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", () => res());
        } else {
          child.kill("SIGTERM");
          res();
        }
      } catch {
        res();
      }
    });

  return new Promise<DevServer>((resolve, reject) => {
    let out = "";
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    const timer = setTimeout(() => {
      finish(() => { void stop(); reject(new Error(`dev server ("${cmd}") not ready in ${timeoutMs}ms`)); });
    }, timeoutMs);

    const onData = (buf: Buffer) => {
      out += buf.toString();
      const m = out.match(URL_RE);
      const ready = readyPatterns.some((p) => out.includes(p));
      if (m && ready) {
        finish(() => resolve({ baseUrl: m[0].replace(/\/+$/, ""), stop }));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => finish(() => reject(new Error(`dev server exited (${code}) before ready. Tail: ${out.slice(-300)}`))));
    child.on("error", (err) => finish(() => reject(err)));
    signal?.addEventListener("abort", () => finish(() => { void stop(); reject(new Error("aborted")); }), { once: true });
  });
}
