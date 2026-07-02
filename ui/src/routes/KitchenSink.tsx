import { useEffect, useState } from "react";
import { Page } from "@/layout/Page";
import {
  Button,
  Card,
  StatusChip,
  StatusDot,
  Tabs,
  DataTable,
  type Column,
  Drawer,
  Modal,
  Meter,
  Markdown,
  DiffView,
  LogPane,
  CopyButton,
  EmptyState,
  KeyValue,
  Sparkline,
} from "@/components";
import { liveRunStore } from "@/stores/liveRunStore";
import { toast } from "@/stores/uiStore";
import { mockWinningDiff, mockAttemptLog, mockRubricBody } from "@/mocks/fixtures";
import { formatUsd, formatTokens, formatDuration } from "@/lib/format";
import type { StatusTone } from "@/lib/status";

interface DemoRow {
  id: string;
  stage: string;
  producer: string;
  cost: number;
  tokens: number;
  ms: number;
}

const demoRows: DemoRow[] = [
  { id: "att_spec_1", stage: "spec", producer: "claude/opus", cost: 0.203, tokens: 6000, ms: 41200 },
  { id: "att_design_2", stage: "design", producer: "claude/opus", cost: 0.276, tokens: 9350, ms: 61400 },
  { id: "att_contract_1", stage: "contracts", producer: "codex", cost: 0.025, tokens: 5500, ms: 38900 },
  { id: "att_impl_b", stage: "impl", producer: "claude/opus", cost: 0.379, tokens: 12550, ms: 81900 },
];

const columns: Column<DemoRow>[] = [
  { key: "id", header: "Attempt", render: (r) => r.id, sortValue: (r) => r.id, mono: true },
  { key: "stage", header: "Stage", render: (r) => r.stage, sortValue: (r) => r.stage },
  { key: "producer", header: "Producer", render: (r) => r.producer, sortValue: (r) => r.producer, mono: true },
  { key: "tokens", header: "Tokens", render: (r) => formatTokens(r.tokens), sortValue: (r) => r.tokens, mono: true, align: "right" },
  { key: "cost", header: "Cost", render: (r) => formatUsd(r.cost), sortValue: (r) => r.cost, mono: true, align: "right" },
  { key: "ms", header: "Wall", render: (r) => formatDuration(r.ms), sortValue: (r) => r.ms, mono: true, align: "right" },
];

const TONES: { tone: StatusTone; label: string }[] = [
  { tone: "run", label: "running" },
  { tone: "pass", label: "passed" },
  { tone: "fail", label: "failed" },
  { tone: "warn", label: "surfaced" },
  { tone: "judge", label: "judging" },
  { tone: "dim", label: "skipped" },
];

const DEMO_ATTEMPT = "kitchen_demo_attempt";

export function KitchenSinkPage() {
  const [tab, setTab] = useState("primitives");
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);

  // Stream the sample log into the live store so LogPane demonstrates tailing.
  useEffect(() => {
    liveRunStore.clearLog(DEMO_ATTEMPT);
    let i = 0;
    const timer = setInterval(() => {
      if (i >= mockAttemptLog.length) {
        i = 0;
        liveRunStore.clearLog(DEMO_ATTEMPT);
        return;
      }
      liveRunStore.appendLog(DEMO_ATTEMPT, (mockAttemptLog[i] ?? "") + "\n");
      i++;
    }, 900);
    return () => clearInterval(timer);
  }, []);

  return (
    <Page
      title="Kitchen Sink"
      description="Every primitive with sample data — a dev-only visual reference for the instrument-panel design language."
      actions={<CopyButton value={window.location.href} label="Copy URL" />}
    >
      <Tabs
        className="mb-4"
        active={tab}
        onChange={setTab}
        items={[
          { id: "primitives", label: "Primitives" },
          { id: "data", label: "Data & Logs" },
          { id: "overlays", label: "Overlays", count: 2 },
        ]}
      />

      {tab === "primitives" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card title="Buttons">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary</Button>
              <Button>Default</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button disabled>Disabled</Button>
              <Button size="sm" variant="primary">Small</Button>
            </div>
          </Card>

          <Card title="Status chips & dots">
            <div className="flex flex-wrap items-center gap-2">
              {TONES.map((t) => (
                <StatusChip key={t.tone} tone={t.tone} label={t.label} />
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              {TONES.map((t) => (
                <StatusDot key={t.tone} tone={t.tone} title={t.label} />
              ))}
            </div>
          </Card>

          <Card title="Meters (budget tripwires)">
            <div className="space-y-3">
              <Meter value={3.1} max={8} label="Day budget" readout="$3.10 / $8.00" ticks={[{ at: 0.8, tone: "warn" }, { at: 1, tone: "fail" }]} />
              <Meter value={6.9} max={8} label="Approaching tripwire" readout="$6.90 / $8.00" ticks={[{ at: 0.8, tone: "warn" }, { at: 1, tone: "fail" }]} />
              <Meter value={8.4} max={8} label="Over cap" readout="$8.40 / $8.00" ticks={[{ at: 0.8, tone: "warn" }, { at: 1, tone: "fail" }]} />
            </div>
          </Card>

          <Card title="KeyValue & Sparkline">
            <KeyValue
              rows={[
                { label: "run id", value: "run_9fK2aLpQ7vX3", mono: true },
                { label: "mode", value: "team · feature-team" },
                { label: "cost", value: formatUsd(1.29), mono: true },
                { label: "trend", value: <Sparkline data={[2, 4, 3, 6, 5, 8, 7, 9]} /> },
              ]}
            />
          </Card>

          <Card title="Empty state">
            <EmptyState compact title="Nothing here yet" description="EmptyState is the default for every stubbed route." />
          </Card>

          <Card title="Overlays & toasts">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setDrawer(true)}>Open drawer</Button>
              <Button onClick={() => setModal(true)}>Open modal</Button>
              <Button variant="ghost" onClick={() => toast({ tone: "success", title: "Run finalized", message: "surfaced · 1 missability check failed" })}>Toast: success</Button>
              <Button variant="ghost" onClick={() => toast({ tone: "error", title: "Provider degraded", message: "google: smoke test failed" })}>Toast: error</Button>
            </div>
          </Card>
        </div>
      )}

      {tab === "data" && (
        <div className="space-y-4">
          <Card title="DataTable (sortable, dense)" flush>
            <DataTable
              columns={columns}
              rows={demoRows}
              rowKey={(r) => r.id}
              initialSort={{ key: "cost", dir: "desc" }}
            />
          </Card>

          <Card title="DiffView (unified diff)" flush>
            <div className="p-3">
              <DiffView patch={mockWinningDiff} />
            </div>
          </Card>

          <Card title="LogPane (virtualized, ANSI, follow pill)" flush>
            <div className="p-3">
              <LogPane attemptId={DEMO_ATTEMPT} height={220} title="att_impl_b · live" />
            </div>
          </Card>

          <Card title="Markdown (rubric body)">
            <Markdown source={mockRubricBody} />
          </Card>
        </div>
      )}

      {tab === "overlays" && (
        <Card title="Overlays render in portals">
          <p className="text-[13px] text-ink-2">Use the buttons on the Primitives tab, or trigger here:</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => setDrawer(true)}>Drawer</Button>
            <Button onClick={() => setModal(true)}>Modal</Button>
          </div>
        </Card>
      )}

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="att_impl_b · attempt detail"
        footer={<Button variant="primary" onClick={() => setDrawer(false)}>Close</Button>}
      >
        <KeyValue
          rows={[
            { label: "producer", value: "claude", mono: true },
            { label: "model", value: "claude-opus-4-7", mono: true },
            { label: "tokens in", value: formatTokens(8340), mono: true },
            { label: "tokens out", value: formatTokens(4210), mono: true },
            { label: "cost", value: formatUsd(0.379), mono: true },
          ]}
        />
        <div className="mt-4">
          <DiffView patch={mockWinningDiff} />
        </div>
      </Drawer>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Retract verdict?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setModal(false)}>Retract</Button>
          </>
        }
      >
        This retracts the recorded verdict and reopens the stage for re-judging. The Reflexion ×1
        budget is not consumed.
      </Modal>
    </Page>
  );
}
