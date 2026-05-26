/**
 * One-shot UPC backfill from the master CSV
 * ("MASTER UPC CODES - Order[608096]"). Run on Railway:
 *
 *   railway ssh --service the-frame "cd /app && node scripts/import-master-upcs.cjs --dry-run"
 *   railway ssh --service the-frame "cd /app && node scripts/import-master-upcs.cjs"
 *
 * Idempotent: only writes when the local UPC differs from the
 * master. Reports matched / would_update / unchanged / unmatched /
 * not_in_master per SKU.
 *
 * Source: 115 SKU → UPC pairs from the master sheet, inlined below so
 * the script needs nothing on disk to run.
 */
const Database = require("better-sqlite3");
const path = require("path");

// SKU → 12-digit UPC-A. Master sheet is authoritative.
const MAPPINGS = [
  ["JX4001-OLV", "605547971990"],
  ["JX4001-TOR", "605547677502"],
  ["JX4001-BLK", "605547558443"],
  ["JX4002-BLK", "605547986314"],
  ["JX4002-TOR", "605547603051"],
  ["JX4003-BLU", "605547717116"],
  ["JX4003-BRW", "605547796722"],
  ["JX4004-BLK", "605547902369"],
  ["JX4004-GRY", "605547579301"],
  ["JX4004-BRW", "605547640544"],
  ["JX4005-BLU", "605547647024"],
  ["JX4005-OLV", "605547779398"],
  ["JX4005-BLK", "605547571091"],
  ["JX4005-ATO", "605547984815"],
  ["JX4006-GRN", "605547957277"],
  ["JX4006-BUR", "605547834493"],
  ["JX4006-RST", "605547650925"],
  ["JX4006-BLK", "605547669972"],
  ["JX4007-BLK", "605547842269"],
  ["JX4007-RED", "605547686849"],
  ["JX4007-TOR", "605547777806"],
  ["JX4008-BRW", "605547967290"],
  ["JX4008-GRN", "605547857478"],
  ["JX4008-TOR", "605547699078"],
  ["JX4009-GRN", "605547920141"],
  ["JX4009-TOR", "605547588051"],
  ["JX4009-BLK", "605547785108"],
  ["JX4010-GRY", "605547687402"],
  ["JX4010-GRN", "605547887871"],
  ["JX4010-BRW", "605547853609"],
  ["JX4011-BLK", "605547832659"],
  ["JX4011-TOR", "605547818196"],
  ["JX3001-BLK", "605547753367"],
  ["JX3001-SND", "605547620485"],
  ["JX3001-TOR", "605547876394"],
  ["JX3002-BLK", "605547514272"],
  ["JX3002-TOR", "605547507830"],
  ["JX3002-AMB", "605547552069"],
  ["JX3003-BLK", "605547789151"],
  ["JX3003-BRW", "605547989506"],
  ["JX3003-TOR", "605547511370"],
  ["JX3004-BLK", "605547635144"],
  ["JX3004-SND", "605547983863"],
  ["JX3004-TOR", "605547952470"],
  ["JX3004-TGN", "605547838910"],
  ["JX3005-BLK", "605547793172"],
  ["JX3005-BRW", "605547815454"],
  ["JX3006-BLK", "605547663185"],
  ["JX3006-GLD", "605547872556"],
  ["JX3006-SLV", "605547816239"],
  ["JX3007-BLK", "605547532856"],
  ["JX3007-OLV", "605547604065"],
  ["JX3007-TOR", "605547534331"],
  ["JX3008-ATO", "605547929885"],
  ["JX3008-GRN", "605547939013"],
  ["JX3008-BUR", "605547557590"],
  ["JX2001-BLK", "605547937118"],
  ["JX2001-OLV", "605547801976"],
  ["JX2001-SND", "605547504761"],
  ["JX2001-TOR", "605547989919"],
  ["JX2002-AMB", "605547904707"],
  ["JX2002-GRN", "605547893483"],
  ["JX2003-BLK", "605547799471"],
  ["JX2003-BRW", "605547853265"],
  ["JX2003-GRY", "605547621642"],
  ["JX2004-BLK", "605547667886"],
  ["JX2004-GRY", "605547740138"],
  ["JX2004-RST", "605547917196"],
  ["JX2005-BRW", "605547653308"],
  ["JX2005-PNK", "605547639838"],
  ["JX2005-TEA", "605547643088"],
  ["JX2006-BLK", "605547505263"],
  ["JX2006-BRW", "605547946462"],
  ["JX2006-YLW", "605547764172"],
  ["JX2007-BLK", "605547996658"],
  ["JX2007-BRW", "605547646645"],
  ["JX2007-TOR", "605547565915"],
  ["JX2008-BLK", "605547874079"],
  ["JX2008-RED", "605547954962"],
  ["JX2008-TOR", "605547848056"],
  ["JX1001-BLK", "605547877438"],
  ["JX1001-TOR", "605547608063"],
  ["JX1001-WHT", "605547760587"],
  ["JX1002-BLK", "605547566172"],
  ["JX1002-TOR", "605547811425"],
  ["JX1003-BLU", "605547593604"],
  ["JX1003-SND", "605547643286"],
  ["JX1003-TOR", "605547538629"],
  ["JX1004-BLK", "605547541445"],
  ["JX1004-BRW", "605547951398"],
  ["JX1004-TOR", "605547666988"],
  ["JX1005-BLK", "605547684586"],
  ["JX1005-OLV", "605547519154"],
  ["JX1005-TOR", "605547821127"],
  ["JX1006-BRW", "605547870392"],
  ["JX1006-PUR", "605547513565"],
  ["JX1006-TOR", "605547561924"],
  ["JX1007-BLK", "605547565052"],
  ["JX1007-GRN", "605547643187"],
  ["JX1007-FLW", "605547935923"],
  ["JX1008-BLK", "605547562693"],
  ["JX1008-BRW", "605547948091"],
  ["JX1008-OLV", "605547721878"],
  ["JX1009-BLK", "605547845826"],
  ["JX1009-GRN", "605547528514"],
  ["JX1009-TOR", "605547777684"],
  ["JX1010-BLK", "605547687341"],
  ["JX1010-GRY", "605547639814"],
  ["JX1010-TOR", "605547503733"],
  ["JX1011-TOR", "605547703539"],
  ["JX1011-BLK", "605547550744"],
  ["JX1011-AMB", "605547528828"],
  ["JX1012-BLK", "605547750687"],
  ["JX1012-GRY", "605547949470"],
  ["JX1012-TOR", "605547793479"],
];

const dryRun = process.argv.includes("--dry-run");

const dbPath = process.env.DATABASE_PATH || "/data/the-frame.db";
const db = new Database(dbPath);

console.log(`Master mappings: ${MAPPINGS.length}`);
console.log(`DB path: ${dbPath}`);
console.log(`Dry run: ${dryRun}`);
console.log();

const update = db.prepare(
  "UPDATE catalog_skus SET upc = ?, updated_at = datetime('now') WHERE sku = ?"
);
const lookup = db.prepare("SELECT id, sku, upc FROM catalog_skus WHERE sku = ?");

let unchanged = 0;
let wouldUpdate = 0;
let updated = 0;
let unmatched = 0;
const pendingUpdates = [];
const samples = [];

for (const [sku, masterUpc] of MAPPINGS) {
  const row = lookup.get(sku);
  if (!row) {
    unmatched++;
    samples.push({ sku, action: "no_local_sku", masterUpc });
    continue;
  }
  if ((row.upc ?? "") === masterUpc) {
    unchanged++;
    continue;
  }
  wouldUpdate++;
  pendingUpdates.push({ sku, masterUpc, current: row.upc });
  if (samples.length < 30) {
    samples.push({
      sku,
      action: dryRun ? "would_update" : "updated",
      from: row.upc || "(empty)",
      to: masterUpc,
    });
  }
}

if (!dryRun && pendingUpdates.length > 0) {
  const tx = db.transaction((items) => {
    for (const it of items) update.run(it.masterUpc, it.sku);
  });
  tx(pendingUpdates);
  updated = pendingUpdates.length;
}

console.log("Summary:");
console.log(`  Master rows           : ${MAPPINGS.length}`);
console.log(`  unchanged             : ${unchanged}`);
console.log(`  ${dryRun ? "would_update" : "updated      "}: ${dryRun ? wouldUpdate : updated}`);
console.log(`  no local SKU match    : ${unmatched}`);

if (samples.length > 0) {
  console.log();
  console.log("Sample (first 30 changes):");
  for (const s of samples) {
    if (s.action === "no_local_sku") {
      console.log(`  ${s.sku.padEnd(16)} no local SKU (master only)`);
    } else {
      console.log(`  ${s.sku.padEnd(16)} ${s.from.padEnd(14)} -> ${s.to}`);
    }
  }
}

// Verify the SKUs that the validator was specifically blocking on.
console.log();
console.log("Validator-blocked SKUs after this run:");
const blocked = ["JX4008-GRN","JX4008-TOR","JX4007-TOR","JX4004-BRW","JX4010-BRW","JX4006-BLK","JX4009-BLK","JX4009-TOR","JX4005-ATO"];
for (const s of blocked) {
  const r = lookup.get(s);
  console.log(`  ${s.padEnd(14)} upc=${r?.upc || "(empty)"}`);
}
