"use client";

import { useState } from "react";
import { Wand2, Plus, X, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type TagItem = { id: string; tagName: string | null; dimension: string | null; source: string | null };

const DIMENSIONS = [
  "frame_shape", "style", "occasion", "face_shape", "material",
  "lens_type", "gender", "activity", "season", "other",
];

export function TagManagementTab({
  productId, tags, onRefresh,
}: {
  productId: string;
  tags: TagItem[];
  onRefresh: () => void;
}) {
  const [newTag, setNewTag] = useState("");
  const [newDimension, setNewDimension] = useState("style");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<{ tagName: string; dimension: string }[]>([]);

  const grouped = tags.reduce<Record<string, TagItem[]>>((acc, t) => {
    const dim = t.dimension || "other";
    if (!acc[dim]) acc[dim] = [];
    acc[dim].push(t);
    return acc;
  }, {});

  const handleAddTag = async () => {
    if (!newTag.trim()) return;
    await fetch("/api/v1/catalog/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, tagName: newTag.trim(), dimension: newDimension, source: "manual" }),
    });
    setNewTag("");
    onRefresh();
  };

  const handleDeleteTag = async (tagId: string) => {
    await fetch(`/api/v1/catalog/tags/${tagId}`, { method: "DELETE" });
    onRefresh();
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const res = await fetch("/api/v1/catalog/tags/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch {
      alert("Tag suggestion failed");
    }
    setSuggesting(false);
  };

  const handleAcceptSuggestion = async (tagName: string, dimension: string) => {
    await fetch("/api/v1/catalog/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, tagName, dimension, source: "ai" }),
    });
    setSuggestions((prev) => prev.filter((s) => s.tagName !== tagName));
    onRefresh();
  };

  return (
    <div className="space-y-4">
      {/* Add tag + AI suggest */}
      <div className="flex items-center gap-3">
        <Select value={newDimension} onValueChange={(v) => v && setNewDimension(v)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {DIMENSIONS.map((d) => (
              <SelectItem key={d} value={d}>{d.replace("_", " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Add tag..."
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          className="max-w-[200px]"
          onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
        />
        <Button size="sm" onClick={handleAddTag}><Plus className="h-3 w-3 mr-1" /> Add</Button>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={handleSuggest} disabled={suggesting}>
          <Wand2 className="h-3 w-3 mr-1" /> {suggesting ? "Suggesting..." : "AI Suggest"}
        </Button>
      </div>

      {/* AI Suggestions */}
      {suggestions.length > 0 && (
        <Card className="border-dashed border-primary/50">
          <CardHeader><CardTitle className="text-sm">AI Suggestions</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <Badge
                  key={`${s.dimension}-${s.tagName}`}
                  variant="outline"
                  className="cursor-pointer hover:bg-primary/10 pr-1"
                  onClick={() => handleAcceptSuggestion(s.tagName, s.dimension)}
                >
                  {s.tagName}
                  <span className="text-[10px] text-muted-foreground ml-1">({s.dimension.replace("_", " ")})</span>
                  <Plus className="h-3 w-3 ml-1" />
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing tags */}
      {Object.keys(grouped).length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            <Tag className="h-12 w-12 mx-auto opacity-50 mb-2" />
            <p>No tags yet. Add manually or use AI suggestions.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Object.entries(grouped).map(([dim, items]) => (
            <Card key={dim}>
              <CardHeader>
                <CardTitle className="text-sm capitalize">{dim.replace("_", " ")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {items.map((t) => (
                    <Badge key={t.id} variant={t.source === "ai" ? "secondary" : "default"} className="pr-1">
                      {t.tagName}
                      <button
                        className="ml-1 hover:text-destructive"
                        onClick={() => handleDeleteTag(t.id)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
