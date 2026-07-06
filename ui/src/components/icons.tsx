import type { SVGProps } from "react";

/** Minimal 16px stroke icon set — no icon-font dependency. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
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
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Icon>
);

export const IconProjects = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.8h4.5A1.5 1.5 0 0 1 14 6.3V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11z" />
  </Icon>
);

export const IconRuns = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 3v10l8-5z" />
  </Icon>
);

export const IconProviders = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4" />
  </Icon>
);

export const IconBudgets = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2" y="4" width="12" height="8" rx="1.5" />
    <path d="M2 7h12" />
    <circle cx="11" cy="9.5" r="0.7" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconEvolution = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 2v12M8 2 5 5M8 2l3 3M4 8h8M4 8 2 6M4 8l-2 2M12 8l2-2M12 8l2 2" />
  </Icon>
);

export const IconLibrary = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="3" height="11" rx="0.5" />
    <rect x="6.5" y="2.5" width="3" height="11" rx="0.5" />
    <path d="M10.5 3.5l2.6.7 1 10.6-2.9-.8z" />
  </Icon>
);

export const IconSystem = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 1.5l1.4 1 1.7-.3.6 1.6 1.5.8-.3 1.7 1 1.4-1 1.4.3 1.7-1.5.8-.6 1.6-1.7-.3L8 14.5l-1.4-1-1.7.3-.6-1.6-1.5-.8.3-1.7-1-1.4 1-1.4-.3-1.7 1.5-.8.6-1.6 1.7.3z" />
    <circle cx="8" cy="8" r="1.8" />
  </Icon>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);

export const IconObservability = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    {/* Radar-style icon: outer ring, cross-hairs, center dot */}
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2.5v1M8 12.5v1M2.5 8h1M12.5 8h1" />
    <path d="M8 6V2M8 10v4M6 8H2M10 8h4" strokeWidth="0" />
    {/* Sweep line */}
    <path d="M8 8l3.5-3.5" strokeWidth="1.2" />
  </Icon>
);

export const IconExternal = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7 9" />
  </Icon>
);
