export const dynamic = "force-dynamic";
/** Sequence detail: the step timeline, how it is performing, and who is in it. */
import Link from "next/link";
import { notFound } from "next/navigation";
import { sqlite } from "@/lib/db";
import { sequenceMetrics, sequenceEnrollments } from "@/modules/sequences/lib/metrics";
import { lintTemplate } from "@/modules/sequences/lib/render";

interface Seq {
  id: string; name: string; brand: string; trigger: string; class: string; status: string;
  enrollment_mode: string; propose_only: number; priority: number; description: string | null;
}
interface Step {
  id: string; step_no: number; delay_days: number; delay_business_days: number;
  channel: string; send_mode: string; template_body: string; attachment_key: string | null;
  offer_code: string | null; task_note: string | null;
}

export default async function SequenceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const seq = sqlite.prepare("SELECT * FROM sequences WHERE id = ?").get(id) as Seq | undefined;
  if (!seq) notFound();

  const steps = sqlite.prepare("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_no").all(id) as Step[];
  const m = sequenceMetrics(id);
  const enrollments = sequenceEnrollments(id, 50);

  // Day numbers, the way the Pipedrive builder shows them: cumulative from day 1.
  let day = 1;
  const dayFor = steps.map((s, i) => { if (i > 0) day += s.delay_days; return day; });

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
        <h2 className="mb-2 text-lg font-semibold">Steps</h2>
        <div className="space-y-3">
          {steps.map((s, i) => {
            const warnings = lintTemplate(s.template_body);
            return (
              <div key={s.id} className="rounded-lg border">
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
                  <span className="font-medium">DAY {dayFor[i]}</span>
                  <span className="text-muted-foreground">
                    {i === 0 ? "on trigger" : `${s.delay_days} days after previous step completes`}
                    {s.delay_business_days ? " (business days)" : ""}
                  </span>
                  <span className="ml-auto rounded bg-background px-2 py-0.5 text-xs">{s.channel}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${
                    s.send_mode === "auto" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                    : s.send_mode === "task" ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                    : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"}`}>
                    {s.send_mode === "auto" ? "auto-send" : s.send_mode === "task" ? "task" : "review first"}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm leading-relaxed">{s.template_body}</pre>
                <div className="flex flex-wrap gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
                  {s.attachment_key && <span>📎 {s.attachment_key}</span>}
                  {s.offer_code && <span>offer: {s.offer_code}</span>}
                  {warnings.length > 0 && <span className="text-amber-600">⚠ {warnings.join(" · ")}</span>}
                </div>
              </div>
            );
          })}
        </div>
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
