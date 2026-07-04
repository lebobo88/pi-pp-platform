import { useNavigate } from "react-router";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { cn } from "@/lib/cn";
import { useProviders } from "@/api/queries/providers";
import { useProjects } from "@/api/queries/projects";

interface StepDef {
  id: string;
  title: string;
  description: string;
  done: boolean;
  action: string;
  to: string;
  disabled?: boolean;
}

/**
 * First-launch checklist shown on the dashboard while the harness has zero
 * runs: configure a provider, register a project, then dispatch a run. The
 * checkmarks are live — each step observes the query it gates on.
 */
export function OnboardingChecklist() {
  const navigate = useNavigate();
  const { data: providers } = useProviders();
  const { data: projects } = useProjects();

  const providerDone = (providers ?? []).some((p) => p.configured);
  const projectDone = (projects ?? []).length > 0;

  const steps: StepDef[] = [
    {
      id: "provider",
      title: "Add a provider key",
      description: "Configure at least one model vendor so the harness can generate.",
      done: providerDone,
      action: "Providers",
      to: "/providers",
    },
    {
      id: "project",
      title: "Register a project",
      description: "Point the harness at a repository to run against.",
      done: projectDone,
      action: "Projects",
      to: "/projects",
    },
    {
      id: "run",
      title: "Launch your first run",
      description: "Dispatch a request through the triage → generate → judge pipeline.",
      done: false,
      action: "New run",
      to: "/runs/new",
      disabled: !(providerDone && projectDone),
    },
  ];

  return (
    <Card title="Get started" flush data-testid="onboarding-checklist">
      <ul className="divide-y divide-line-1">
        {steps.map((step, i) => (
          <li key={step.id} className="flex items-center gap-3 px-3 py-2.5">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                step.done
                  ? "border-[color-mix(in_srgb,var(--pass)_55%,transparent)] bg-[color-mix(in_srgb,var(--pass)_14%,transparent)] text-pass"
                  : "border-line-2 bg-bg-2 text-ink-3",
              )}
              aria-hidden
            >
              {step.done ? "✓" : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block text-[13px] font-medium", step.done ? "text-ink-3 line-through decoration-line-2" : "text-ink-1")}>
                {step.title}
              </span>
              <span className="block text-[11px] text-ink-3">{step.description}</span>
            </span>
            <Button
              size="sm"
              variant={step.id === "run" && !step.disabled ? "primary" : "default"}
              disabled={step.disabled}
              title={step.disabled ? "Complete the steps above first" : undefined}
              onClick={() => navigate(step.to)}
            >
              {step.action}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
