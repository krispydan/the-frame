"use client";

/**
 * Auto-clipper — upload raw shoot footage and let the server carve it
 * into 3-5s library clips (scene-aware, tagged with the defaults you
 * set here). Replaces the manual "send footage to an editor to cut
 * hundreds of clips" step.
 *
 * Includes the sources status panel: each raw video shows its split
 * progress and how many clips it produced (clips then normalize in the
 * background like any upload).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Scissors, Trash2 } from "lucide-react";
import type { UploaderCategory, UploaderSku } from "./clip-uploader";
import { sha256Hex16, directUploadAvailable } from "./direct-upload";
import "@uppy/core/dist/style.min.css";
import "@uppy/dashboard/dist/style.min.css";

const PRESIGN_URL = "/api/v1/marketing/videos/sources/presign";
const REGISTER_URL = "/api/v1/marketing/videos/sources/register";

type Source = {
  id: string;
  file_name: string;
  status: "uploaded" | "splitting" | "done" | "failed";
  duration_sec: number | null;
  clip_count: number;
  ready_clips: number;
  category_name: string | null;
  talent: string | null;
  raw_deleted: number;
  error: string | null;
  created_at: string;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  done: "default",
  uploaded: "secondary",
  splitting: "secondary",
  failed: "destructive",
};

export function SourceAutoClipper({
  categories,
  skus,
  talents,
  onClipsChanged,
}: {
  categories: UploaderCategory[];
  skus: UploaderSku[];
  talents: string[];
  onClipsChanged: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);

  // Defaults stamped on every clip the split produces.
  const [categoryId, setCategoryId] = useState("");
  const [audioMode, setAudioMode] = useState<"mute" | "keep">("mute");
  const [talent, setTalent] = useState("");
  const [skuIds, setSkuIds] = useState<string[]>([]);
  const [minClipSec, setMinClipSec] = useState(3);
  const [maxClipSec, setMaxClipSec] = useState(5);
  const defaultsRef = useRef({ categoryId, audioMode, talent, skuIds, minClipSec, maxClipSec });
  defaultsRef.current = { categoryId, audioMode, talent, skuIds, minClipSec, maxClipSec };

  const loadSources = useCallback(() => {
    fetch("/api/v1/marketing/videos/sources")
      .then((r) => r.json())
      .then((d) => setSources(d.sources ?? []));
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  // Poll while any source is queued/splitting, and refresh the clip
  // grid as new clips appear.
  useEffect(() => {
    const active = sources.some((s) => s.status === "uploaded" || s.status === "splitting");
    if (!active) return;
    const t = setInterval(() => {
      loadSources();
      onClipsChanged();
    }, 6000);
    return () => clearInterval(t);
  }, [sources, loadSources, onClipsChanged]);

  useEffect(() => {
    if (!containerRef.current) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      // Big raw files → prefer direct-to-R2 (browser → R2). Buffering a
      // 400MB source through the server is exactly the OOM we're fixing.
      const direct = await directUploadAvailable(PRESIGN_URL);
      if (cancelled || !containerRef.current) return;

      const [{ default: Uppy }, { default: Dashboard }] = await Promise.all([
        import("@uppy/core"),
        import("@uppy/dashboard"),
      ]);
      if (cancelled || !containerRef.current) return;

      const uppy = new Uppy({
        id: "video-source-uploader",
        autoProceed: true,
        restrictions: {
          maxFileSize: 400 * 1024 * 1024,
          allowedFileTypes: ["video/*", ".mp4", ".mov", ".m4v", ".webm", ".mkv"],
        },
        meta: {},
      }).use(Dashboard, {
        inline: true,
        target: containerRef.current,
        height: 260,
        proudlyDisplayPoweredByUppy: false,
        showProgressDetails: true,
        note: "Raw videos up to 400MB each (export long shoots in parts). Set the defaults above FIRST — every clip cut from the video gets them.",
      });

      const registerResults: Array<{ ok: boolean; deduped: boolean }> = [];
      const registerPromises: Array<Promise<void>> = [];

      if (direct) {
        const { default: AwsS3 } = await import("@uppy/aws-s3");
        if (cancelled) return;
        uppy.use(AwsS3, {
          shouldUseMultipart: false,
          getUploadParameters: async (file) => {
            const checksum = await sha256Hex16(file.data as Blob);
            uppy.setFileMeta(file.id, { checksum });
            const res = await fetch(PRESIGN_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                fileName: file.name,
                checksum,
                contentType: file.type || "video/mp4",
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.uploadUrl) {
              throw new Error(body.error || "Could not presign upload");
            }
            return {
              method: "PUT",
              url: body.uploadUrl as string,
              fields: {},
              headers: (body.headers as Record<string, string>) || {
                "Content-Type": file.type || "video/mp4",
              },
            };
          },
        });

        uppy.on("upload-success", (file) => {
          const d = defaultsRef.current;
          const checksum = (file?.meta as Record<string, unknown> | undefined)?.checksum as
            | string
            | undefined;
          if (!checksum) return;
          registerPromises.push(
            fetch(REGISTER_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                checksum,
                fileName: file?.name,
                categoryId: d.categoryId,
                audioMode: d.audioMode,
                talent: d.talent.trim(),
                skuIds: d.skuIds,
                minClipSec: d.minClipSec,
                maxClipSec: d.maxClipSec,
              }),
            })
              .then(async (res) => {
                const b = await res.json().catch(() => ({}));
                registerResults.push({ ok: res.ok, deduped: !!b.deduped });
              })
              .catch(() => {
                registerResults.push({ ok: false, deduped: false });
              }),
          );
        });
      } else {
        const { default: XHRUpload } = await import("@uppy/xhr-upload");
        if (cancelled) return;
        uppy.use(XHRUpload, {
          endpoint: "/api/v1/marketing/videos/sources",
          formData: true,
          fieldName: "file",
          bundle: false,
          timeout: 15 * 60_000,
          // One at a time — sources are big and buffer server-side.
          limit: 1,
          getResponseData: (xhr: XMLHttpRequest) => {
            try {
              return JSON.parse(xhr.responseText);
            } catch {
              return {};
            }
          },
        });

        uppy.on("file-added", (file) => {
          const d = defaultsRef.current;
          uppy.setFileMeta(file.id, {
            categoryId: d.categoryId,
            audioMode: d.audioMode,
            talent: d.talent.trim(),
            skuIds: JSON.stringify(d.skuIds),
            minClipSec: String(d.minClipSec),
            maxClipSec: String(d.maxClipSec),
          });
        });
      }

      uppy.on("complete", async (result) => {
        const failedUploads = result.failed?.length ?? 0;
        let ok: number;
        let failed: number;
        if (direct) {
          await Promise.all(registerPromises);
          ok = registerResults.filter((r) => r.ok).length;
          failed = failedUploads + registerResults.filter((r) => !r.ok).length;
        } else {
          ok = result.successful?.length ?? 0;
          failed = failedUploads;
        }
        if (ok > 0) toast.success(`${ok} video${ok === 1 ? "" : "s"} uploaded — auto-clipping in the background`);
        if (failed > 0) toast.error(`${failed} upload${failed === 1 ? "" : "s"} failed`);
        loadSources();
      });

      uppy.on("upload-error", (file, error, response) => {
        const detail =
          (response?.body as { error?: string } | undefined)?.error ?? error?.message ?? "Unknown error";
        toast.error(`${file?.name ?? "File"}: ${detail}`);
      });

      setReady(true);
      cleanup = () => {
        try {
          (uppy as { destroy?: () => void }).destroy?.();
        } catch { /* ignore */ }
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resplit = async (id: string) => {
    const res = await fetch(`/api/v1/marketing/videos/sources/${id}`, { method: "POST" });
    if (res.ok) toast.success("Re-split queued");
    else toast.error((await res.json()).error ?? "Failed");
    loadSources();
  };

  const remove = async (id: string) => {
    await fetch(`/api/v1/marketing/videos/sources/${id}`, { method: "DELETE" });
    toast.success("Source removed (its clips stay in the library)");
    loadSources();
  };

  const toggleSku = (id: string) =>
    setSkuIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Scissors className="h-4 w-4" /> Auto-clip raw footage
        <span className="font-normal text-muted-foreground">
          — drop whole shoot videos; the server cuts them into {minClipSec}-{maxClipSec}s clips at scene changes, then deletes the original
        </span>
      </div>

      {/* Defaults for the generated clips */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
        <span className="font-medium">Clip defaults:</span>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Category</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="border rounded px-2 py-1 text-sm bg-background">
            <option value="">(untagged)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Person</span>
          <input
            list="source-talents"
            value={talent}
            onChange={(e) => setTalent(e.target.value)}
            placeholder="no one"
            className="w-28 border rounded px-2 py-1 text-sm bg-background"
          />
          <datalist id="source-talents">
            {talents.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Audio</span>
          <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as "mute" | "keep")} className="border rounded px-2 py-1 text-sm bg-background">
            <option value="mute">Mute</option>
            <option value="keep">Keep</option>
          </select>
        </label>
        <details className="relative">
          <summary className="cursor-pointer select-none border rounded px-2 py-1 bg-background">
            Products {skuIds.length > 0 ? `(${skuIds.length})` : ""}
          </summary>
          <div className="absolute z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border bg-background p-2 shadow-lg">
            {skus.map((s) => (
              <label key={s.id} className="flex items-center gap-2 px-1 py-0.5 hover:bg-muted rounded cursor-pointer">
                <input type="checkbox" checked={skuIds.includes(s.id)} onChange={() => toggleSku(s.id)} />
                <span className="truncate">
                  {s.productName ?? s.sku} {s.colorName ? `— ${s.colorName}` : ""}
                  {s.sku && <span className="text-muted-foreground ml-1">({s.sku})</span>}
                </span>
              </label>
            ))}
          </div>
        </details>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Clip length</span>
          <Input type="number" min={2} max={10} value={minClipSec} onChange={(e) => setMinClipSec(Number(e.target.value) || 3)} className="h-7 w-14" />
          <span className="text-muted-foreground">to</span>
          <Input type="number" min={minClipSec} max={12} value={maxClipSec} onChange={(e) => setMaxClipSec(Number(e.target.value) || 5)} className="h-7 w-14" />
          <span className="text-muted-foreground">sec</span>
        </label>
      </div>

      <div ref={containerRef} />
      {!ready && <div className="animate-pulse h-52 bg-muted rounded-lg" />}

      {/* Sources status list */}
      {sources.length > 0 && (
        <div className="space-y-1">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <Badge variant={STATUS_VARIANT[s.status] ?? "outline"}>
                {s.status === "splitting" || s.status === "uploaded" ? (
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                ) : null}
                {s.status === "uploaded" ? "queued" : s.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate" title={s.file_name}>
                {s.file_name}
                {s.duration_sec != null && (
                  <span className="text-muted-foreground"> · {Math.round(s.duration_sec)}s</span>
                )}
                {s.talent && <span className="text-muted-foreground"> · 👤{s.talent}</span>}
                {s.category_name && <span className="text-muted-foreground"> · {s.category_name}</span>}
              </span>
              {s.status === "done" && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {s.clip_count} clips ({s.ready_clips} ready)
                  {s.raw_deleted ? <span className="ml-1 opacity-70">· original removed</span> : null}
                </span>
              )}
              {s.status === "failed" && s.error && (
                <span className="max-w-[200px] truncate text-xs text-destructive" title={s.error}>{s.error}</span>
              )}
              {/* Re-split needs the raw footage; once it's deleted the button hides. */}
              {(s.status === "failed" || (s.status === "done" && !s.raw_deleted)) && (
                <Button size="sm" variant="ghost" title="Re-split" onClick={() => resplit(s.id)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button size="sm" variant="ghost" title="Remove source (clips stay)" onClick={() => remove(s.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
