import { useEffect, useState } from "react";
import { SseManager, type SseStatus } from "@/api/sse";
import { apiPaths, RUN_SSE_EVENT_TYPES, type RunSseEvent } from "@shared/api-types";
import { liveRunStore } from "@/stores/liveRunStore";

/**
 * Subscribe to a run's SSE stream and fold every frame into liveRunStore. In
 * mock mode this drives the scripted replay so the run animates. Returns the
 * connection status for a small live/replaying indicator.
 */
export function useRunStream(runId: string | undefined, enabled = true): SseStatus {
  const [status, setStatus] = useState<SseStatus>("idle");

  useEffect(() => {
    if (!runId || !enabled) return;
    const mgr = new SseManager({
      url: apiPaths.runEvents(runId),
      onStatus: setStatus,
    });
    const runEventTypes = new Set<string>(RUN_SSE_EVENT_TYPES);
    mgr.onAny((ev) => {
      if (runEventTypes.has(ev.type)) {
        liveRunStore.ingest(runId, ev as RunSseEvent);
      }
    });
    mgr.connect();
    return () => mgr.close();
  }, [runId, enabled]);

  return status;
}
