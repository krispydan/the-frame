"use client";

/**
 * Uppy-powered clip uploader for the Video Remix Studio.
 *
 * Batch-defaults bar: pick a category / products / audio flag ONCE,
 * drop 30 files, and every file in the batch uploads pre-tagged —
 * nobody tags 300 clips one at a time. Defaults are attached as Uppy
 * meta on file-added and travel as multipart form fields.
 *
 * The Uppy JS is dynamically imported so it never runs on the server.
 * The CSS is bundled from the installed packages (NOT a third-party CDN
 * — that link was unreachable in prod, leaving the dashboard unstyled).
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { sha256Hex16, directUploadAvailable } from "./direct-upload";
// Bundled, same-origin Uppy styles. Static imports work in an App Router
// client component and guarantee the dashboard is always styled.
import "@uppy/core/dist/style.min.css";
import "@uppy/dashboard/dist/style.min.css";

const PRESIGN_URL = "/api/v1/marketing/videos/clips/presign";
const REGISTER_URL = "/api/v1/marketing/videos/clips/register";

export interface UploaderCategory {
  id: string;
  slug: string;
  name: string;
}

export interface UploaderSku {
  id: string;
  sku: string | null;
  colorName: string | null;
  productName: string | null;
}

export function ClipUploader({
  categories,
  skus,
  talents = [],
  onUploadComplete,
}: {
  categories: UploaderCategory[];
  skus: UploaderSku[];
  /** Known model/actor names — powers the datalist so spelling stays consistent. */
  talents?: string[];
  onUploadComplete: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const uppyRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  // Batch defaults applied to every file added while they're set.
  const [categoryId, setCategoryId] = useState<string>("");
  const [audioMode, setAudioMode] = useState<"mute" | "keep">("mute");
  const [skuIds, setSkuIds] = useState<string[]>([]);
  const [talent, setTalent] = useState("");
  const defaultsRef = useRef({ categoryId, audioMode, skuIds, talent });
  defaultsRef.current = { categoryId, audioMode, skuIds, talent };

  useEffect(() => {
    if (!containerRef.current) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      // Prefer direct-to-R2 upload (browser → R2, never through this
      // server). Falls back to the through-server multipart route when R2
      // isn't configured (local dev).
      const direct = await directUploadAvailable(PRESIGN_URL);
      if (cancelled || !containerRef.current) return;

      const [{ default: Uppy }, { default: Dashboard }] = await Promise.all([
        import("@uppy/core"),
        import("@uppy/dashboard"),
      ]);
      if (cancelled || !containerRef.current) return;

      const uppy = new Uppy({
        id: "video-clip-uploader",
        // Upload as soon as files are dropped — batch defaults are set
        // above beforehand, so there's no per-file step to wait for.
        autoProceed: true,
        restrictions: {
          maxFileSize: 200 * 1024 * 1024,
          allowedFileTypes: ["video/*", ".mp4", ".mov", ".m4v", ".webm"],
        },
        meta: {},
      }).use(Dashboard, {
        inline: true,
        target: containerRef.current,
        height: 360,
        proudlyDisplayPoweredByUppy: false,
        showProgressDetails: true,
        note: "5-10s clips, up to 200MB each. Set the batch defaults above FIRST — files upload as soon as you drop them, tagged with those defaults.",
      });

      // After a direct upload lands in R2, we record the DB row via
      // /register. Track those calls so the "complete" summary waits for
      // them (Uppy doesn't await event handlers).
      const registerResults: Array<{ ok: boolean; deduped: boolean }> = [];
      const registerPromises: Array<Promise<void>> = [];

      if (direct) {
        const { default: AwsS3 } = await import("@uppy/aws-s3");
        if (cancelled) return;
        uppy.use(AwsS3, {
          shouldUseMultipart: false,
          // Single presigned PUT straight to R2.
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
                skuIds: d.skuIds,
                audioMode: d.audioMode,
                talent: d.talent.trim(),
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
          endpoint: "/api/v1/marketing/videos/clips/upload",
          formData: true,
          fieldName: "file",
          bundle: false,
          timeout: 10 * 60_000,
          // 2 concurrent — uploads buffer server-side; don't spike RAM.
          limit: 2,
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
            skuIds: JSON.stringify(d.skuIds),
            talent: d.talent.trim(),
          });
        });
      }

      uppy.on("complete", async (result) => {
        const failedUploads = result.failed?.length ?? 0;
        if (direct) {
          // Wait for the register calls kicked off in upload-success.
          await Promise.all(registerPromises);
          const ok = registerResults.filter((r) => r.ok).length;
          const deduped = registerResults.filter((r) => r.ok && r.deduped).length;
          const failed = failedUploads + registerResults.filter((r) => !r.ok).length;
          if (ok > 0) {
            toast.success(
              `Uploaded ${ok} clip${ok === 1 ? "" : "s"}` +
                (deduped > 0 ? ` (${deduped} already existed)` : "") +
                " — normalizing in the background",
            );
          }
          if (failed > 0) toast.error(`${failed} upload${failed === 1 ? "" : "s"} failed`);
        } else {
          const ok = result.successful?.length ?? 0;
          const deduped = (result.successful ?? []).filter(
            (f) => (f.response?.body as { deduped?: boolean } | undefined)?.deduped,
          ).length;
          if (ok > 0) {
            toast.success(
              `Uploaded ${ok} clip${ok === 1 ? "" : "s"}` +
                (deduped > 0 ? ` (${deduped} already existed)` : "") +
                " — normalizing in the background",
            );
          }
          if (failedUploads > 0) {
            toast.error(`${failedUploads} upload${failedUploads === 1 ? "" : "s"} failed`);
          }
        }
        onUploadComplete();
      });

      uppy.on("upload-error", (file, error, response) => {
        const detail =
          (response?.body as { error?: string } | undefined)?.error ?? error?.message ?? "Unknown error";
        toast.error(`${file?.name ?? "File"}: ${detail}`);
      });

      uppyRef.current = uppy;
      setReady(true);
      cleanup = () => {
        try {
          (uppy as { destroy?: () => void }).destroy?.();
        } catch {
          /* ignore */
        }
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // Init once per mount; defaults flow through defaultsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSku = (id: string) => {
    setSkuIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  return (
    <div className="space-y-3">
      {/* Batch defaults bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
        <span className="font-medium">Batch defaults:</span>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Category</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-background"
          >
            <option value="">(untagged)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Audio</span>
          <select
            value={audioMode}
            onChange={(e) => setAudioMode(e.target.value as "mute" | "keep")}
            className="border rounded px-2 py-1 text-sm bg-background"
          >
            <option value="mute">Mute (trending audio later)</option>
            <option value="keep">Keep — audio is worth using</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Person</span>
          <input
            list="clip-talents"
            value={talent}
            onChange={(e) => setTalent(e.target.value)}
            placeholder="no one"
            className="w-32 border rounded px-2 py-1 text-sm bg-background"
          />
          <datalist id="clip-talents">
            {talents.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <details className="relative">
          <summary className="cursor-pointer select-none border rounded px-2 py-1 bg-background">
            Products {skuIds.length > 0 ? `(${skuIds.length})` : ""}
          </summary>
          <div className="absolute z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border bg-background p-2 shadow-lg">
            {skus.length === 0 && <div className="text-muted-foreground p-1">No SKUs found</div>}
            {skus.map((s) => (
              <label key={s.id} className="flex items-center gap-2 px-1 py-0.5 hover:bg-muted rounded cursor-pointer">
                <input
                  type="checkbox"
                  checked={skuIds.includes(s.id)}
                  onChange={() => toggleSku(s.id)}
                />
                <span className="truncate">
                  {s.productName ?? s.sku} {s.colorName ? `— ${s.colorName}` : ""}
                  {/* sku code distinguishes same-name variants (sizes, powers) */}
                  {s.sku && <span className="text-muted-foreground ml-1">({s.sku})</span>}
                </span>
              </label>
            ))}
          </div>
        </details>
      </div>

      <div ref={containerRef} />
      {!ready && <div className="animate-pulse h-72 bg-muted rounded-lg" />}
    </div>
  );
}
