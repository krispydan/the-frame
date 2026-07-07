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
// Bundled, same-origin Uppy styles. Static imports work in an App Router
// client component and guarantee the dashboard is always styled.
import "@uppy/core/dist/style.min.css";
import "@uppy/dashboard/dist/style.min.css";

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
  onUploadComplete,
}: {
  categories: UploaderCategory[];
  skus: UploaderSku[];
  onUploadComplete: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const uppyRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  // Batch defaults applied to every file added while they're set.
  const [categoryId, setCategoryId] = useState<string>("");
  const [audioMode, setAudioMode] = useState<"mute" | "keep">("mute");
  const [skuIds, setSkuIds] = useState<string[]>([]);
  const defaultsRef = useRef({ categoryId, audioMode, skuIds });
  defaultsRef.current = { categoryId, audioMode, skuIds };

  useEffect(() => {
    if (!containerRef.current) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const [{ default: Uppy }, { default: Dashboard }, { default: XHRUpload }] = await Promise.all([
        import("@uppy/core"),
        import("@uppy/dashboard"),
        import("@uppy/xhr-upload"),
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
      })
        .use(Dashboard, {
          inline: true,
          target: containerRef.current,
          height: 360,
          proudlyDisplayPoweredByUppy: false,
          showProgressDetails: true,
          note: "5-10s clips, up to 200MB each. Set the batch defaults above FIRST — files upload as soon as you drop them, tagged with those defaults.",
        })
        .use(XHRUpload, {
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
        });
      });

      uppy.on("complete", (result) => {
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
        if (result.failed && result.failed.length > 0) {
          toast.error(`${result.failed.length} upload${result.failed.length === 1 ? "" : "s"} failed`);
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
