/**
 * Transcribe a PhoneBurner call recording so verbally-given details
 * (most notably the "send the catalog to <email>" that reps say out
 * loud but don't type) can be recovered.
 *
 * PhoneBurner recording URLs (www.phoneburner.com/recording/.../recording.mp3)
 * are NOT public — they 302 to a login. We download with the PB API
 * bearer token, then send the audio to OpenAI's transcription endpoint.
 *
 * Fully gated + graceful:
 *   - off unless settings.pb_transcription_enabled === "true"
 *   - returns null (never throws) if OPENAI_API_KEY is unset, the
 *     download isn't audio, or transcription fails.
 * So enrichment always proceeds notes-only when this can't run.
 */
import { sqlite } from "@/lib/db";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIBE_MODEL = "whisper-1";
const MAX_BYTES = 25 * 1024 * 1024; // OpenAI hard limit

function getSetting(key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

/** On by default — the full transcript is saved for every Set-Appointment
 *  call. Set settings.pb_transcription_enabled = "false" as a kill switch. */
export function isTranscriptionEnabled(): boolean {
  return getSetting("pb_transcription_enabled") !== "false";
}

function resolvePbApiKey(): string | null {
  return process.env.PHONEBURNER_API_KEY || getSetting("phoneburner_api_key");
}

/**
 * Download the recording (PB bearer auth) and transcribe it.
 *
 * The PB API's `recording_url` is a web PLAYER page, not the mp3. The
 * real audio is the UI's download endpoint, keyed by call_id and gated
 * behind the API bearer token (no-auth returns an HTML login page).
 *
 * @param callId  PhoneBurner call id (phoneburner_call_log.id)
 * @returns transcript text, or null if unavailable.
 */
export function pbRecordingDownloadUrl(callId: string): string {
  return `https://www.phoneburner.com/dialer/sessions/download_recording?call_id=${encodeURIComponent(callId)}`;
}

export async function transcribeRecording(callId: string | null): Promise<string | null> {
  if (!callId) return null;
  if (!isTranscriptionEnabled()) return null;

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.warn("[transcription] OPENAI_API_KEY not set — skipping");
    return null;
  }
  const pbKey = resolvePbApiKey();
  if (!pbKey) {
    console.warn("[transcription] PhoneBurner API key not set — cannot download recording");
    return null;
  }
  const downloadUrl = pbRecordingDownloadUrl(callId);

  try {
    const audioRes = await fetch(downloadUrl, {
      redirect: "follow",
      headers: { Authorization: `Bearer ${pbKey}` },
    });
    if (!audioRes.ok) {
      console.warn("[transcription] recording download", audioRes.status, downloadUrl);
      return null;
    }
    const ctype = audioRes.headers.get("content-type") || "";
    // No recording (or a login redirect) returns HTML, not audio — bail.
    if (!/audio|octet-stream|mpeg|mp3|wav|mp4/i.test(ctype)) {
      console.warn("[transcription] non-audio response", ctype, "for call", callId);
      return null;
    }
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      console.warn("[transcription] audio size out of range:", buf.length);
      return null;
    }

    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), "recording.mp3");
    form.append("model", TRANSCRIBE_MODEL);
    form.append("language", "en");

    const tRes = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });
    if (!tRes.ok) {
      console.error("[transcription] OpenAI", tRes.status, (await tRes.text()).slice(0, 300));
      return null;
    }
    const j = (await tRes.json()) as { text?: string };
    const text = (j.text ?? "").trim();
    return text || null;
  } catch (e) {
    console.error("[transcription] failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Return the saved transcript for a call, transcribing + persisting it
 * on first request. Idempotent: an already-transcribed call returns the
 * stored text without re-hitting the audio/AI. Persists a status so we
 * can see failures (`ok` | `failed` | `disabled` | `no_recording`).
 *
 * @returns transcript text or null.
 */
export async function getOrCreateTranscript(
  callId: string,
  _recordingUrl?: string | null, // kept for call-site compat; download is keyed by callId
): Promise<string | null> {
  const existing = sqlite
    .prepare("SELECT transcript FROM phoneburner_call_log WHERE id = ? LIMIT 1")
    .get(callId) as { transcript: string | null } | undefined;
  if (existing?.transcript && existing.transcript.trim()) return existing.transcript;

  const setStatus = (status: string, transcript?: string) => {
    try {
      sqlite
        .prepare(
          `UPDATE phoneburner_call_log
              SET transcript = COALESCE(?, transcript),
                  transcript_status = ?,
                  transcribed_at = datetime('now')
            WHERE id = ?`,
        )
        .run(transcript ?? null, status, callId);
    } catch (e) {
      console.error("[transcription] persist failed:", e instanceof Error ? e.message : e);
    }
  };

  if (!isTranscriptionEnabled()) { setStatus("disabled"); return null; }

  const text = await transcribeRecording(callId);
  setStatus(text ? "ok" : "failed", text ?? undefined);
  return text;
}
