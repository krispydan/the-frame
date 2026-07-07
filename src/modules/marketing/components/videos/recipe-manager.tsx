"use client";

/**
 * Recipe manager — the video styles the composer mixes from.
 *
 * Each recipe = ordered category slots (min/max clips each) + an audio
 * policy + a weight in the daily mix. The list shows live health:
 * whether the current clip library can satisfy it and roughly how many
 * fresh permutations remain.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";

type Slot = { categories: string[]; min: number; max: number; optional?: boolean };

type Recipe = {
  id: string;
  name: string;
  description: string | null;
  pattern: Slot[];
  audioPolicy: "silent" | "original" | "lead_clip_only";
  durationTargetMin: number;
  durationTargetMax: number;
  weight: number;
  enabled: number;
  satisfiable: boolean;
  estimatedHeadroom: number;
};

type Category = { id: string; slug: string; name: string; archived: number };

const AUDIO_LABEL: Record<Recipe["audioPolicy"], string> = {
  silent: "Silent — trending audio added in TikTok",
  original: "Original — keep flagged clips' audio",
  lead_clip_only: "Lead clip only",
};

export function RecipeManager() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Recipe | "new" | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/v1/marketing/videos/recipes").then((r) => r.json()),
      fetch("/api/v1/marketing/videos/categories").then((r) => r.json()),
    ]).then(([recipesRes, catsRes]) => {
      setRecipes(recipesRes.recipes ?? []);
      setCategories((catsRes.categories ?? []).filter((c: Category) => !c.archived));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/v1/marketing/videos/recipes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) toast.error((await res.json()).error ?? "Update failed");
    load();
  };

  if (loading) return <div className="animate-pulse h-64 bg-muted rounded-lg" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground flex-1">
          The composer picks a style per slot (weighted), then fills it with your clips.
        </p>
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4 mr-1" /> New style
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {recipes.map((recipe) => (
          <Card key={recipe.id} className={recipe.enabled ? "" : "opacity-60"}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{recipe.name}</div>
                  {recipe.description && (
                    <div className="text-xs text-muted-foreground">{recipe.description}</div>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs shrink-0">
                  <input
                    type="checkbox"
                    checked={recipe.enabled === 1}
                    onChange={(e) => patch(recipe.id, { enabled: e.target.checked })}
                  />
                  enabled
                </label>
              </div>

              <div className="flex flex-wrap gap-1">
                {recipe.pattern.map((slot, i) => (
                  <Badge key={i} variant="secondary" className="text-[10px]">
                    {slot.categories.join("|")} ×{slot.min === slot.max ? slot.min : `${slot.min}-${slot.max}`}
                    {slot.optional ? "?" : ""}
                  </Badge>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{AUDIO_LABEL[recipe.audioPolicy]}</span>
                <span>· {recipe.durationTargetMin}-{recipe.durationTargetMax}s</span>
                <span>· weight {recipe.weight}</span>
              </div>

              <div className="flex items-center gap-2">
                {recipe.satisfiable ? (
                  <Badge variant="default" className="text-[10px]">
                    ~{recipe.estimatedHeadroom >= 1e6 ? "1M+" : recipe.estimatedHeadroom.toLocaleString()} unique videos left
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="text-[10px]">
                    not enough clips in these categories
                  </Badge>
                )}
                <div className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setEditing(recipe)}>Edit</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {editing && (
        <RecipeEditDialog
          recipe={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RecipeEditDialog({
  recipe,
  categories,
  onClose,
  onSaved,
}: {
  recipe: Recipe | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [description, setDescription] = useState(recipe?.description ?? "");
  const [audioPolicy, setAudioPolicy] = useState<Recipe["audioPolicy"]>(recipe?.audioPolicy ?? "silent");
  const [weight, setWeight] = useState(recipe?.weight ?? 2);
  const [durMin, setDurMin] = useState(recipe?.durationTargetMin ?? 15);
  const [durMax, setDurMax] = useState(recipe?.durationTargetMax ?? 30);
  const [slots, setSlots] = useState<Slot[]>(
    recipe?.pattern ?? [{ categories: [categories[0]?.slug ?? ""], min: 3, max: 5 }],
  );
  const [saving, setSaving] = useState(false);

  const updateSlot = (i: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  const toggleSlotCategory = (i: number, slug: string) => {
    setSlots((prev) =>
      prev.map((s, j) => {
        if (j !== i) return s;
        const has = s.categories.includes(slug);
        const categories = has ? s.categories.filter((c) => c !== slug) : [...s.categories, slug];
        return { ...s, categories };
      }),
    );
  };

  const save = async () => {
    setSaving(true);
    const body = {
      name,
      description,
      pattern: slots,
      audioPolicy,
      weight,
      durationTargetMin: durMin,
      durationTargetMax: durMax,
    };
    const res = recipe
      ? await fetch(`/api/v1/marketing/videos/recipes/${recipe.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      : await fetch("/api/v1/marketing/videos/recipes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (res.ok) {
      toast.success(recipe ? "Style updated" : "Style created");
      onSaved();
    } else {
      toast.error((await res.json()).error ?? "Save failed");
    }
  };

  const remove = async () => {
    if (!recipe) return;
    await fetch(`/api/v1/marketing/videos/recipes/${recipe.id}`, { method: "DELETE" });
    toast.success("Style deleted");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* sm:max-w-2xl — the base DialogContent pins sm:max-w-sm, and an
          unprefixed max-w-2xl loses to it at desktop widths. */}
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{recipe ? `Edit: ${recipe.name}` : "New video style"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex gap-2">
            <label className="block flex-1">
              <span className="text-muted-foreground">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Flat-lay compilation" className="mt-1" />
            </label>
            <label className="block w-24">
              <span className="text-muted-foreground">Weight</span>
              <Input type="number" min={1} value={weight} onChange={(e) => setWeight(Number(e.target.value) || 1)} className="mt-1" />
            </label>
          </div>
          <label className="block">
            <span className="text-muted-foreground">Description</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
          </label>
          <div className="flex gap-2">
            <label className="block flex-1">
              <span className="text-muted-foreground">Audio policy</span>
              <select value={audioPolicy} onChange={(e) => setAudioPolicy(e.target.value as Recipe["audioPolicy"])} className="mt-1 w-full border rounded px-2 py-1.5 bg-background">
                <option value="silent">Silent — trending audio added in TikTok</option>
                <option value="original">Original — keep flagged clips&apos; audio</option>
                <option value="lead_clip_only">Lead clip only</option>
              </select>
            </label>
            <label className="block w-24">
              <span className="text-muted-foreground">Min sec</span>
              <Input type="number" value={durMin} onChange={(e) => setDurMin(Number(e.target.value) || 15)} className="mt-1" />
            </label>
            <label className="block w-24">
              <span className="text-muted-foreground">Max sec</span>
              <Input type="number" value={durMax} onChange={(e) => setDurMax(Number(e.target.value) || 30)} className="mt-1" />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Sequence — slot 1 opens the video</span>
              <Button size="sm" variant="outline" onClick={() => setSlots((prev) => [...prev, { categories: [], min: 1, max: 2 }])}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Slot
              </Button>
            </div>
            {slots.map((slot, i) => (
              <div key={i} className="rounded border p-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">Slot {i + 1}</span>
                  <label className="flex items-center gap-1 text-xs">
                    min
                    <Input type="number" min={0} value={slot.min} onChange={(e) => updateSlot(i, { min: Number(e.target.value) || 0 })} className="h-7 w-14" />
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    max
                    <Input type="number" min={1} value={slot.max} onChange={(e) => updateSlot(i, { max: Number(e.target.value) || 1 })} className="h-7 w-14" />
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={slot.optional ?? false} onChange={(e) => updateSlot(i, { optional: e.target.checked })} />
                    optional
                  </label>
                  <div className="flex-1" />
                  {slots.length > 1 && (
                    <Button size="sm" variant="ghost" onClick={() => setSlots((prev) => prev.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {categories.map((c) => (
                    <button
                      key={c.slug}
                      type="button"
                      onClick={() => toggleSlotCategory(i, c.slug)}
                      className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        slot.categories.includes(c.slug)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background hover:bg-muted"
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-between gap-2 pt-2">
          {recipe ? (
            <Button variant="outline" size="sm" onClick={remove}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving || !name.trim() || slots.some((s) => s.categories.length === 0)}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
