"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink, Upload, Check, Image as ImageIcon, Copy, RefreshCw,
} from "lucide-react";

interface QueueRow {
  id: string;
  audience: "retail" | "wholesale";
  scheduledDate: string;
  weekOf: string | null;
  status: string;
  name: string | null;
  subject: string | null;
  briefAngle: string | null;
  briefProductHook: string | null;
  heroVariant: string;
  secondaryImageVariant: string;
  heroImagePrompt: string | null;
  heroImageAlt: string | null;
  heroScrim: string | null;
  secondaryImagePrompt: string | null;
  secondaryImageAlt: string | null;
  secondaryImagePrompt2: string | null;
  secondaryImageAlt2: string | null;
  designerNotes: string | null;
  heroImagePath: string | null;
  secondaryImagePath: string | null;
  secondaryImagePath2: string | null;
  needsSecondary2: boolean;
  heroReady: boolean;
  secondaryReady: boolean;
  secondary2Ready: boolean;
  allReady: boolean;
}

const VARIANT_DIMS: Record<string, string> = {
  full_bleed_overlay: "1200×900",
  image_75_solid: "900×900",
  split_50_50: "600×900",
  full_bleed: "1200×800",
  centered_75: "900×800",
  grid_2up: "580×580 (×2)",
};

const SWATCHES = [
  { name: "Ivory / Cream", hex: "#FFFDF0" },
  { name: "Espresso (black)", hex: "#39341F" },
  { name: "Terracotta", hex: "#915127" },
  { name: "Sage Green", hex: "#D4E3BB" },
  { name: "Lavender", hex: "#DCDCEF" },
];

export default function DesignerQueuePage() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [summary, setSummary] = useState<{ total: number; pending: number; inReview: number; allReady: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/v1/marketing/email/designer-queue")
      .then(r => r.json())
      .then(data => {
        setRows(data.queue ?? []);
        setSummary(data.summary ?? null);
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Designer Queue</h1>
          <p className="text-muted-foreground">
            Campaigns awaiting Higgsfield renders. Each card shows the briefs +
            dimensions + drag-drop upload.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <a href="https://higgsfield.ai" target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm">
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Higgsfield
            </Button>
          </a>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Total in queue</div>
            <div className="font-medium text-lg">{summary.total}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">Pending render</div>
            <div className="font-medium text-lg">{summary.pending}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">In review</div>
            <div className="font-medium text-lg">{summary.inReview}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-muted-foreground">All images uploaded</div>
            <div className="font-medium text-lg">{summary.allReady}</div>
          </div>
        </div>
      )}

      {/* Brand swatches reference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Brand colors (V2) — click to copy hex</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {SWATCHES.map(s => (
              <button
                key={s.hex}
                onClick={() => navigator.clipboard.writeText(s.hex)}
                className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                title={`Copy ${s.hex}`}
              >
                <span className="w-4 h-4 rounded border" style={{ background: s.hex }} />
                {s.name}
                <span className="text-muted-foreground tabular-nums">{s.hex}</span>
                <Copy className="h-3 w-3 text-muted-foreground" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading queue…</div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <ImageIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No campaigns in the queue. Briefs land here once a campaign reaches
            <code className="mx-1 text-xs bg-muted px-1 py-0.5 rounded">photography</code>
            status (after Generate image prompts in the editor).
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map(c => (
            <QueueRowCard
              key={c.id}
              row={c}
              expanded={expanded.has(c.id)}
              onToggle={() => toggle(c.id)}
              onUploaded={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRowCard({
  row, expanded, onToggle, onUploaded,
}: {
  row: QueueRow;
  expanded: boolean;
  onToggle: () => void;
  onUploaded: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        {/* Header row — always visible */}
        <div className="flex items-center justify-between gap-3 cursor-pointer" onClick={onToggle}>
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Badge variant={row.audience === "wholesale" ? "default" : "outline"}>
              {row.audience}
            </Badge>
            <span className="text-sm text-muted-foreground tabular-nums shrink-0">
              {row.scheduledDate}
            </span>
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">
                {row.name ?? row.subject ?? "(untitled)"}
              </div>
              {(row.briefProductHook || row.briefAngle || row.subject) && (
                <div className="text-xs text-muted-foreground truncate">
                  {[row.briefProductHook, row.subject, row.briefAngle].filter(Boolean)[0]}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <UploadDot ready={row.heroReady} label="hero" />
            <UploadDot ready={row.secondaryReady} label="2nd" />
            {row.needsSecondary2 && <UploadDot ready={row.secondary2Ready} label="2nd-b" />}
            <Badge variant={row.allReady ? "default" : "outline"} className="text-xs">
              {row.allReady ? "All uploaded" : row.status}
            </Badge>
          </div>
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-4 pt-4 border-t space-y-4">
            <Link href={`/marketing/email/campaigns/${row.id}`}>
              <Button variant="link" size="sm" className="px-0">
                Open campaign editor →
              </Button>
            </Link>

            {row.designerNotes && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Strategy + style direction</div>
                <pre className="text-xs bg-muted p-3 rounded whitespace-pre-wrap font-mono">
                  {row.designerNotes}
                </pre>
              </div>
            )}

            {/* Hero slot */}
            <ImageSlot
              campaignId={row.id}
              kind="hero"
              variant={row.heroVariant}
              dims={VARIANT_DIMS[row.heroVariant] ?? "?"}
              prompt={row.heroImagePrompt}
              alt={row.heroImageAlt}
              extraNote={
                row.heroVariant === "full_bleed_overlay" && row.heroScrim
                  ? `Recommended scrim: ${row.heroScrim} (text overlays the top 30%)`
                  : null
              }
              currentPath={row.heroImagePath}
              onUploaded={onUploaded}
            />

            {/* Secondary slot */}
            <ImageSlot
              campaignId={row.id}
              kind="secondary"
              variant={row.secondaryImageVariant}
              dims={VARIANT_DIMS[row.secondaryImageVariant] ?? "?"}
              prompt={row.secondaryImagePrompt}
              alt={row.secondaryImageAlt}
              extraNote={row.needsSecondary2 ? "First of two — pairs with secondary_2 below" : null}
              currentPath={row.secondaryImagePath}
              onUploaded={onUploaded}
            />

            {/* Secondary 2 slot (grid_2up only) */}
            {row.needsSecondary2 && (
              <ImageSlot
                campaignId={row.id}
                kind="secondary_2"
                variant={row.secondaryImageVariant}
                dims={VARIANT_DIMS[row.secondaryImageVariant] ?? "?"}
                prompt={row.secondaryImagePrompt2}
                alt={row.secondaryImageAlt2}
                extraNote="Second of two — pairs with secondary above"
                currentPath={row.secondaryImagePath2}
                onUploaded={onUploaded}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UploadDot({ ready, label }: { ready: boolean; label: string }) {
  return (
    <div
      title={`${label}: ${ready ? "uploaded" : "missing"}`}
      className={`flex items-center gap-1 text-xs ${ready ? "text-foreground" : "text-muted-foreground"}`}
    >
      {ready ? (
        <Check className="h-3 w-3" />
      ) : (
        <div className="w-3 h-3 rounded-full border border-current" />
      )}
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}

function ImageSlot({
  campaignId, kind, variant, dims, prompt, alt, extraNote, currentPath, onUploaded,
}: {
  campaignId: string;
  kind: "hero" | "secondary" | "secondary_2";
  variant: string;
  dims: string;
  prompt: string | null;
  alt: string | null;
  extraNote: string | null;
  currentPath: string | null;
  onUploaded: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${campaignId}/upload-image`,
        { method: "POST", body: fd },
      );
      const data = await res.json();
      if (data.error) {
        setUploadError(data.error);
      } else {
        onUploaded();
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) handleUpload(file);
    else if (file) setUploadError(`Not an image: ${file.type}`);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {kind === "secondary_2" ? "Secondary 2" : kind}
          </div>
          <Badge variant="outline" className="text-xs">{variant}</Badge>
          <Badge variant="outline" className="text-xs">{dims}</Badge>
          {currentPath && (
            <Badge variant="default" className="text-xs">
              <Check className="h-3 w-3 mr-1" />
              Uploaded
            </Badge>
          )}
        </div>
      </div>

      {extraNote && (
        <div className="text-xs text-muted-foreground italic">{extraNote}</div>
      )}

      {prompt ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Higgsfield prompt</span>
            <button
              onClick={() => navigator.clipboard.writeText(prompt)}
              className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <pre className="text-xs bg-muted p-2 rounded whitespace-pre-wrap font-mono leading-relaxed">
            {prompt}
          </pre>
        </div>
      ) : (
        <div className="text-xs italic text-muted-foreground">
          No prompt generated yet — run &ldquo;Generate image prompts&rdquo; in the editor first.
        </div>
      )}

      {alt && (
        <div className="text-xs text-muted-foreground">
          <strong>Alt text:</strong> {alt}
        </div>
      )}

      {/* Drop zone */}
      <label
        className={`block border-2 border-dashed rounded-md p-4 text-center text-xs cursor-pointer transition-colors ${
          dragOver
            ? "border-foreground bg-accent"
            : currentPath
              ? "border-input bg-muted/30"
              : "border-input hover:bg-accent"
        } ${uploading ? "opacity-50 pointer-events-none" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <Upload className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
        {uploading ? (
          <span>Uploading…</span>
        ) : currentPath ? (
          <span>Replace — drop a new image here or click to pick</span>
        ) : (
          <span>Drop image here or click to pick</span>
        )}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
            e.target.value = "";
          }}
        />
      </label>

      {uploadError && (
        <div className="text-xs text-destructive">{uploadError}</div>
      )}

      {currentPath && (
        <div className="text-xs text-muted-foreground font-mono">{currentPath}</div>
      )}
    </div>
  );
}
