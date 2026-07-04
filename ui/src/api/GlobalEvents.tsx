import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SseManager } from "@/api/sse";
import { apiPaths } from "@shared/api-types";
import { qk } from "@/api/queryKeys";
import { toast } from "@/stores/uiStore";
import { liveRunStore } from "@/stores/liveRunStore";
import { useAuthStore } from "@/stores/authStore";

/**
 * Opens the global SSE stream for the app's lifetime and folds events into the
 * query cache + live store. Mount once near the root. Resilient: the manager
 * auto-reconnects with backoff, so a missing daemon just retries quietly.
 */
export function GlobalEvents() {
  const qc = useQueryClient();
  // Token in deps: SseManager reads it at connect time, so a token change must
  // tear the stream down and reopen it with the new `?token=`.
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    const mgr = new SseManager({ url: apiPaths.events });

    mgr.on("run.created", () => qc.invalidateQueries({ queryKey: ["runs"] }));
    mgr.on("run.queued", (ev) => {
      toast({ tone: "info", title: "Run queued", message: `${ev.data.mode} · behind the concurrency cap` });
    });
    mgr.on("run.status", (ev) => {
      liveRunStore.setStatus(ev.data.run_id, ev.data.status);
      qc.invalidateQueries({ queryKey: ["runs"] });
    });
    mgr.on("run.finalized", (ev) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: qk.run(ev.data.run_id) });
      toast({ tone: ev.data.status === "complete" ? "success" : "warn", title: "Run finalized", message: `${ev.data.run_id} · ${ev.data.status}` });
    });
    mgr.on("budget.tripwire", (ev) => {
      qc.invalidateQueries({ queryKey: qk.budgets });
      toast({
        tone: ev.data.action === "block" ? "error" : "warn",
        title: `Budget tripwire · ${Math.round(ev.data.pct * 100)}%`,
        message: `${ev.data.scope} — ${ev.data.action}`,
      });
    });
    mgr.on("provider.status", () => qc.invalidateQueries({ queryKey: qk.providers }));
    mgr.on("doctor.result", () => qc.invalidateQueries({ queryKey: qk.doctor }));
    mgr.on("evolution.proposal.created", () => {
      qc.invalidateQueries({ queryKey: qk.evolution });
      toast({ tone: "info", title: "New evolution proposal" });
    });
    mgr.on("janitor.result", () => qc.invalidateQueries({ queryKey: ["runs"] }));

    mgr.connect();
    return () => mgr.close();
  }, [qc, token]);

  return null;
}
