import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Film } from "lucide-react";
import { ClipLibrary } from "@/modules/marketing/components/videos/clip-library";

/** Video Remix Studio — Clip Library (upload + tag the raw material). */
export default function ClipLibraryPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Film className="h-7 w-7" /> Clip Library
          </h1>
          <p className="text-muted-foreground mt-1">
            Every 5-10s clip you shoot, tagged with category, products and whether its audio is
            worth keeping. Tagged clips feed the composer.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/marketing/videos" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Post Queue
        </Button>
      </div>
      <ClipLibrary />
    </div>
  );
}
