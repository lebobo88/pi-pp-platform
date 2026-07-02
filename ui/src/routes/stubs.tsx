import { Page } from "@/layout/Page";
import { EmptyState } from "@/components/EmptyState";

/** The 404 catch-all. Every other route now resolves to a real screen. */
export function NotFoundPage() {
  return (
    <Page title="Not found">
      <EmptyState title="404" description="No route matches this URL." />
    </Page>
  );
}
