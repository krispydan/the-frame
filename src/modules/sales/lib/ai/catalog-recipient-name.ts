/**
 * Extract the name to address a mailed catalog to, from a lead's call
 * notes/transcript. We want the OWNER / buyer / decision-maker — if a staff
 * member answered but named the owner ("spoke with Michelle, owner is Jeannie
 * DeMarco"), we want the owner. Used to recover first names for the direct-mail
 * cohort that we couldn't get from email greetings.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const SYSTEM = `You read a sales call note and/or transcript for a boutique and extract the NAME that a mailed physical catalog should be addressed to.

Rules:
- Address it to the OWNER or BUYER / decision-maker of the store.
- If a staff member answered the phone but the owner/decision-maker is named (e.g. "spoke with Michelle, she'll pass it to owner Jeannie DeMarco"), use the OWNER's name (Jeannie DeMarco), NOT the staff member.
- If only a staff member is named and no owner, and the catalog would be addressed to that staff member, you may use them.
- Only return a name that is EXPLICITLY stated in the note/transcript. Never invent or guess a name.
- Transcripts are auto-transcribed from audio and may be imperfect; only extract a name you are confident is a real personal name that was stated.
- If no clear personal name is stated, return nulls.

Return ONLY a JSON object, no prose:
{"firstName": string|null, "lastName": string|null, "role": "owner"|"buyer"|"staff"|"unknown"|null}`;

export interface RecipientName {
  firstName: string | null;
  lastName: string | null;
  role: string | null;
}

function unwrap(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

export async function extractCatalogRecipientName(input: {
  store: string | null;
  notes: string | null;
  transcript: string | null;
}): Promise<RecipientName | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const notes = (input.notes ?? "").trim();
  const transcript = (input.transcript ?? "").trim();
  if (!notes && !transcript) return null;

  const user = [
    `Store: ${input.store ?? "(unknown)"}`,
    "",
    "Call note:",
    notes || "(none)",
    transcript ? "\nCall transcript:\n" + transcript.slice(0, 8000) : "",
  ].join("\n");

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, system: SYSTEM, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) {
      console.error("[catalog-recipient-name] anthropic", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const raw = json.content.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(unwrap(raw)) as RecipientName;
    const clean = (v: unknown) => {
      const s = (typeof v === "string" ? v : "").trim();
      return s && s.toLowerCase() !== "null" ? s : null;
    };
    return { firstName: clean(parsed.firstName), lastName: clean(parsed.lastName), role: clean(parsed.role) };
  } catch (e) {
    console.error("[catalog-recipient-name] failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
