import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Clapperboard, Film, LayoutList } from "lucide-react";
import { PostQueue } from "@/modules/marketing/components/videos/post-queue";

/**
 * Video Remix Studio — Post Queue (the daily-driver view).
 *
 * Upload clips once (Clip Library), define video styles (Recipes),
 * then this page is the loop: generate → download → post → mark posted.
 */
export default function VideoStudioPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Clapperboard className="h-7 w-7" /> Video Remix Studio
          </h1>
          <p className="text-muted-foreground mt-1">
            Unique TikTok/IG videos mixed from your clip library — weighted by best sellers and
            what&apos;s on the marketing calendar.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" render={<Link href="/marketing/videos/clips" />}>
            <Film className="h-4 w-4 mr-1" /> Clip Library
          </Button>
          <Button variant="outline" render={<Link href="/marketing/videos/recipes" />}>
            <LayoutList className="h-4 w-4 mr-1" /> Video Styles
          </Button>
        </div>
      </div>
      <PostQueue />
    </div>
  );
}
