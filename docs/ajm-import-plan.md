# AJM Reactivation — import plan (frame + Pipedrive)

**Status:** Ready to execute (pending the curated source file) · **Owner:** Daniel · **Last updated:** 2026-06-27

How we import the AJ Morgan wholesale customer list into the frame and create
deals in the **AJM Reactivation** Pipedrive pipeline, **all assigned to
Christina**. This is Phase 0 + the AJM slice of Phase 3 of
[`crm-master-plan.md`](./crm-master-plan.md).

---

## 1. Scope — import all to the frame, push only the curated 1,173 to Pipedrive

Decision (2026-06-27): the frame is the system of record, so it imports the
**full AJM cohort** (the master export, ~13,620 after skips). Pipedrive stays
curated — only the **~1,173-row `Sheet4`** subset Daniel earmarked is pushed.

- **Full master** (`…Email_and_No_Email…`, 13,821 rows; union of an email list +
  a 9,314-row "No-email list") → imported to the frame.
- **Curated `Sheet4`** (~1,173) → the same rows, re-prepped with
  `--push-tag ajm_pipedrive_push`, so those companies carry a tag the Pipedrive
  push selects on. Because the importer dedupes and **merges tags**, this second
  pass just adds the tag to companies already imported by the master pass — no
  duplicates.
- **Pipedrive selection** = `companies` whose `tags` contain `ajm_pipedrive_push`.
- **Action needed:** re-upload `Sheet4` as a CSV file (last upload was 0 bytes).
  Column structure assumed identical to the master (59 cols); validated on receipt.

---

## 2. Status derivation — the "Don't send postcard to reason" column

Per Daniel, the **`Dont send postcard to reason`** column drives each row's
treatment. Mapping (confirmed 2026-06-27):

| Reason value (contains) | Treatment | Frame status | Pipedrive |
|---|---|---|---|
| `Ordered from Jaxy (2026)`, `already ordered`, `already purchased`, `already bought on Faire`, `Ordered Jaxy`, `this location already purchased` | **Already a Jaxy customer** | `customer` | **Won** deal (AJM pipeline) — they've converted |
| `Ordered Pre 2023`, `Pre 2020`, `No last order date`, *(blank)* | **Dormant former AJM buyer → reactivation target** | `qualified_lead` (or `customer` if matched sub-cohort) | Open deal at **Interested? No →** entered at the pipeline's first stage for working |
| `store closed`, `out of business`, `business closed`, `duplicate`, `duplicate + already bought` | **Skip** | — | not imported |
| `Non US` | **Skip / hold** (US B2B wholesale scope) | — | not imported |
| `email is invalid: …` | **Import, call-only** (no email outreach) | as dormant | open deal; suppress email |
| `Mostly reading glasses`, `sent reader samples…`, `editorial` | Import as dormant; note the category caveat | as dormant | open deal |

Notes:
- "Already a Jaxy customer" rows are the ~123 in the master; in the curated 1,173
  the exact count is validated on import.
- The AJM importer already sets `customer` vs `qualified_lead` from the prep
  script's match logic (`ajm-import.ts`); this reason-mapping **augments** that —
  e.g. an "already ordered" row is forced to `customer` even if unmatched.

### Pipeline-stage entry for reactivation deals

AJM reactivation deals are **created directly in the AJM Reactivation pipeline**
(not gated behind the usual "interest" event, because importing them *is* the
deliberate decision to work them). Recommended stage layout for this pipeline so
the dormant cohort has a working column before "Interested":

`To Contact → Interested → Catalog Sent → Following Up → Won / Lost`

- Dormant reactivation rows → **To Contact** (Christina's call/email queue).
- Already-customer rows → **Won** (with their historical order context).

> This adds a `To Contact` stage to the AJM pipeline only (the cold work for this
> cohort is the explicit reactivation campaign). The Catalog-Interested pipeline
> still starts at Interested. Confirm in master-plan §13 if you'd rather keep AJM
> identical to Catalog-Interested and instead work the dormant rows from the frame
> until they show interest.

---

## 3. Field mapping (CSV → frame → Pipedrive)

| CSV column(s) | Frame target | Pipedrive |
|---|---|---|
| `CUS_NM` | `companies.name` | Organization name |
| `Website` | `companies.website` / `domain` | Org |
| `ADDRESS`,`ADDRESS2`,`CITY`,`STATE`,`ZIP`,`COUNTRY` | `companies` address fields | Org address |
| `ATTN` / `ATTN_2`, `TITLE` | `contacts` (name, title) | Person |
| `email_1` (then `email_2`) | `contacts.email` (canonical) | Person email |
| `PHONE`,`PHONE_2`,`FAX` | `company_phones` / `contacts.phone` | Person/Org phone |
| `Total_Orders` | `companies.ajm_total_orders` | custom field |
| `Total_Spend` | `companies.ajm_total_spend` | custom field |
| `First_Order` / `FIRST_DT` | `companies.ajm_first_order` | — |
| `Last_Order` / `LT_SLS_DT` | `companies.ajm_last_order` | — |
| `AJM_Category` | `companies.ajm_category` | `lead_bucket` context |
| `STATUS` (Active/Inactive/…) | `companies.ajm_status` | — |
| `Dont send postcard to reason` | drives status (§2); stored in `notes`/tag | — |
| `CUS_ID` | `companies.source_id` (provenance) | custom field |
| — | `source = 'ajm_2025_import'`, `source_type = 'ajm_legacy'` | `lead_bucket = 'ajm'` |

All created Pipedrive deals: **pipeline = AJM Reactivation**, **owner =
Christina**, custom field `frame_company_id` set for dedup.

---

## 4. Dedup & data hygiene

- **Within the file:** `duplicate`-flagged rows skipped; remaining dupes collapsed
  by the importer's cascade (email → domain → name+state → phone — `ajm-import.ts`).
- **Against existing frame companies:** merge (fill nulls, never clobber operator
  edits), append AJM tags, set `customer` only when the row warrants it. The
  importer is **idempotent** — re-running is a no-op.
- **Against existing Pipedrive:** resolve by `frame_company_id` → domain/email →
  phone before creating an Org/Person/Deal; never create a duplicate.
- **Email validation:** `email is invalid: …` rows import **without** an email
  (call-only); other emails verified via MillionVerifier before any send.

---

## 5. Execution flow (upload via API)

**Tooling is built:** `scripts/prep-ajm-import.py` (new) turns the AJM CSV export
into the `ajm_import.jsonl` the importer expects, applying the §2 reason→status
mapping and §4 skip rules, and prints a dry-run summary. The import endpoint
(`POST /api/admin/sales/import-ajm`, `key=jaxy2026`, accepts a JSONL file) already
existed; the prep script was the missing half.

Steps:

1. **Pass 1 — import the full cohort to the frame:**
   ```
   python3 scripts/prep-ajm-import.py master.csv ajm_all.jsonl
   curl -F key=jaxy2026 -F dryRun=true -F file=@ajm_all.jsonl <host>/api/admin/sales/import-ajm
   curl -F key=jaxy2026             -F file=@ajm_all.jsonl <host>/api/admin/sales/import-ajm
   ```
   (We have the master on disk already.) Idempotent. Acceptance per master-plan
   §9.4 (field-mapping + dedup validation + 20-row hand audit).
2. **Get `Sheet4` as a CSV file** on disk (the earlier upload arrived empty;
   re-export and re-upload).
3. **Pass 2 — tag the curated subset for Pipedrive:**
   ```
   python3 scripts/prep-ajm-import.py Sheet4.csv ajm_push.jsonl --push-tag ajm_pipedrive_push
   curl -F key=jaxy2026 -F file=@ajm_push.jsonl <host>/api/admin/sales/import-ajm
   ```
   Prints the ~1,173 split for sign-off; the re-import merges `ajm_pipedrive_push`
   onto those companies (no duplicates).
4. **Create Pipedrive deals (Phase 3)** for companies tagged
   `ajm_pipedrive_push` only — create the AJM Reactivation deal (**owner =
   Christina**); already-customer (`cohort = ajm_already_customer`) rows → **Won**,
   backdated to `ajm_last_order`; reactivation rows → open deal at the first stage.
   Dry-run preview first. The untagged remainder stays in the frame and only
   reaches Pipedrive later if it shows interest via Instantly/PhoneBurner.

> **Validation run (master file, 13,821 rows)** confirmed the script and mapping:
> 13,620 emit (123 already-customer → Won, 13,485 reactivation, 12 call-only),
> 201 skipped (closed/duplicate/Non-US) — this is the **frame** import (pass 1).
> The **Sheet4** pass (~1,173, pass 2) re-tags that subset for the **Pipedrive**
> push. Note ~64% of master rows are phone-only (no valid email) — call-first
> leads.

> Prereqs (from master-plan §13): Pipedrive API token + subdomain + **staging**
> company, the AJM pipeline + stage IDs, and **Christina's Pipedrive user/owner
> ID**. Run step 4 against staging first.

---

## 6. How this interacts with the order→deal rule

When an imported AJM company later places (or already has) a wholesale Shopify
order, the refined order→deal rule (master-plan §7) applies: **the order is
reported under the company's open AJM deal** (winning it), rather than creating a
separate Customers-pipeline deal. So a dormant AJM lead Christina reactivates and
closes shows as a single Won deal in the AJM pipeline — clean attribution of the
reactivation. Already-customer rows imported as Won already carry their order
context.

---

## 7. Open items for this import

- [ ] **Re-upload `Sheet4` as a CSV file** — the only blocker to running the
      import; the prep script + endpoint are ready. (Last upload was 0 bytes; the
      list was pasted as text, which can't be processed programmatically.)
- [x] Prep tooling built & validated — `scripts/prep-ajm-import.py` (§5)
- [x] Reason→status mapping confirmed (§2)
- [x] Non-US skipped only when the reason says so (Canadian Jaxy customers kept)
- [ ] Christina's Pipedrive owner ID + AJM pipeline/stage IDs (for Phase 3 push)
