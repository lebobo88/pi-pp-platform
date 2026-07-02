import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "./navConfig";

export function Sidebar() {
  const { pathname } = useLocation();

  return (
    <nav className="flex h-full w-[220px] shrink-0 flex-col border-r border-line-1 bg-bg-1">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1 px-3">
        <span
          className="inline-block size-3.5 rounded-sm"
          style={{ background: "var(--accent)", boxShadow: "0 0 10px color-mix(in srgb, var(--accent) 55%, transparent)" }}
        />
        <span className="text-[13px] font-semibold tracking-tight text-ink-1">
          pi<span className="text-ink-3"> · </span>
          <span className="text-ink-2">pair-programmer</span>
        </span>
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
              className={cn(
                "mb-0.5 flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px] transition-colors",
                active
                  ? "bg-bg-3 font-medium text-ink-1"
                  : "text-ink-3 hover:bg-bg-2 hover:text-ink-1",
              )}
            >
              <span className={cn("shrink-0", active ? "text-accent" : "text-ink-3")}>{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-line-1 px-3 py-2">
        <NavLink
          to="/kitchen-sink"
          className="mono text-[10px] text-ink-3 transition-colors hover:text-ink-2"
        >
          /kitchen-sink
        </NavLink>
      </div>
    </nav>
  );
}
