"use client";

import { useState, useEffect, useCallback } from "react";
import { Wand2, Save, History, FileText, Copy, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Product = {
  id: string;
  name: string | null;
  description: string | null;
  shortDescription: string | null;
  bulletPoints: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  category: string | null;
  frameShape: string | null;
  frameMaterial: string | null;
};

type CopyVersion = {
  id: string;
  fieldName: string | null;
  content: string | null;
  aiModel: string | null;
  createdAt: string | null;
};

const FIELDS = [
  { key: "description", label: "Description", maxChars: 2000 },
  { key: "short_description", label: "Short Description", maxChars: 160 },
  { key: "bullet_points", label: "Bullet Points", maxChars: 1000 },
  { key: "name", label: "Product Name", maxChars: 100 },
] as const;

export function CopyManagementTab({
  productId, product, onRefresh,
}: {
  productId: string;
  product: Product;
  onRefresh: () => void;
}) {
  const [activeField, setActiveField] = useState<string>("description");
  const [editValue, setEditValue] = useState("");
  const [versions, setVersions] = useState<CopyVersion[]>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [copied, setCopied] = useState(false);

  const currentField = FIELDS.find((f) => f.key === activeField)!;

  const getCurrentValue = useCallback((): string => {
    switch (activeField) {
      case "description": return product.description || "";
      case "short_description": return product.shortDescription || "";
      case "bullet_points": return product.bulletPoints || "";
      case "name": return product.name || "";
      default: return "";
    }
  }, [activeField, product]);

  useEffect(() => {
    setEditValue(getCurrentValue());
  }, [getCurrentValue]);

  const loadVersions = useCallback(async () => {
    const res = await fetch(`/api/v1/catalog/copy/versions?productId=${productId}&field=${activeField}`);
    const data = await res.json();
    setVersions(data.versions || []);
  }, [productId, activeField]);

  useEffect(() => { loadVersions(); }, [loadVersions]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/v1/catalog/copy/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, field: activeField }),
      });
      const data = await res.json();
      if (data.content) {
        setEditValue(data.content);
      } else if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      alert("Generation failed");
    }
    setGenerating(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const fieldMap: Record<string, string> = {
      description: "description",
      short_description: "shortDescription",
      bullet_points: "bulletPoints",
      name: "name",
    };

    await fetch(`/api/v1/catalog/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [fieldMap[activeField]]: editValue }),
    });

    // Save version
    await fetch("/api/v1/catalog/copy/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, fieldName: activeField, content: editValue }),
    });

    setSaving(false);
    onRefresh();
    loadVersions();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={activeField} onValueChange={(v) => v && setActiveField(v)}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FIELDS.map((f) => (
              <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={handleGenerate} disabled={generating}>
          <Wand2 className="h-3 w-3 mr-1" /> {generating ? "Generating..." : "AI Generate"}
        </Button>
        <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
          <Save className="h-3 w-3 mr-1" /> Save
        </Button>
        <Button size="sm" variant="ghost" onClick={handleCopy}>
          {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
          {copied ? "Copied!" : "Copy"}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => { setShowVersions(!showVersions); if (!showVersions) loadVersions(); }}>
          <History className="h-3 w-3 mr-1" /> Versions ({versions.length})
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center justify-between">
                {currentField.label}
                <span className="text-xs font-normal text-muted-foreground">
                  {editValue.length}/{currentField.maxChars}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={activeField === "description" ? 10 : activeField === "bullet_points" ? 8 : 3}
                placeholder={`Enter ${currentField.label.toLowerCase()}...`}
              />
            </CardContent>
          </Card>
        </div>

        <div>
          {/* Product context sidebar */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Product Context</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span>{product.name || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Category</span><span className="capitalize">{product.category || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Shape</span><span>{product.frameShape || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Material</span><span>{product.frameMaterial || "—"}</span></div>
            </CardContent>
          </Card>

          {/* Version history */}
          {showVersions && (
            <Card className="mt-4">
              <CardHeader><CardTitle className="text-sm">Version History</CardTitle></CardHeader>
              <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
                {versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No versions saved yet.</p>
                ) : (
                  versions.map((v) => (
                    <div
                      key={v.id}
                      className="p-2 border rounded text-xs cursor-pointer hover:bg-muted/50"
                      onClick={() => setEditValue(v.content || "")}
                    >
                      <div className="flex justify-between mb-1">
                        <Badge variant="outline" className="text-[10px]">{v.aiModel || "manual"}</Badge>
                        <span className="text-muted-foreground">{v.createdAt ? new Date(v.createdAt).toLocaleDateString() : ""}</span>
                      </div>
                      <p className="line-clamp-2">{v.content}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
