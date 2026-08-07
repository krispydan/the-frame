export const dynamic = "force-dynamic";
/**
 * Daily outreach review queue — the screen the sequence engine exists to feed.
 * Engine queues messages; a human reads, edits if needed, sends in Faire, and
 * marks them here. Nothing sends automatically from this page.
 */
import Link from "next/link";
import { getQueue, queueCounts } from "@/modules/sequences/lib/queue";
import { QueueClient } from "@/modules/sequences/components/queue-client";
import { TaskList } from "@/modules/sequences/components/task-list";

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const counts = queueCounts();
  const items = getQueue({ limit: 100 });
  const tasks = getQueue({ limit: 100, status: "task_open" });

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
      <div className="flex gap-2 border-b pb-2 text-sm">
        <Link href="/sequences/queue"
          className={`rounded px-3 py-1.5 ${view !== "tasks" ? "bg-muted font-medium" : "hover:bg-muted/60"}`}>
          Messages ({counts.review})
        </Link>
        <Link href="/sequences/queue?view=tasks"
          className={`rounded px-3 py-1.5 ${view === "tasks" ? "bg-muted font-medium" : "hover:bg-muted/60"}`}>
          Tasks ({counts.tasks})
        </Link>
      </div>

      {view === "tasks"
        ? <TaskList items={tasks} />
        : <QueueClient initialItems={items} initialCounts={counts} />}
    </div>
  );
}
