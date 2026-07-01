export const dynamic = "force-dynamic";
import Link from "next/link";
import { getPipedriveConnectionStatus } from "@/modules/sales/lib/pipedrive-client";

/**
 * The kanban pipeline board was retired in favour of Pipedrive as the single
 * deal surface (Daniel 2026-07). Deals now live in Pipedrive; each prospect /
 * customer page shows that company's live Pipedrive record (org, deals,
 * activities) with one-click push + create-deal.
 *
 * This page stays as a signpost so old bookmarks / links land somewhere useful
 * rather than 404ing. Deep links to a specific deal (/pipeline/<deal_id>) still
 * redirect to the matching /prospects/<company_id> page.
 */
export default function PipelineRetiredPage() {
  const status = getPipedriveConnectionStatus();
  const board = status.apiDomain ? `${status.apiDomain}/pipeline` : null;

  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-2xl font-semibold">Pipeline lives in Pipedrive</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The deal board moved to Pipedrive, our system of record for deals and
        pipeline stage. Work deals there, and use each prospect or customer page
        in The Frame to see their live Pipedrive record and push or create deals.
      </p>
      <div className="mt-6 flex items-center justify-center gap-3">
        {board && (
          <a
            href={board}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Open Pipedrive
          </a>
        )}
        <Link
          href="/prospects"
          className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Go to Prospects
        </Link>
      </div>
      {!status.connected && (
        <p className="mt-4 text-xs text-muted-foreground">
          Pipedrive isn&apos;t connected yet.{" "}
          <Link href="/settings/integrations/pipedrive" className="text-blue-600 hover:underline">
            Connect it →
          </Link>
        </p>
      )}
    </div>
  );
}
