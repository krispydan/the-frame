import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, LayoutList } from "lucide-react";
import { RecipeManager } from "@/modules/marketing/components/videos/recipe-manager";

/** Video Remix Studio — video styles (recipes) the composer mixes from. */
export default function RecipesPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <LayoutList className="h-7 w-7" /> Video Styles
          </h1>
          <p className="text-muted-foreground mt-1">
            A style is a sequence of clip categories + an audio policy — &ldquo;all flat lays&rdquo;,
            &ldquo;UGC unboxing + b-roll&rdquo;, &ldquo;hook + showcase&rdquo;. The composer mixes
            them per posting slot.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/marketing/videos" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Post Queue
        </Button>
      </div>
      <RecipeManager />
    </div>
  );
}
