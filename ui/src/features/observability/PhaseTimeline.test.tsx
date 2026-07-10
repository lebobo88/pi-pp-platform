/**
 * PhaseTimeline — unit tests covering the Gantt / live-view gating logic.
 *
 * Key regression: a still-running run with ≥1 completed phase must NOT flip
 * from the live dot-list to the static Gantt. The Gantt is only correct for
 * finished runs (runFinished=true).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { PhaseTimeline } from "./PhaseTimeline";
import type { PhaseTimelineEntry } from "@/stores/liveRunStore";
import type { PhaseTiming } from "../../../../shared/api-types.js";

// React 18 act environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MOCK_PHASE_TIMINGS: PhaseTiming[] = [
  { id: 1, run_id: "run_test", phase: "triage", wall_ms: 1200, started_at: "2026-07-10T10:00:00.000Z", finished_at: "2026-07-10T10:00:01.200Z" },
  { id: 2, run_id: "run_test", phase: "profile", wall_ms: 3400, started_at: "2026-07-10T10:00:01.200Z", finished_at: "2026-07-10T10:00:04.600Z" },
];

const MOCK_LIVE_ENTRIES: PhaseTimelineEntry[] = [
  { phase: "triage", status: "done", startedAt: "2026-07-10T10:00:00.000Z", lastAt: "2026-07-10T10:00:01.200Z" },
  { phase: "profile", status: "active", startedAt: "2026-07-10T10:00:01.200Z", lastAt: "2026-07-10T10:00:05.000Z" },
];

describe("PhaseTimeline", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows 'No phase data yet' when there are no entries and no timings", async () => {
    await act(async () => {
      root.render(createElement(PhaseTimeline, { entries: [], persistedTimings: [], runFinished: false }));
    });
    expect(container.textContent).toContain("No phase data yet");
  });

  it("shows the live dot-list when run is not finished, even with persisted timings", async () => {
    // This is the key regression case: mid-run with ≥1 completed phase must NOT
    // flip to the Gantt view.
    await act(async () => {
      root.render(
        createElement(PhaseTimeline, {
          entries: MOCK_LIVE_ENTRIES,
          persistedTimings: MOCK_PHASE_TIMINGS,
          runFinished: false,
        }),
      );
    });
    // The live view renders "active" / "done" status labels from LiveView entries.
    // The Gantt view renders phase names with bar elements but no status labels.
    const text = container.textContent ?? "";
    expect(text).toContain("active");
    // Gantt-specific markup: the GanttView produces no status dot labels
    // and formats durations differently (wall_ms from DB). Presence of "active"
    // is sufficient to confirm we are in the live path.
    // Sanity: both phases still appear in live view.
    expect(text).toContain("Triage");
    expect(text).toContain("Profile");
  });

  it("shows the Gantt bar view when run is finished and persisted timings exist", async () => {
    await act(async () => {
      root.render(
        createElement(PhaseTimeline, {
          entries: MOCK_LIVE_ENTRIES,
          persistedTimings: MOCK_PHASE_TIMINGS,
          runFinished: true,
        }),
      );
    });
    const text = container.textContent ?? "";
    // GanttView renders phase names + formatted durations (wall_ms).
    // LiveView status labels ("active", "done") are absent in the Gantt path.
    expect(text).not.toContain("active");
    expect(text).not.toContain("done");
    expect(text).toContain("Triage");
    expect(text).toContain("Profile");
  });

  it("shows live dot-list when persisted timings absent but live entries exist", async () => {
    await act(async () => {
      root.render(
        createElement(PhaseTimeline, {
          entries: MOCK_LIVE_ENTRIES,
          persistedTimings: [],
          runFinished: false,
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("active");
    expect(text).toContain("Triage");
  });

  it("shows 'No phase data yet' when run is finished but persisted timings are empty", async () => {
    await act(async () => {
      root.render(
        createElement(PhaseTimeline, {
          entries: [],
          persistedTimings: [],
          runFinished: true,
        }),
      );
    });
    expect(container.textContent).toContain("No phase data yet");
  });
});
