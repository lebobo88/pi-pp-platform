import { useSyncExternalStore } from "react";
import { fleetStore, type FleetSnapshot, type FleetEntry } from "@/stores/fleetStore";

/**
 * Subscribe to the entire fleet snapshot.
 * The snapshot object only changes identity on mutation so React only
 * re-renders when something actually changed.
 */
export function useFleet(): FleetSnapshot {
  return useSyncExternalStore(
    (cb) => fleetStore.subscribe(cb),
    () => fleetStore.getSnapshot(),
    () => fleetStore.getSnapshot(),
  );
}

/** Convenience: get one run's fleet entry (or undefined). */
export function useFleetEntry(runId: string): FleetEntry | undefined {
  const snap = useFleet();
  return snap.entries.get(runId);
}
