/**
 * Campaign workflow — the 10-stage pipeline + the gates that guard
 * forward movement. Centralized so the advance endpoint, the editor
 * stepper, and any automation share one definition of "can this move?"
 */

export const STATUS_ORDER = [
  "idea",
  "themed",
  "copy_pending",
  "copy_review",
  "image_pending",
  "image_review",
  "preview_ready",
  "exported",
  "sent",
  "analyzed",
] as const;

export type Status = (typeof STATUS_ORDER)[number];

export const STATUS_LABELS: Record<Status, string> = {
  idea: "Idea",
  themed: "Themed",
  copy_pending: "Copy pending",
  copy_review: "Copy review",
  image_pending: "Image pending",
  image_review: "Image review",
  preview_ready: "Preview ready",
  exported: "Exported",
  sent: "Sent",
  analyzed: "Analyzed",
};

export function statusIndex(s: string): number {
  const i = (STATUS_ORDER as readonly string[]).indexOf(s);
  return i < 0 ? 0 : i;
}

/** Campaign fields the gates inspect. */
export interface GateCampaign {
  status: string;
  subject?: string | null;
  heroHeadline?: string | null;
  sectionABody?: string | null;
  sectionBBody?: string | null;
  heroImagePrompt?: string | null;
  secondaryImagePrompt?: string | null;
  heroImagePath?: string | null;
  secondaryImagePath?: string | null;
  secondaryImagePath2?: string | null;
  secondaryImageVariant?: string | null;
}

const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/**
 * Return the unmet requirements to ENTER `target`. Empty array = the
 * transition is allowed. Only forward gates are enforced; moving
 * backward is always allowed (to fix mistakes).
 */
export function gateFor(target: Status, c: GateCampaign): string[] {
  const blocked: string[] = [];
  const copyDone =
    has(c.subject) && has(c.heroHeadline) && has(c.sectionABody) && has(c.sectionBBody);
  const promptsDone = has(c.heroImagePrompt) && has(c.secondaryImagePrompt);
  const needs2 = c.secondaryImageVariant === "grid_2up";
  const imagesDone =
    has(c.heroImagePath) &&
    has(c.secondaryImagePath) &&
    (!needs2 || has(c.secondaryImagePath2));

  switch (target) {
    case "copy_review":
      if (!copyDone) blocked.push("Copy incomplete (need subject + hero headline + both section bodies).");
      break;
    case "image_pending":
      if (!copyDone) blocked.push("Write the copy before sending to the designer.");
      if (!promptsDone) blocked.push("Generate image prompts so the designer has a brief.");
      break;
    case "image_review":
      if (!imagesDone) blocked.push("All required images must be uploaded.");
      break;
    case "preview_ready":
      if (!copyDone) blocked.push("Copy incomplete.");
      if (!imagesDone) blocked.push("Images incomplete.");
      break;
    case "exported":
      if (!copyDone || !imagesDone) blocked.push("Campaign must be preview-ready before export.");
      break;
    case "sent":
      // Enforced by ordering only — you mark it sent after exporting.
      break;
    case "analyzed":
      break;
    default:
      break;
  }
  return blocked;
}

export function nextStatus(current: string): Status | null {
  const i = statusIndex(current);
  return i < STATUS_ORDER.length - 1 ? STATUS_ORDER[i + 1] : null;
}

export function prevStatus(current: string): Status | null {
  const i = statusIndex(current);
  return i > 0 ? STATUS_ORDER[i - 1] : null;
}
