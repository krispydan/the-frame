"use client";

/**
 * VideoPlayer — a nicer inline player than a bare <video controls>.
 *
 * Shows the poster with a big, custom play button overlaid (the native
 * play button is ugly and inconsistent across browsers). Clicking it
 * swaps in the real <video> element with native controls and autoplays,
 * so the first impression is a clean thumbnail and the scrub/volume bar
 * only appears once you're actually watching. Sizing is owned by the
 * caller via `className` (set the aspect box there); this fills it.
 */

import { useState } from "react";
import { Play, Film } from "lucide-react";
import { cn } from "@/lib/utils";

const CIRCLE: Record<string, string> = {
  sm: "h-9 w-9",
  md: "h-12 w-12",
  lg: "h-16 w-16",
};
const ICON: Record<string, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-7 w-7",
};

export function VideoPlayer({
  src,
  poster,
  className,
  size = "md",
  contain = false,
  muted = true,
  placeholder,
}: {
  src?: string | null;
  poster?: string | null;
  className?: string;
  /** Play-button size relative to the container. */
  size?: "sm" | "md" | "lg";
  /** object-contain (letterbox) instead of cover-crop. */
  contain?: boolean;
  muted?: boolean;
  /** Shown when there's no video source yet (rendering / failed). */
  placeholder?: React.ReactNode;
}) {
  const [active, setActive] = useState(false);
  const fit = contain ? "object-contain" : "object-cover";

  if (!src) {
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        {placeholder ?? <Film className="h-6 w-6 opacity-40" />}
      </div>
    );
  }

  return (
    <div className={cn("group relative overflow-hidden bg-black", className)}>
      {active ? (
        <video
          src={src}
          poster={poster ?? undefined}
          autoPlay
          controls
          muted={muted}
          playsInline
          className={cn("h-full w-full", fit)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setActive(true)}
          aria-label="Play video"
          className="absolute inset-0 h-full w-full cursor-pointer"
        >
          {poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={poster} alt="" className={cn("h-full w-full", fit)} />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-muted" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/30 via-transparent to-transparent transition-colors group-hover:from-black/40">
            <span
              className={cn(
                "flex items-center justify-center rounded-full bg-white/90 text-black shadow-lg ring-1 ring-black/5 backdrop-blur-sm transition duration-150 group-hover:scale-110 group-hover:bg-white",
                CIRCLE[size],
              )}
            >
              <Play className={cn("translate-x-[1px] fill-current", ICON[size])} />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
