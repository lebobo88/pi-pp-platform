/**
 * High-risk evolution targets. Approving a proposal that mutates a rubric in
 * one of the regulated standards families (OWASP, WCAG, SLSA, NIST) requires a
 * typed confirmation phrase — these rubrics gate security/accessibility/supply-
 * chain verdicts, so a fat-fingered approval must be impossible.
 */
const HIGH_RISK_RE = /(?:^|[:/])(owasp|wcag|slsa|nist)[-_]/i;

/** Does this resource RID / rubric id belong to a high-risk standards family? */
export function isHighRiskRubric(resourceRid: string): boolean {
  return HIGH_RISK_RE.test(resourceRid);
}

/** The phrase the reviewer must type verbatim to approve a high-risk change. */
export function confirmationPhrase(resourceRid: string): string {
  const family = resourceRid.match(HIGH_RISK_RE)?.[1]?.toUpperCase() ?? "APPROVE";
  return `APPROVE ${family}`;
}

/** Whether a typed value satisfies the required confirmation (exact, trimmed). */
export function confirmationSatisfied(resourceRid: string, typed: string): boolean {
  if (!isHighRiskRubric(resourceRid)) return true;
  return typed.trim() === confirmationPhrase(resourceRid);
}
