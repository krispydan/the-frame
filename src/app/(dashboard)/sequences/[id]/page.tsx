export const dynamic = "force-dynamic";
/** Sequence detail: the step timeline, how it is performing, and who is in it. */
import Link from "next/link";
import { notFound } from "next/navigation";
import { sqlite } from "@/lib/db";
import { sequenceMetrics, sequenceEnrollments } from "@/modules/sequences/lib/metrics";
import { StepEditor, type EditorStep } from "@/modules/sequences/components/step-editor";

interface Seq {
  id: string; name: string; brand: string; trigger: string; class: string; status: string;
  enrollment_mode: string; propose_only: number; priority: number; description: string | null;
}


export default async function SequenceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const seq = sqlite.prepare("SELECT * FROM sequences WHERE id = ?").get(id) as Seq | undefined;
  if (!seq) notFound();

  const steps = sqlite.prepare("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_no").all(id) as EditorStep[];
  const m = sequenceMetrics(id);
  const enrollments = sequenceEnrollments(id, 50);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/sequences" className="hover:text-foreground">Sequences</Link><span>/</span><span>{seq.name}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{seq.name}</h1>
          <span className="rounded bg-muted px-2 py-0.5 text-xs uppercase">{seq.brand}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs">{seq.trigger}</span>
          <span className="rounded bg-muted px-2 py-0.5 text-xs">{seq.status}</span>
          {seq.propose_only === 1 && seq.enrollment_mode === "auto" && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
              propose only — records what it would do, sends nothing
            </span>
          )}
        </div>
        {seq.description && <p className="mt-1 text-sm text-muted-foreground">{seq.description}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          ["Enrolled", m.enrolled], ["Active", m.active], ["Sent", m.sent],
          ["Replied", `${m.replied} (${m.replyRate}%)`],
          ["Ordered ≤30d", `${m.ordered} (${m.orderRate}%)`],
          ["Revenue", `$${Math.round(m.revenue).toLocaleString()}`],
        ].map(([label, v]) => (
          <div key={String(label)} className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-0.5 text-lg font-semibold">{v}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Steps</h2>
          <span className="text-xs text-muted-foreground">Day numbers are cumulative, as Faire shows them</span>
        </div>
        <StepEditor sequenceId={id} steps={steps} />
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Accounts ({enrollments.length})</h2>
        {!enrollments.length ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            Nobody enrolled yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr><th className="p-2">Account</th><th className="p-2">Status</th><th className="p-2">Step</th><th className="p-2">Next due</th></tr>
              </thead>
              <tbody>
                {enrollments.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="p-2">
                      <Link href={`/prospects/${e.company_id}`} className="hover:underline">{e.company_name}</Link>
                      {(e.city || e.state) && <span className="ml-1 text-xs text-muted-foreground">{[e.city, e.state].filter(Boolean).join(", ")}</span>}
                    </td>
                    <td className="p-2"><span className="rounded bg-muted px-2 py-0.5 text-xs">{e.status}</span></td>
                    <td className="p-2">{e.current_step}</td>
                    <td className="p-2 text-muted-foreground">{e.next_step_due_at?.slice(0, 10) ?? (e.exit_reason || "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
