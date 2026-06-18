/**
 * PhoneBurner API probe — runs locally, hits PB's live API, tries
 * the minimum payload for folder + contact creation. Used to nail down
 * the exact required fields without touching the prod DB.
 *
 *   PHONEBURNER_API_KEY=... npx tsx scripts/pb-probe.ts
 *
 * Each step prints (request body) → (response body), so we can see
 * what PB accepts/rejects without running the full sync engine.
 */
const KEY = process.env.PHONEBURNER_API_KEY ?? "";
if (!KEY) {
  console.error("PHONEBURNER_API_KEY env var required");
  process.exit(1);
}
const BASE = "https://www.phoneburner.com/rest/1";
const HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function probe(label: string, method: string, path: string, body?: unknown) {
  console.log("\n────────────────────────────────────────────");
  console.log(`[${label}] ${method} ${path}`);
  if (body) console.log("  body:", JSON.stringify(body));
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON
  }
  console.log(`  → ${res.status}`);
  console.log(pretty.slice(0, 1500));
  return { status: res.status, text };
}

async function probeForm(label: string, path: string, fields: Record<string, string>) {
  console.log("\n────────────────────────────────────────────");
  console.log(`[${label}] POST ${path}  (form-encoded)`);
  console.log("  fields:", fields);
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await res.text();
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /**/
  }
  console.log(`  → ${res.status}`);
  console.log(pretty.slice(0, 1500));
  return { status: res.status, text };
}

(async () => {
  // 0) Discover owner_id by inspecting an existing contact
  console.log("=== 0. Discover owner_id from existing contact ===");
  const ownerRes = await fetch(`${BASE}/contacts?page_size=1`, { headers: HEADERS });
  const ownerJson = JSON.parse(await ownerRes.text());
  console.log("Raw shape (first 800 chars):");
  console.log(JSON.stringify(ownerJson, null, 2).slice(0, 800));

  // Walk the response to find owner_id
  function findOwnerId(obj: unknown, depth = 0): string | null {
    if (depth > 8 || !obj) return null;
    if (typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.owner_id === "string" && o.owner_id) return o.owner_id;
    if (typeof o.owner_id === "number") return String(o.owner_id);
    for (const v of Object.values(o)) {
      const found = findOwnerId(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const ownerId = findOwnerId(ownerJson);
  console.log(`\n[owner_id resolved] ${ownerId ?? "(not found)"}\n`);
  if (!ownerId) {
    console.error("Cannot proceed without owner_id");
    process.exit(1);
  }

  // 1) Folder probe attempts
  await probe("folder-A: JSON {folder_name} only", "POST", "/folders", {
    folder_name: `Probe Folder A ${Date.now()}`,
  });
  await probe("folder-B: JSON {name}", "POST", "/folders", {
    name: `Probe Folder B ${Date.now()}`,
  });
  await probe("folder-C: JSON {folder_name, owner_id}", "POST", "/folders", {
    folder_name: `Probe Folder C ${Date.now()}`,
    owner_id: ownerId,
  });
  await probeForm("folder-D: form-encoded folder_name only", "/folders", {
    folder_name: `Probe Folder D ${Date.now()}`,
  });
  await probeForm("folder-E: form-encoded folder_name + owner_id", "/folders", {
    folder_name: `Probe Folder E ${Date.now()}`,
    owner_id: ownerId,
  });

  // 2) Contact probe attempts
  const baseContact = {
    owner_id: ownerId,
    first_name: "Frame",
    last_name: `Probe ${Date.now()}`,
    email: `frame-probe-${Date.now()}@example.com`,
    phone: "5559876543",
    phone_type: 2,
    address1: "123 Probe St",
    city: "Test City",
    state: "CA",
    zip: "94110",
    country: "US",
    notes: "Frame probe",
  };
  await probe("contact-A: JSON minimal w/ owner_id", "POST", "/contacts", baseContact);
  await probe("contact-B: w/ custom_fields", "POST", "/contacts", {
    ...baseContact,
    last_name: `Probe-B ${Date.now()}`,
    custom_fields: [
      { name: "company_name", value: "Frame Test Co" },
      { name: "website", value: "https://test.example" },
    ],
  });
  await probeForm("contact-C: form-encoded minimal", "/contacts", {
    owner_id: ownerId,
    first_name: "Frame",
    last_name: `Form-C ${Date.now()}`,
    email: `form-probe-${Date.now()}@example.com`,
    phone: "5559876543",
    phone_type: "2",
  });

  console.log("\n────────────────────────────────────────────");
  console.log("Probe complete.");
})().catch((e) => {
  console.error("Probe error:", e);
  process.exit(1);
});
