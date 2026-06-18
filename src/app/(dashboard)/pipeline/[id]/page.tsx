export const dynamic = "force-dynamic";
import { sqlite } from "@/lib/db";
import { notFound, redirect } from "next/navigation";

/**
 * The deal-detail page is unified with the prospect detail page per
 * Daniel 2026-06-19. companies.status and deals.stage are kept in
 * lockstep by status-progression, so one canonical view (prospects)
 * shows the full story without two divergent surfaces drifting apart.
 *
 * This route exists only to redirect inbound links — bookmarks,
 * Slack pastes, anywhere a /pipeline/<deal_id> URL is still floating
 * around — to the equivalent /prospects/<company_id> URL.
 */
export default async function DealDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const row = sqlite
    .prepare("SELECT company_id FROM deals WHERE id = ?")
    .get(id) as { company_id: string | null } | undefined;

  if (!row?.company_id) notFound();

  redirect(`/prospects/${row.company_id}`);
}
