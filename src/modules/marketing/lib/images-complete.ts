/**
 * Single definition of "this campaign's images are complete" — used by BOTH
 * the upload-image route (in-transaction auto-advance) and the campaign PATCH
 * route. Two divergent inline copies previously disagreed: the upload route
 * ignored hero_disabled/secondary_disabled, so a campaign with a disabled
 * hero could never auto-advance via API uploads.
 *
 * Rules:
 *  - a DISABLED section never blocks readiness
 *  - hero needs heroImagePath
 *  - secondary needs secondaryImagePath (+ secondaryImagePath2 for grid_2up)
 */
export function imagesComplete(row: {
  heroDisabled?: boolean | number | null;
  heroImagePath?: string | null;
  secondaryDisabled?: boolean | number | null;
  secondaryImagePath?: string | null;
  secondaryImagePath2?: string | null;
  secondaryImageVariant?: string | null;
}): boolean {
  const heroReady = !!row.heroDisabled || !!row.heroImagePath;
  const secondaryReady =
    !!row.secondaryDisabled ||
    (row.secondaryImageVariant === "grid_2up"
      ? !!row.secondaryImagePath && !!row.secondaryImagePath2
      : !!row.secondaryImagePath);
  return heroReady && secondaryReady;
}
