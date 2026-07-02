import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { apiPaths, type BudgetEntry } from "@shared/api-types";

export function useBudgets() {
  return useQuery({
    queryKey: qk.budgets,
    queryFn: ({ signal }) => api.get<BudgetEntry[]>(apiPaths.budgets, { signal }),
  });
}

export function useBudget(scope: string | undefined) {
  return useQuery({
    queryKey: qk.budget(scope ?? ""),
    queryFn: ({ signal }) => api.get<BudgetEntry | null>(apiPaths.budget(scope!), { signal }),
    enabled: !!scope,
  });
}
