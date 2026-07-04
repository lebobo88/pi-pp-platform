import { useEffect } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { IconChevron } from "@/components/icons";
import { useUiStore } from "@/stores/uiStore";
import { NAV_ITEMS } from "./navConfig";

/** True when the key event originated in a text-entry context. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function Sidebar() {
  const { pathname } = useLocation();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // "[" toggles the rail (ignored while typing / with modifiers held).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      useUiStore.getState().toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <nav
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-line-1 bg-bg-1 transition-[width] duration-150",
        collapsed ? "w-14" : "w-[220px]",
      )}
    >
      <div
        className={cn(
          "flex h-11 shrink-0 items-center gap-2 border-b border-line-1",
          collapsed ? "justify-center" : "px-3",
        )}
        title={collapsed ? "pi · pair-programmer" : undefined}
      >
        <span
          className="inline-block size-3.5 shrink-0 rounded-sm"
          style={{ background: "var(--accent)", boxShadow: "0 0 10px color-mix(in srgb, var(--accent) 55%, transparent)" }}
        />
        {!collapsed && (
          <span className="truncate text-[13px] font-semibold tracking-tight text-ink-1">
            pi<span className="text-ink-3"> · </span>
            <span className="text-ink-2">pair-programmer</span>
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const active =
            item.to === "/"
              ? pathname === "/"
              : item.activePrefixes
                ? item.activePrefixes.some((p) => pathname.startsWith(p))
                : pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={cn(
                "mb-0.5 flex items-center gap-2.5 rounded-sm py-1.5 text-[13px] transition-colors",
                collapsed ? "justify-center px-0" : "px-2.5",
                active
                  ? "bg-bg-3 font-medium text-ink-1"
                  : "text-ink-3 hover:bg-bg-2 hover:text-ink-1",
              )}
            >
              <span className={cn("shrink-0", active ? "text-accent" : "text-ink-3")}>{item.icon}</span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center border-t border-line-1 py-2",
          collapsed ? "justify-center px-0" : "justify-between px-3",
        )}
      >
        {!collapsed && (
          <NavLink
            to="/kitchen-sink"
            className="mono text-[10px] text-ink-3 transition-colors hover:text-ink-2"
          >
            /kitchen-sink
          </NavLink>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          title={collapsed ? "Expand sidebar  ( [ )" : "Collapse sidebar  ( [ )"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex size-6 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-1"
        >
          <IconChevron className={cn("transition-transform", !collapsed && "rotate-180")} />
        </button>
      </div>
    </nav>
  );
}
