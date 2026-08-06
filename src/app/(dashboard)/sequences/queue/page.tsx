export const dynamic = "force-dynamic";
/**
 * Daily outreach review queue — the screen the sequence engine exists to feed.
 * Engine queues messages; a human reads, edits if needed, sends in Faire, and
 * marks them here. Nothing sends automatically from this page.
 */
import Link from "next/link";
import { getQueue, queueCounts } from "@/modules/sequences/lib/queue";
import { QueueClient } from "@/modules/sequences/components/queue-client";

export default function QueuePage() {
  const items = getQueue({ limit: 100 });
  const counts = queueCounts();

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/sequences" className="hover:text-foreground">Sequences</Link>
          <span>/</span>
          <span>Queue</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold">Outreach queue</h1>
        <p className="text-sm text-muted-foreground">
          {counts.review} waiting · {counts.sentToday} sent today
          {counts.tasks > 0 && ` · ${counts.tasks} open tasks`}
        </p>
      </div>
      <QueueClient initialItems={items} initialCounts={counts} />
    </div>
  );
}
