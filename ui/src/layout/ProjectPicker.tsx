import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type SVGProps } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { IconChevron } from "@/components/icons";
import { useUiStore } from "@/stores/uiStore";
import { useProjects } from "@/api/queries/projects";
import { basename } from "@/lib/format";

const LISTBOX_ID = "project-picker-listbox";

interface PickerOption {
  /** Project path, or null for "All projects". */
  path: string | null;
  name: string;
  /** Dim mono second line — the project path. */
  hint: string | null;
}

function IconCheck(p: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...p}
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

/**
 * Searchable project combobox for the top bar. No dependencies: a trigger
 * button opens an absolutely-positioned popover with an autofocused filter
 * input and a keyboard-navigable listbox ("All projects" + projects sorted by
 * most recent run). Selection writes `uiStore.setActiveProject`.
 */
export function ProjectPicker() {
  const activeProjectPath = useUiStore((s) => s.activeProjectPath);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const { data: projects } = useProjects();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const options = useMemo<PickerOption[]>(() => {
    const sorted = [...(projects ?? [])].sort((a, b) => {
      // last_run_at desc, nulls last, name asc as the tiebreak.
      if (a.last_run_at === b.last_run_at) return a.name.localeCompare(b.name);
      if (a.last_run_at == null) return 1;
      if (b.last_run_at == null) return -1;
      return a.last_run_at < b.last_run_at ? 1 : -1;
    });
    return [
      { path: null, name: "All projects", hint: null },
      ...sorted.map((p) => ({ path: p.path, name: p.name, hint: p.path })),
    ];
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  const triggerLabel =
    activeProjectPath == null
      ? "All projects"
      : (projects?.find((p) => p.path === activeProjectPath)?.name ?? basename(activeProjectPath));

  const openPicker = () => {
    setQuery("");
    const current = options.findIndex((o) => o.path === activeProjectPath);
    setActiveIdx(current >= 0 ? current : 0);
    setOpen(true);
  };

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (opt: PickerOption) => {
    setActiveProject(opt.path);
    close(true);
  };

  // Autofocus the search input on open.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Outside-click closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the active row visible while arrowing.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector(`#${LISTBOX_ID}-opt-${activeIdx}`);
    // scrollIntoView is missing in jsdom.
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIdx];
      if (opt) choose(opt);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openPicker())}
        className={cn(
          "flex h-7 min-w-[180px] items-center gap-2 rounded-sm border border-line-2 bg-bg-2 pl-2.5 pr-2",
          "text-[12px] text-ink-1 outline-none hover:border-ink-3",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
        <IconChevron className="size-3.5 shrink-0 rotate-90 text-ink-3" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[280px] rounded-md border border-line-2 bg-bg-1 shadow-xl">
          <div className="border-b border-line-1 p-1.5">
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={LISTBOX_ID}
              aria-activedescendant={filtered.length > 0 ? `${LISTBOX_ID}-opt-${activeIdx}` : undefined}
              aria-autocomplete="list"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search projects…"
              className={cn(
                "h-6 w-full rounded-sm border border-line-2 bg-bg-2 px-2 text-[12px] text-ink-1",
                "outline-none placeholder:text-ink-3 focus:border-accent",
              )}
            />
          </div>

          <ul ref={listRef} id={LISTBOX_ID} role="listbox" aria-label="Projects" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <li className="px-2 py-2 text-[12px] text-ink-3">No matching projects.</li>
            )}
            {filtered.map((opt, i) => {
              const isCurrent = opt.path === activeProjectPath;
              return (
                <li
                  key={opt.path ?? "__all__"}
                  id={`${LISTBOX_ID}-opt-${i}`}
                  role="option"
                  aria-selected={isCurrent}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => choose(opt)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",
                    i === activeIdx && "bg-bg-2",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-ink-1">{opt.name}</span>
                    {opt.hint != null && (
                      <span className="mono block truncate text-[10px] text-ink-3">{opt.hint}</span>
                    )}
                  </span>
                  {isCurrent && <IconCheck className="size-3.5 shrink-0 text-accent" />}
                </li>
              );
            })}
          </ul>

          <div className="border-t border-line-1 p-1">
            <Link
              to="/projects"
              onClick={() => close()}
              className="block rounded-sm px-2 py-1.5 text-[12px] text-accent hover:bg-bg-2"
            >
              Register project →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
