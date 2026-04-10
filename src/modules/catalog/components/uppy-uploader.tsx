"use client";

/**
 * Uppy-powered catalog image uploader.
 *
 * Features:
 * - Drag-and-drop multi-file
 * - Inline crop/rotate editor before upload
 * - Auto-SKU match from filename: <sku>-<colorName>-<angle>.jpg
 * - Falls back to a per-file SKU picker when no match is found
 * - Direct XHR upload to /api/v1/catalog/images/upload with per-file
 *   skuId as a form field
 *
 * Uppy is imported dynamically so it never runs on the server — its
 * CSS and web-worker bits break SSR.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  matchSkuFromFilename,
  type UploaderSku,
} from "@/modules/catalog/lib/match-sku-filename";

// CSS is loaded via <link> tags on the client to avoid SSR import issues
const UPPY_CSS = [
  "https://releases.transloadit.com/uppy/v4.16.1/uppy.min.css",
];

export function UppyUploader({
  skus,
  onUploadComplete,
}: {
  skus: UploaderSku[];
  onUploadComplete: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const uppyRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  // Lookup SKUs by id for display
  const skuById = useMemo(() => {
    const m = new Map<string, UploaderSku>();
    for (const s of skus) m.set(s.id, s);
    return m;
  }, [skus]);

  // Default fallback SKU for files that don't auto-match
  const [fallbackSkuId, setFallbackSkuId] = useState<string>(
    skus[0]?.id ?? "",
  );

  useEffect(() => {
    if (!containerRef.current) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    // Inject Uppy CSS once
    for (const href of UPPY_CSS) {
      if (!document.head.querySelector(`link[href="${href}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
      }
    }

    (async () => {
      const [{ default: Uppy }, { default: Dashboard }, { default: XHRUpload }, { default: ImageEditor }] =
        await Promise.all([
          import("@uppy/core"),
          import("@uppy/dashboard"),
          import("@uppy/xhr-upload"),
          import("@uppy/image-editor"),
        ]);

      if (cancelled || !containerRef.current) return;

      const uppy = new Uppy({
        id: "catalog-image-uploader",
        autoProceed: false,
        restrictions: {
          maxFileSize: 10 * 1024 * 1024,
          allowedFileTypes: ["image/*"],
        },
        meta: {},
      })
        .use(Dashboard, {
          inline: true,
          target: containerRef.current,
          height: 420,
          proudlyDisplayPoweredByUppy: false,
          showProgressDetails: true,
          note: "Drag or pick images. Filename pattern <sku>-<color>-<angle>.jpg auto-matches a SKU. Files will be center-cropped to 1:1 and resized to 2000×2000.",
          metaFields: [
            { id: "skuId", name: "SKU", placeholder: "Auto-detected from filename" },
          ],
        })
        .use(ImageEditor, {
          target: Dashboard,
          quality: 0.9,
          cropperOptions: {
            viewMode: 1,
            aspectRatio: 1,
            background: false,
            autoCropArea: 1,
          },
        })
        .use(XHRUpload, {
          endpoint: "/api/v1/catalog/images/upload",
          formData: true,
          fieldName: "file",
          bundle: false,
          timeout: 60_000,
          limit: 3,
          // Read per-file skuId from Uppy meta
          getResponseData: (xhr) => {
            try {
              return JSON.parse(xhr.responseText);
            } catch {
              return {};
            }
          },
        });

      // Auto-match SKU when files are added
      uppy.on("file-added", (file) => {
        const matched = matchSkuFromFilename(file.name ?? "", skus);
        uppy.setFileMeta(file.id, {
          skuId: matched ?? fallbackSkuId,
        });
      });

      uppy.on("complete", (result) => {
        if (result.successful && result.successful.length > 0) {
          toast.success(`Uploaded ${result.successful.length} image${result.successful.length === 1 ? "" : "s"}`);
        }
        if (result.failed && result.failed.length > 0) {
          toast.error(`${result.failed.length} upload${result.failed.length === 1 ? "" : "s"} failed`);
        }
        onUploadComplete();
      });

      uppy.on("upload-error", (file, error, response) => {
        const detail =
          (response?.body as { error?: string } | undefined)?.error ??
          error?.message ??
          "Unknown error";
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
    // We intentionally only init Uppy once per mount — skus/fallback
    // are captured via the closure above and updated via the
    // file-added handler on subsequent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the auto-match handler in sync with the latest skus + fallback
  useEffect(() => {
    const uppy = uppyRef.current as
      | { off: (e: string, cb: unknown) => void; on: (e: string, cb: unknown) => void; setFileMeta: (id: string, meta: unknown) => void }
      | null;
    if (!uppy) return;
    const handler = (file: { id: string; name?: string }) => {
      const matched = matchSkuFromFilename(file.name ?? "", skus);
      uppy.setFileMeta(file.id, { skuId: matched ?? fallbackSkuId });
    };
    uppy.on("file-added", handler);
    return () => uppy.off("file-added", handler);
  }, [skus, fallbackSkuId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <label className="text-muted-foreground">Default SKU (for files with no filename match):</label>
        <select
          value={fallbackSkuId}
          onChange={(e) => setFallbackSkuId(e.target.value)}
          className="border rounded px-2 py-1 text-sm bg-background"
        >
          {skus.map((s) => (
            <option key={s.id} value={s.id}>
              {s.sku} {s.colorName ? `— ${s.colorName}` : ""}
            </option>
          ))}
        </select>
      </div>
      <div ref={containerRef} />
      {!ready && (
        <div className="text-sm text-muted-foreground">Loading uploader…</div>
      )}
      {ready && skus.length === 0 && (
        <div className="text-sm text-destructive">No SKUs available for this product. Create a SKU first.</div>
      )}
    </div>
  );
}
