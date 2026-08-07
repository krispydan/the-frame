/**
 * Screenshot the company page at phone and desktop widths.
 *
 * The redesign is being judged on a 390px iPhone viewport, so QA has to
 * actually render one — reading the JSX is how the page got to 5,172px tall
 * in the first place. Also reports full page height, any horizontal overflow,
 * and any element whose text visually collides with a sibling, because those
 * were the specific defects reported.
 *
 * Usage: node scripts/qa/shoot-company-page.mjs <label> [path]
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = process.env.QA_BASE ?? "http://localhost:3100";
const label = process.argv[2] ?? "shot";
const path = process.argv[3] ?? "/prospects/qa-village-pharmacy";
const OUT = "/tmp/claude-0/-home-user-the-frame/8444153e-843a-5b4f-801f-b9e7e3778032/scratchpad/qa";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "iphone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];

// The sandbox pins its own Chromium build; the version Playwright expects by
// default is not installed and must never be downloaded here.
const browser = await chromium.launch({
  executablePath: process.env.QA_CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

// Log in once and reuse the cookie.
const api = await browser.newContext({ baseURL: BASE });
const res = await api.request.post("/api/auth/manual-login", {
  data: { email: "qa@theframe.local", password: "qa-password" },
});
if (!res.ok()) {
  console.error("login failed:", res.status(), (await res.text()).slice(0, 200));
  process.exit(1);
}
const cookies = (await api.storageState()).cookies.map((c) => ({ ...c, secure: false }));

const report = [];
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    colorScheme: process.env.QA_THEME === "dark" ? "dark" : "light",
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 60_000 });
  if (process.env.QA_THEME === "dark") {
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
  }
  await page.waitForTimeout(1500);

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    // Anything sticking out past the viewport is a horizontal-scroll bug.
    const overflowing = [...document.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 12)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const txt = (el.textContent || "").trim().slice(0, 24);
        const label = el.getAttribute("aria-label") || "";
        const parent = el.parentElement ? el.parentElement.tagName.toLowerCase() + "." + String(el.parentElement.className).slice(0, 60) : "";
        return `${el.tagName.toLowerCase()} "${txt || label}" [${String(el.className).slice(0, 70)}] left=${Math.round(r.left)} right=${Math.round(r.right)} parent=${parent}`;
      });

    // Leaf text nodes whose boxes overlap — this is what made the email and
    // phone read as one string.
    // Only elements a user can actually see. Rows scrolled out of an
    // overflow container still have boxes that overlap whatever follows —
    // real geometry, but not a visible collision. Hit-testing the centre
    // point filters those out.
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
        el.scrollIntoView({ block: "center" });
      }
      const rr = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    };
    const leaves = [...document.querySelectorAll("span, p, a, div")]
      .filter((el) => el.children.length === 0 && el.textContent.trim().length > 2)
      .filter(visible);
    const collisions = [];
    for (let i = 0; i < leaves.length && collisions.length < 12; i++) {
      const a = leaves[i].getBoundingClientRect();
      if (a.width === 0) continue;
      for (let j = i + 1; j < leaves.length; j++) {
        const b = leaves[j].getBoundingClientRect();
        if (b.width === 0) continue;
        const overlap = a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2;
        if (overlap) {
          collisions.push(`"${leaves[i].textContent.trim().slice(0, 28)}" ∩ "${leaves[j].textContent.trim().slice(0, 28)}"`);
          break;
        }
      }
    }
    return {
      height: doc.scrollHeight,
      scrollWidth: doc.scrollWidth,
      cards: document.querySelectorAll('[class*="rounded-xl"],[class*="rounded-lg"]').length,
      overflowing,
      collisions,
    };
  });

  await page.screenshot({ path: `${OUT}/${label}-${vp.name}.png`, fullPage: true });
  report.push({ viewport: vp.name, ...metrics, jsErrors: [...new Set(errors)].slice(0, 5) });
  await ctx.close();
}

await browser.close();
for (const r of report) {
  console.log(`\n── ${r.viewport} ─────────────────────────────`);
  console.log(`page height      : ${r.height}px`);
  console.log(`horizontal scroll: ${r.scrollWidth > (r.viewport === "iphone" ? 390 : 1440) ? `YES (${r.scrollWidth}px)` : "no"}`);
  console.log(`overflowing els  : ${r.overflowing.length ? "\n   " + r.overflowing.join("\n   ") : "none"}`);
  console.log(`text collisions  : ${r.collisions.length ? "\n   " + r.collisions.join("\n   ") : "none"}`);
  console.log(`js errors        : ${r.jsErrors.length ? "\n   " + r.jsErrors.join("\n   ") : "none"}`);
}
console.log(`\nscreenshots → ${OUT}/${label}-{iphone,desktop}.png`);
