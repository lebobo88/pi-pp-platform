import { useState } from "react";
import { useNavigate } from "react-router";
import type { Project } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { useProjects } from "@/api/queries/projects";
import { formatRelative } from "@/lib/format";

/** Rough absolute-path shape check (Windows drive or POSIX root). */
function looksLikePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects();
  const [registerOpen, setRegisterOpen] = useState(false);

  const columns: Column<Project>[] = [
    { key: "name", header: "Project", render: (p) => <span className="text-ink-1">{p.name}</span>, sortValue: (p) => p.name },
    { key: "path", header: "Path", render: (p) => p.path, sortValue: (p) => p.path, mono: true },
    { key: "profile", header: "Profile", render: (p) => (p.profile ? <Pill tone="accent">{p.profile}</Pill> : <span className="text-ink-3">—</span>), sortValue: (p) => p.profile ?? "" },
    { key: "runs", header: "Runs", render: (p) => p.run_count, sortValue: (p) => p.run_count, mono: true, align: "right", width: 70 },
    { key: "last", header: "Last run", render: (p) => formatRelative(p.last_run_at), sortValue: (p) => p.last_run_at ?? "", mono: true, align: "right", width: 120 },
  ];

  return (
    <Page
      title="Projects"
      description="Every project path the harness has seen."
      actions={<Button variant="primary" onClick={() => setRegisterOpen(true)}>Register project</Button>}
    >
      <Card flush>
        {isLoading ? (
          <div className="p-6 text-center text-[12px] text-ink-3">Loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={projects ?? []}
            rowKey={(p) => p.path}
            onRowClick={(p) => navigate(`/projects/${encodeURIComponent(p.path)}`)}
            initialSort={{ key: "last", dir: "desc" }}
            empty={<EmptyState title="No projects" compact />}
          />
        )}
      </Card>

      <RegisterDialog open={registerOpen} onClose={() => setRegisterOpen(false)} />
    </Page>
  );
}

function RegisterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [path, setPath] = useState("");
  const valid = looksLikePath(path.trim());
  const dirty = path.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register project"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} title={valid ? "Registration lands with the M6 control agent" : "Enter a valid absolute path"}>
            Register
          </Button>
        </>
      }
    >
      <label className="block text-[12px] text-ink-2">Absolute project path</label>
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="C:/path/to/project"
        className="mono mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
      />
      {dirty && !valid && (
        <p className="mt-1 text-[11px] text-fail">Must be an absolute path (e.g. C:/… or /…).</p>
      )}
      <p className="mt-2 text-[11px] text-ink-3">
        Read-only placeholder — this validates the path shape only. Actual registration is wired by the control-plane milestone.
      </p>
    </Modal>
  );
}
