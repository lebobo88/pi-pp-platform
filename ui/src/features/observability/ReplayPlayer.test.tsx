/**
 * ReplayPlayer component tests.
 *
 * Follows the existing test pattern (react-dom/client + act, no React Testing
 * Library dependency), same as PhaseTimeline.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { ReplayPlayer } from "./ReplayPlayer.js";
import type { RunTree, EventLogEntry } from "@shared/api-types";

// React 18 act environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── Mocks ────────────────────────────────────────────────────────────── */

// Stub out the content query — we don't need real network calls.
vi.mock("@/api/queries/content.js", () => ({
  useContent: () => ({ data: undefined }),
}));

// Stub liveRunStore to avoid DOM/timing side effects in the component test.
vi.mock("@/stores/liveRunStore", () => ({
  liveRunStore: {
    ingest: vi.fn(),
    resetRun: vi.fn(),
    clearLogs: vi.fn(),
  },
}));

/* ── Fixtures ──────────────────────────────────────────────────────────── */

function mkEvent(type: string, seq: number): EventLogEntry {
  return {
    type,
    run_id: "run_test",
    ts: `2026-07-10T10:00:${String(seq).padStart(2, "0")}.000Z`,
    seq,
    data: {},
  } as unknown as EventLogEntry;
}

const MOCK_EVENTS: EventLogEntry[] = [
  mkEvent("run.started", 0),
  mkEvent("run.context", 1),
  mkEvent("stage.started", 2),
  mkEvent("attempt.started", 3),
  mkEvent("attempt.completed", 4),
  mkEvent("run.finalized", 5),
];

const MOCK_TREE: RunTree = {
  run: {
    id: "run_test",
    session_id: null,
    project_path: "/proj",
    request_text: "test",
    team: null,
    mode: "single",
    forum: null,
    n: null,
    status: "complete",
    profile_snapshot_json: null,
    taxonomy_mapping_json: null,
    head_sha: null,
    tree_dirty_hash: null,
    cli_versions_json: null,
    cli_flags_json: null,
    hydra_workflow_id: null,
    hydra_envelope_id: null,
    hydra_origin_squad: null,
    hydra_envelope_type: null,
    constitution_sha: null,
    constitution_attestation_id: null,
    eights_episodic_handle: null,
    audit_bom_handle: null,
    stage_plan_json: null,
    started_at: "2026-07-10T10:00:00.000Z",
    finished_at: "2026-07-10T10:01:00.000Z",
  },
  stages: [],
  attempts: [],
  verdicts: [],
  artifacts: [],
  phases: [],
};

/* ── Setup ────────────────────────────────────────────────────────────── */

describe("ReplayPlayer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /* ── renders the enter-replay button when not active ─────────────── */

  it("renders 'enter replay' button when events are loaded", async () => {
    const onActiveChange = vi.fn();
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange,
        }),
      );
    });
    expect(container.textContent).toContain("enter replay");
    // The button should say how many events
    expect(container.textContent).toContain(String(MOCK_EVENTS.length));
  });

  it("shows 'loading…' and disables button while loading", async () => {
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: [],
          loading: true,
          tree: MOCK_TREE,
          onActiveChange: vi.fn(),
        }),
      );
    });
    expect(container.textContent).toContain("loading");
    const btn = container.querySelector("button");
    expect(btn?.disabled).toBe(true);
  });

  it("disables enter button when events array is empty and not loading", async () => {
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: [],
          loading: false,
          tree: MOCK_TREE,
          onActiveChange: vi.fn(),
        }),
      );
    });
    const btn = container.querySelector("button");
    expect(btn?.disabled).toBe(true);
  });

  /* ── entering replay ─────────────────────────────────────────────── */

  it("calls onActiveChange(true) when entering replay", async () => {
    const onActiveChange = vi.fn();
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange,
        }),
      );
    });
    const btn = container.querySelector("button");
    await act(async () => {
      btn?.click();
    });
    expect(onActiveChange).toHaveBeenCalledWith(true);
  });

  it("shows the replay control bar after entering replay", async () => {
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange: vi.fn(),
        }),
      );
    });
    // Enter replay
    const btn = container.querySelector("button");
    await act(async () => {
      btn?.click();
    });
    expect(container.textContent).toContain("replay mode");
    expect(container.textContent).toContain("exit replay");
  });

  /* ── exiting replay ──────────────────────────────────────────────── */

  it("calls onActiveChange(false) when exiting replay", async () => {
    const onActiveChange = vi.fn();
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange,
        }),
      );
    });
    // Enter replay
    const enterBtn = container.querySelector("button");
    await act(async () => { enterBtn?.click(); });

    onActiveChange.mockClear();

    // Exit replay
    const exitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("exit replay"),
    );
    await act(async () => { exitBtn?.click(); });

    expect(onActiveChange).toHaveBeenCalledWith(false);
  });

  it("returns to enter-replay button after exiting", async () => {
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange: vi.fn(),
        }),
      );
    });
    // Enter
    const enterBtn = container.querySelector("button");
    await act(async () => { enterBtn?.click(); });
    // Exit
    const exitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("exit replay"),
    );
    await act(async () => { exitBtn?.click(); });

    expect(container.textContent).toContain("enter replay");
    expect(container.textContent).not.toContain("replay mode");
  });

  /* ── speed selector ──────────────────────────────────────────────── */

  it("shows speed options after entering replay", async () => {
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange: vi.fn(),
        }),
      );
    });
    const btn = container.querySelector("button");
    await act(async () => { btn?.click(); });

    expect(container.textContent).toContain("1×");
    expect(container.textContent).toContain("2×");
    expect(container.textContent).toContain("max");
  });

  /* ── position counter ────────────────────────────────────────────── */

  it("shows event count in position counter", async () => {
    await act(async () => {
      root.render(
        createElement(ReplayPlayer, {
          runId: "run_test",
          events: MOCK_EVENTS,
          loading: false,
          tree: MOCK_TREE,
          onActiveChange: vi.fn(),
        }),
      );
    });
    const btn = container.querySelector("button");
    await act(async () => { btn?.click(); });

    // Should show "0 / 6 (0%)"
    expect(container.textContent).toContain(`/ ${MOCK_EVENTS.length}`);
  });
});
