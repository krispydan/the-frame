export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/transcription-diag  { callId }
 *
 * Probes exactly why a call recording won't transcribe:
 *   - resolves recording_url (row → PB getCall fallback)
 *   - downloads it several ways (bearer / no-auth / api_key query) and
 *     reports HTTP status, content-type, byte size, looks-like-audio
 *   - reports whether OPENAI_API_KEY / PB key are present
 *   - if we got audio + OpenAI key, attempts Whisper and returns the
 *     result or the raw error
 *
 * Auth: x-admin-key: jaxy2026
 */
function pbKey(): string | null {
  if (process.env.PHONEBURNER_API_KEY) return process.env.PHONEBURNER_API_KEY;
  const row = sqlite.prepare("SELECT value FROM settings WHERE key='phoneburner_api_key' LIMIT 1").get() as
    | { value: string | null } | undefined;
  return row?.value ?? null;
}

/** Pull candidate audio/media URLs out of the player HTML. */
function extractAudioUrls(html: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /https?:\/\/[^"'\s)]+\.(?:mp3|wav|m4a|mp4|ogg)(?:\?[^"'\s)]*)?/gi,
    /["']([^"']*(?:recording|audio|media|stream|download)[^"']*\.(?:mp3|wav|m4a)[^"']*)["']/gi,
    /["'](\/[^"']*(?:audio|recording|stream|download)[^"']*)["']/gi,
    /(?:src|href|data-src|file|url)\s*[:=]\s*["']([^"']+(?:mp3|wav|audio|recording|stream)[^"']*)["']/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      found.add(m[1] ?? m[0]);
      if (found.size > 40) break;
    }
  }
  return [...found];
}

async function probe(url: string, headers: Record<string, string>, scanHtml = false) {
  try {
    const res = await fetch(url, { redirect: "follow", headers });
    const ctype = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    const isAudio = /audio|octet-stream|mpeg|mp3|wav|mp4/i.test(ctype);
    const body = buf.toString("utf8");
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      contentType: ctype,
      bytes: buf.length,
      looksLikeAudio: isAudio,
      first80: buf.slice(0, 80).toString("utf8").replace(/[^\x20-\x7e]/g, "."),
      audioUrls: scanHtml && !isAudio ? extractAudioUrls(body) : undefined,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { callId?: string; tryWhisper?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const callId = String(body.callId || "").trim();
  if (!callId) return NextResponse.json({ error: "callId required" }, { status: 400 });

  const row = sqlite
    .prepare("SELECT recording_url, transcript_status, transcribed_at FROM phoneburner_call_log WHERE id = ?")
    .get(callId) as { recording_url: string | null; transcript_status: string | null; transcribed_at: string | null } | undefined;

  let recordingUrl = row?.recording_url ?? null;
  let pbGetCall: unknown = null;
  if (!recordingUrl) {
    try {
      const call = await phoneBurnerClient.getCall(callId, { include_recording: true });
      recordingUrl = call?.recording_url ?? null;
      pbGetCall = { recording_url: call?.recording_url ?? null };
    } catch (e) {
      pbGetCall = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const key = pbKey();
  const env = {
    openai_key_present: !!process.env.OPENAI_API_KEY,
    pb_key_present: !!key,
  };

  // The API's recording_url is a web PLAYER page, not the mp3. The real
  // download endpoint (from the PB UI) is keyed by call_id:
  const downloadUrl = `https://www.phoneburner.com/dialer/sessions/download_recording?call_id=${encodeURIComponent(callId)}`;

  const probes: Record<string, unknown> = {};
  probes.downloadBearer = await probe(downloadUrl, key ? { Authorization: `Bearer ${key}` } : {}, true);
  probes.downloadNoauth = await probe(downloadUrl, {}, true);
  if (recordingUrl) {
    probes.playerBearer = await probe(recordingUrl, key ? { Authorization: `Bearer ${key}` } : {}, false);
  }

  let whisper: unknown = null;
  const dlProbe = probes.downloadBearer as { looksLikeAudio?: boolean; bytes?: number } | undefined;
  if (body.tryWhisper && env.openai_key_present && dlProbe?.looksLikeAudio) {
    try {
      const dl = await fetch(downloadUrl, {
        redirect: "follow",
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      const audio = Buffer.from(await dl.arrayBuffer());
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/mpeg" }), "recording.mp3");
      form.append("model", "whisper-1");
      const wr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      const txt = await wr.text();
      whisper = { status: wr.status, body: txt.slice(0, 800) };
    } catch (e) {
      whisper = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({
    ok: true,
    callId,
    recordingUrl,
    downloadUrl,
    row_status: row?.transcript_status ?? null,
    pbGetCall,
    env,
    probes,
    whisper,
  });
}
