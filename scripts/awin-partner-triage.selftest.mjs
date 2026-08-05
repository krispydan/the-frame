/**
 * Fixtures use the REAL pending-list schema confirmed against the live endpoint:
 *   { advertiserId, partnerId, company, website, primaryPromotionalType (numeric
 *     id), sectors: [id], promotionalTypes: [id], membershipStatus, ... }
 * Cases are drawn from actual applicants in the Foot Cardigan backlog.
 */
import { score, decide, normalize, DECLINE_REASONS } from "./awin-partner-triage.mjs";

const row = (partnerId, company, website, typeId) => ({
  advertiserId: 59135, partnerId, company, website,
  primaryPromotionalType: typeId, sectors: [], promotionalTypes: typeId ? [typeId] : [],
  membershipStatus: "PENDING",
});

const cases = [
  // real rejects from the live backlog
  { want: "reject", raw: row(1, "The Deal Wizard", "https://thedealwizard.com", 26) },
  { want: "reject", raw: row(2, "Gets Coupon", "https://www.getscoupon.com/", 26) },
  { want: "reject", raw: row(3, "FatCoupon Technology Ltd", "https://fatcoupon.com", 24) },
  { want: "reject", raw: row(4, "Coupon Monster", "https://coupon-monster.de/", 26) },
  // the Spanish coupon site an English-only token list let through
  { want: "reject", raw: row(5, "IMP Multimedia GmbH", "https://www.codigosdescuentospromocionales.es", 12) },
  // no website at all -> reject with noUrlGiven (publisher 1869468 from the backlog)
  { want: "reject", raw: row(1869468, "Kristy Walden", "", null) },
  // coupon type but clean name/domain -> human decision, not auto-reject
  { want: "review", raw: row(7, "Wildfire Systems, Inc.", "https://wildfire-corp.com", 24) },
  // traffic arbitrage -> review, never silent accept
  { want: "review", raw: row(8, "LINKORBITS LTD", "https://linkorbits.com/", 12) },
  // no type declared -> review
  { want: "review", raw: row(9, "Parallel", "https://joinparallel.io", null) },
  // genuine content publishers -> accept
  { want: "accept", raw: row(10, "Barcode lookup", "https://www.barcodelookup.com", 18) },
  { want: "accept", raw: row(11, "Zazzy Holdings", "https://digitalcatwalk.co.uk", 20) },
  { want: "accept", raw: row(12, "The Tread Magazine", "http://treademagazine.online", 20) },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const app = normalize(c.raw);
  const s = score(app);
  const d = decide(app, s);
  const ok = d.decision === c.want;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${app.companyName.slice(0, 30).padEnd(30)} ` +
      `${(app.promotionalType || "(none)").slice(0, 16).padEnd(16)} -> ${d.decision.padEnd(6)} ` +
      `${String(d.points).padStart(2)}pts  want ${c.want}`,
  );
  if (!ok) for (const r of s.reasons) console.log(`          ${r}`);
  if (d.decision === "reject" && !DECLINE_REASONS.has(d.declineReason)) {
    console.log(`          !! invalid declineReason "${d.declineReason}"`);
    fail++;
  }
}
// the no-website case must use Awin's noUrlGiven reason specifically
const bare = normalize(row(99, "X", "", null));
const noUrl = decide(bare, score(bare));
if (noUrl.declineReason !== "noUrlGiven") { console.log("FAIL  missing-website reason mapping"); fail++; }
else { console.log("PASS  missing-website maps to noUrlGiven"); pass++; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
