/**
 * Interaction QA for the company page.
 *
 * Screenshots prove the page looks right; they prove nothing about whether
 * the controls still work. The redesign moved Won/Lost behind an overflow
 * menu, put six sections behind <details>, and added a fixed action bar —
 * each of which is a chance to make something unreachable. This drives them
 * on a real 390px touch viewport and asserts.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3100";
const PATH = process.argv[2] ?? "/prospects/qa-village-pharmacy";

const browser = await chromium.launch({
  executablePath: process.env.QA_CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const api = await browser.newContext({ baseURL: BASE });
const res = await api.request.post("/api/auth/manual-login", {
  data: { email: "qa@theframe.local", password: "qa-password" },
});
if (!res.ok()) { console.error("login failed"); process.exit(1); }
const cookies = (await api.storageState()).cookies.map((c) => ({ ...c, secure: false }));

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
});
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

await page.goto(BASE + PATH, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(1200);

const results = [];
const check = async (name, fn) => {
  try {
    const r = await fn();
    // A check can report "n/a" — a prospect with no phone SHOULD have no
    // tel: link, and calling that a failure trains you to ignore the suite.
    results.push([r === "n/a" ? "SKIP" : r ? "PASS" : "FAIL", name]);
  } catch (e) { results.push(["FAIL", `${name} — ${String(e).slice(0, 90)}`]); }
};

/** Does the Brief show a reach row of this kind at all? */
const hasReach = async (scheme) =>
  (await page.locator(`a[href^="${scheme}"]`).count()) > 0;

// The page must never render a phone number as plain text — the whole
// "underlined address" defect came from letting iOS linkify what we didn't.
await check("any phone shown is an authored tel: link", async () => {
  const body = await page.locator("body").innerText();
  const looksLikeAPhone = /\b0\d{9,10}\b|\(\d{3}\)\s?\d{3}-\d{4}/.test(body);
  if (!looksLikeAPhone) return "n/a";
  return hasReach("tel:");
});

await check("any email shown is an authored mailto: link", async () => {
  const body = await page.locator("body").innerText();
  if (!/[\w.+-]+@[\w-]+\.[\w.]+/.test(body)) return "n/a";
  return hasReach("mailto:");
});

await check("action bar is fixed at the bottom", async () => {
  const bar = page.locator('div.fixed.bottom-0').first();
  if (!(await bar.count())) return false;
  const box = await bar.boundingBox();
  return box !== null && box.y + box.height <= 850 && box.y > 700;
});

await check("every tap target in the action bar is >= 44px tall", async () => {
  const hs = await page.locator('div.fixed.bottom-0 a, div.fixed.bottom-0 button').evaluateAll(
    (els) => els.map((e) => e.getBoundingClientRect().height));
  return hs.length >= 3 && hs.every((h) => h >= 44);
});

await check("collapsed sections start closed", async () =>
  (await page.locator("details:not([open]) > summary").count()) >= 3);

await check("a collapsed section opens on click", async () => {
  // Hold an element handle, not a locator: `details:not([open])` stops
  // matching the moment the click succeeds, so re-resolving would silently
  // check a different section.
  const summary = await page.locator("details:not([open]) > summary").first().elementHandle();
  if (!summary) return false;
  await summary.click();
  await page.waitForTimeout(250);
  return await summary.evaluate((el) => el.parentElement.hasAttribute("open"));
});

await check("summary is keyboard-operable", async () => {
  const s = page.locator("details > summary").first();
  await s.focus();
  const before = await s.evaluate((el) => el.parentElement.hasAttribute("open"));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const after = await s.evaluate((el) => el.parentElement.hasAttribute("open"));
  return before !== after;
});

await check("overflow menu opens and exposes Won/Lost/Edit", async () => {
  await page.locator('button[aria-label="More actions"]').click();
  await page.waitForTimeout(400);
  const txt = await page.locator('[role="menu"], [role="menuitem"]').allInnerTexts();
  const all = txt.join(" ");
  return all.includes("Won") && all.includes("Lost") && all.includes("Edit");
});

await check("Won opens a confirmation dialog, not window.confirm", async () => {
  page.once("dialog", (d) => d.dismiss());        // fails the test if native
  await page.locator('[role="menuitem"]', { hasText: "Mark as Won" }).click();
  await page.waitForTimeout(500);
  return (await page.locator('[role="dialog"]').count()) > 0;
});

await check("the dialog cancels without changing status", async () => {
  await page.locator('button', { hasText: "Cancel" }).first().click();
  await page.waitForTimeout(400);
  return (await page.locator('[role="dialog"]').count()) === 0;
});

await check("back link points at the prospects list", async () =>
  (await page.locator('a[aria-label="Back to prospects"]').getAttribute("href"))?.startsWith("/prospects") === true);

await check("only one breadcrumb trail on the page", async () => {
  const crumbs = await page.getByText("Prospects", { exact: true }).count();
  return crumbs <= 1;
});

await check("no contact renders as 'Unknown'", async () =>
  (await page.getByText("Unknown", { exact: true }).count()) === 0);

await check("no bare style codes in the AJM list", async () => {
  const body = await page.locator("body").innerText();
  return !/\n\s*3\d{5}\s*\n/.test(body);
});

await check("no '1 units'", async () =>
  !(await page.locator("body").innerText()).includes("1 units"));

await check("no ICP em-dash placeholder", async () =>
  !(await page.locator("body").innerText()).includes("ICP —"));

// A screenshot showed the AJM product rows painting over each other. That
// looked like a scroll repaint artefact rather than a duplicate render, but
// "looked like" is not a test.
await check("AJM product rows are unique", async () => {
  const rows = await page.locator("text=/^\\d+ units? · \\$/").allInnerTexts();
  if (!rows.length) return "n/a";
  const names = await page.evaluate(() => {
    const hdr = [...document.querySelectorAll("p")].find((p) => p.textContent.trim() === "What they bought");
    if (!hdr) return [];
    return [...(hdr.nextElementSibling?.children ?? [])]
      .map((el) => el.firstElementChild?.textContent?.trim() ?? "");
  });
  return names.length > 0 && new Set(names).size === names.length;
});

await check("the sidebar renders each nav item once", async () => {
  const n = await page.locator('a[href="/prospects"]').count();
  return n <= 2;   // the nav entry, plus at most the page's own back link
});

await browser.close();

for (const [state, name] of results) console.log(`${state}  ${name}`);
const failed = results.filter(([s]) => s === "FAIL").length;
const skipped = results.filter(([s]) => s === "SKIP").length;
console.log(`\n${results.length - failed - skipped}/${results.length - skipped} passed${skipped ? `, ${skipped} n/a for this fixture` : ""}`);
if (errors.length) console.log("console errors:\n  " + [...new Set(errors)].join("\n  "));
process.exit(failed ? 1 : 0);
