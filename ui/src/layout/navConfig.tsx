import type { ReactNode } from "react";
import {
  IconDashboard,
  IconProjects,
  IconRuns,
  IconProviders,
  IconBudgets,
  IconEvolution,
  IconLibrary,
  IconSystem,
} from "@/components/icons";

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Also mark active when the pathname starts with one of these prefixes. */
  activePrefixes?: string[];
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <IconDashboard /> },
  { to: "/projects", label: "Projects", icon: <IconProjects /> },
  { to: "/runs", label: "Runs", icon: <IconRuns />, activePrefixes: ["/runs"] },
  { to: "/providers", label: "Providers & Models", icon: <IconProviders /> },
  { to: "/budgets", label: "Budgets", icon: <IconBudgets /> },
  { to: "/evolution", label: "Evolution", icon: <IconEvolution /> },
  { to: "/library/teams", label: "Library", icon: <IconLibrary />, activePrefixes: ["/library"] },
  { to: "/system", label: "System", icon: <IconSystem /> },
];
