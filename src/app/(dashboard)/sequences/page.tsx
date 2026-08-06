export const dynamic = "force-dynamic";
/** Sequences list: what exists, whether it is running, and how it is doing. */
import Link from "next/link";
import { sqlite } from "@/lib/db";
import { queueCounts } from "@/modules/sequences/lib/queue";

interface Row {
  id: string; name: string; brand: string; trigger: string; status: string;
  enrollment_mode: string; propose_only: number; description: string | null;
  steps: number; active_enrollments: number; sent: number;
}

export default function SequencesPage() {
  const engineOn = (sqlite.prepare("SELECT value FROM settings WHERE key='seq.engine_enabled'")
    .get() as { value: string } | undefined)?.value === "true";
  const rows = sqlite.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM sequence_steps st WHERE st.sequence_id = s.id) AS steps,
      (SELECT COUNT(*) FROM sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active') AS active_enrollments,
      (SELECT COUNT(*) FROM sequence_messages m WHERE m.sequence_id = s.id AND m.status = 'sent') AS sent
    FROM sequences s ORDER BY s.priority DESC, s.name ASC
  `).all() as Row[];
  const counts = queueCounts();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Sequences</h1>
          <p className="text-sm text-muted-foreground">
            Automated outreach. Messages are drafted here and reviewed before they go out.
          </p>
        </div>
        <Link href="/sequences/queue"
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
          Review queue{counts.review > 0 && ` (${counts.review})`}
        </Link>
      </div>

      <div className={`rounded-md border px-4 py-3 text-sm ${engineOn
        ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30"
        : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"}`}>
        {engineOn
          ? "Engine is ON — sequences enroll and queue messages automatically."
          : "Engine is OFF. Sequences will not enroll anyone or queue messages until seq.engine_enabled is set to true."}
      </div>

      {!rows.length ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          No sequences yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Brand</th>
                <th className="p-3 font-medium">Trigger</th>
                <th className="p-3 font-medium">Steps</th>
                <th className="p-3 font-medium">Active</th>
                <th className="p-3 font-medium">Sent</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="p-3">
                    <Link href={`/sequences/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                    {r.description && <div className="text-xs text-muted-foreground">{r.description}</div>}
                  </td>
                  <td className="p-3 uppercase">{r.brand}</td>
                  <td className="p-3">{r.trigger}</td>
                  <td className="p-3">{r.steps}</td>
                  <td className="p-3">{r.active_enrollments}</td>
                  <td className="p-3">{r.sent}</td>
                  <td className="p-3">
                    <span className="rounded bg-muted px-2 py-0.5 text-xs">{r.status}</span>
                    {r.propose_only === 1 && r.enrollment_mode === "auto" && (
                      <span className="ml-1 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        propose only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
