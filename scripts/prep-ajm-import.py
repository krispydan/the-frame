#!/usr/bin/env python3
"""
Prep the AJM wholesale customer spreadsheet into ajm_import.jsonl for the
frame's importer (POST /api/admin/sales/import-ajm, key=jaxy2026).

  python3 scripts/prep-ajm-import.py <input.csv> [output.jsonl]

If output.jsonl is omitted, prints the dry-run summary only (no file written).

Implements the segmentation agreed in docs/ajm-import-plan.md, driven by the
"Dont send postcard to reason" column:

  already-customer  (reason mentions Jaxy / already ordered / bought)  -> status=customer,      cohort=ajm_already_customer
  skip              (closed / out of business / duplicate / Non US)    -> dropped (not emitted)
  invalid-email     (reason "email is invalid: ...")                   -> imported, email nulled (call-only)
  reactivation      (Ordered Pre 2023 / Pre 2020 / blank / other)      -> status=qualified_lead, cohort=ajm_reactivation

Notes:
  - Non-US is skipped ONLY when the reason column says so. Canadian/intl rows
    that are flagged "Ordered from Jaxy" are kept (they are real customers).
  - email_1 in the source is dirty (URLs, LLM error text); we only accept
    values that actually look like an email address.
  - The importer does its own dedupe against existing frame companies and is
    idempotent, so re-running is safe.
"""
import csv
import json
import re
import sys
from collections import Counter

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def norm(s):
    return (s or "").strip()


def clean_email(v):
    e = norm(v).lower()
    if not e or " " in e or len(e) > 120:
        return None
    return e if EMAIL_RE.match(e) else None


def digits(v):
    d = re.sub(r"\D", "", norm(v))
    return d or None


def money(v):
    s = re.sub(r"[^0-9.\-]", "", norm(v))
    try:
        return float(s) if s else None
    except ValueError:
        return None


def to_int(v):
    s = re.sub(r"[^0-9\-]", "", norm(v))
    try:
        return int(s) if s else None
    except ValueError:
        return None


def classify(reason):
    """Return (bucket, status, cohort). bucket in {customer,reactivation,skip,invalid_email}."""
    r = re.sub(r"[\s.\-_|]+", " ", reason.strip().lower())
    if not r:
        return ("reactivation", "qualified_lead", "ajm_reactivation")
    # hard skips first
    if "duplicate" in r or "out of business" in r or "business closed" in r \
            or "store closed" in r or r == "non us" or "non us" in r:
        return ("skip", None, None)
    if r.startswith("email is invalid"):
        return ("invalid_email", "qualified_lead", "ajm_reactivation")
    # already a Jaxy customer (also covers "Pre 2020 | Ordered from Jaxy")
    if any(k in r for k in (
        "jaxy", "already order", "already purchas", "already bought",
        "this location already", "just purchased", "just ordered",
        "ordered jaxy",
    )):
        return ("customer", "customer", "ajm_already_customer")
    # everything else -> reactivation (Ordered Pre 2023, Pre 2020,
    # No last order date, Mostly reading glasses, blank, etc.)
    return ("reactivation", "qualified_lead", "ajm_reactivation")


def build_row(d):
    reason = norm(d.get("Dont send postcard to reason"))
    bucket, status, cohort = classify(reason)
    if bucket == "skip":
        return None, bucket

    email = clean_email(d.get("email_1")) or clean_email(d.get("email_2"))
    if bucket == "invalid_email":
        email = None  # call-only

    tags = ["ajm_2025", cohort]
    cat = norm(d.get("AJM_Category"))
    if cat:
        tags.append(cat)

    row = {
        "name": norm(d.get("CUS_NM")),
        "email": email,
        "phone": digits(d.get("PHONE")),
        "address": norm(d.get("ADDRESS")) or None,
        "address2": norm(d.get("ADDRESS2")) or None,
        "city": norm(d.get("CITY")) or None,
        "state": norm(d.get("STATE")) or None,
        "zip": norm(d.get("ZIP")) or None,
        "country": norm(d.get("COUNTRY")) or "US",
        "contact_first_name": norm(d.get("ATTN")) or None,
        "status": status,                      # customer | qualified_lead
        "source": "ajm_2025_import",
        "tags": tags,
        "ajm_last_order": norm(d.get("Last_Order")) or None,
        "ajm_first_order": norm(d.get("First_Order")) or None,
        "ajm_total_spend": money(d.get("Total_Spend")),
        "ajm_total_orders": to_int(d.get("Total_Orders")),
        "ajm_status": norm(d.get("STATUS")) or None,
        "ajm_category": cat or None,
        "ajm_match_source": norm(d.get("Match_Source")) or None,
        "jaxy_match_reason": reason if bucket == "customer" else None,
        "jaxy_customer_id": norm(d.get("CUS_ID")) or None,
        "cohort": cohort,
    }
    if not row["name"]:
        return None, "skip_no_name"
    return row, bucket


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    inp = sys.argv[1]
    outp = sys.argv[2] if len(sys.argv) > 2 else None

    counts = Counter()
    pipeline = Counter()   # which Pipedrive pipeline the row will seed
    emails = Counter()
    out_rows = []

    with open(inp, newline="", encoding="utf-8-sig", errors="replace") as fh:
        for d in csv.DictReader(fh):
            counts["total"] += 1
            row, bucket = build_row(d)
            counts[bucket] += 1
            if row is None:
                continue
            out_rows.append(row)
            emails["with_email" if row["email"] else "no_email_call_only"] += 1
            # Pipedrive seeding: already-customers seed a Won deal; reactivation
            # seeds an open AJM Reactivation deal (both owned by Christina).
            pipeline["AJM Reactivation (Won)" if row["cohort"] == "ajm_already_customer"
                     else "AJM Reactivation (open)"] += 1

    print(f"\n=== AJM prep summary: {inp} ===")
    print(f"  rows read:            {counts['total']}")
    print(f"  -> emit (import):     {len(out_rows)}")
    print(f"       already-customer:{counts['customer']:>6}  (status=customer, Won deal)")
    print(f"       reactivation:    {counts['reactivation']:>6}  (status=qualified_lead, open deal)")
    print(f"       invalid-email:   {counts['invalid_email']:>6}  (imported, call-only)")
    print(f"  -> skipped:           {counts['skip'] + counts['skip_no_name']}")
    print(f"       closed/dup/NonUS:{counts['skip']:>6}")
    print(f"       no name:         {counts['skip_no_name']:>6}")
    print(f"  contactability of emitted rows:")
    print(f"       with email:      {emails['with_email']:>6}")
    print(f"       call-only:       {emails['no_email_call_only']:>6}")
    print(f"  Pipedrive seeding (owner = Christina):")
    for k, v in pipeline.most_common():
        print(f"       {k:<28}{v:>6}")

    if outp:
        with open(outp, "w", encoding="utf-8") as f:
            for r in out_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"\n  wrote {len(out_rows)} rows -> {outp}")
        print(f"  next: curl -F key=jaxy2026 -F dryRun=true -F file=@{outp} "
              f"<host>/api/admin/sales/import-ajm")
    else:
        print("\n  (no output path given — summary only; pass an output path to write JSONL)")


if __name__ == "__main__":
    main()
