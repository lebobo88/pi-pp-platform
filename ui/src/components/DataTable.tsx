import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  /** Sort accessor; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  /** Render cell contents in the mono/tabular stack. */
  mono?: boolean;
  align?: "left" | "right" | "center";
  width?: number | string;
  className?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Highlight this row key. */
  activeKey?: string;
  /** Initial sort. */
  initialSort?: { key: string; dir: "asc" | "desc" };
  empty?: ReactNode;
  className?: string;
  /** Sticky header (for scroll containers). */
  stickyHeader?: boolean;
}

type SortState = { key: string; dir: "asc" | "desc" } | null;

/** Dense, sortable table. Sorting is client-side over the provided rows. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeKey,
  initialSort,
  empty,
  className,
  stickyHeader,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const accessor = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  return (
    <table className={cn("w-full border-collapse text-[12px]", className)}>
      <thead className={cn(stickyHeader && "sticky top-0 z-10")}>
        <tr className="border-b border-line-1 bg-bg-2 text-left">
          {columns.map((c) => {
            const sortable = !!c.sortValue;
            const active = sort?.key === c.key;
            return (
              <th
                key={c.key}
                style={{ width: c.width }}
                className={cn(
                  "select-none px-2.5 py-1.5 font-medium uppercase tracking-wide text-ink-3",
                  c.align === "right" && "text-right",
                  c.align === "center" && "text-center",
                  sortable && "cursor-pointer hover:text-ink-1",
                )}
                onClick={sortable ? () => toggleSort(c.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {c.header}
                  {sortable && (
                    <span className={cn("text-[9px]", active ? "text-accent" : "text-line-2")}>
                      {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  )}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="px-2.5 py-6 text-center text-ink-3">
              {empty ?? "No rows."}
            </td>
          </tr>
        ) : (
          sorted.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b border-line-1/60 transition-colors",
                  onRowClick && "cursor-pointer hover:bg-bg-2",
                  activeKey === key && "bg-bg-2",
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{ width: c.width }}
                    className={cn(
                      "px-2.5 py-1.5 text-ink-1",
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      c.mono && "mono tnum",
                      c.className,
                    )}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
