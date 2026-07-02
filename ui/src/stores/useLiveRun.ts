import { useSyncExternalStore } from "react";
import { liveRunStore, type LogBuffer, type LiveRunOverlay } from "@/stores/liveRunStore";

/** Subscribe to one attempt's append-only log buffer. */
export function useAttemptLog(attemptId: string): LogBuffer {
  return useSyncExternalStore(
    (cb) => liveRunStore.subscribeLog(attemptId, cb),
    () => liveRunStore.getLog(attemptId),
    () => liveRunStore.getLog(attemptId),
  );
}

/** Subscribe to a run's live overlay (status/stage/attempt/verdict/borda/budget). */
export function useLiveRunOverlay(runId: string): LiveRunOverlay {
  return useSyncExternalStore(
    (cb) => liveRunStore.subscribeOverlay(runId, cb),
    () => liveRunStore.getOverlay(runId),
    () => liveRunStore.getOverlay(runId),
  );
}
