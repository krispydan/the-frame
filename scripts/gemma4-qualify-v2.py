#!/usr/bin/env python3
"""
Gemma 4 Prospect Qualifier v2
Tighter ICP criteria, confidence scores, contact page scraping, crash recovery.

Usage:
  python3 gemma4-qualify-v2.py                     # Process all unreviewed
  python3 gemma4-qualify-v2.py --limit 200         # Process 200
  python3 gemma4-qualify-v2.py --dry-run            # Don't write to DB
  python3 gemma4-qualify-v2.py --db /path/to.db     # Custom DB path
"""

import argparse
import json
import sqlite3
import sys
import time
import re
import asyncio
import aiohttp
from urllib.parse import urlparse, urljoin
from datetime import datetime
from pathlib import Path

# --- Config ---
MODEL = "gemma4:e4b"
OLLAMA_GENERATE_URL = "http://127.0.0.1:11434/api/generate"
SCRAPE_TIMEOUT = 12
OLLAMA_TIMEOUT = 300
BATCH_SIZE = 1
MAX_SITE_CHARS = 1200
MAX_PROMPT_SITE_CHARS = 900
CONCURRENCY = 8
CHECKPOINT_FILE = Path("/tmp/gemma4-qualify-checkpoint.json")
PROGRESS_FILE = Path("/tmp/gemma4-qualify-progress.json")
OLLAMA_DEBUG_LOG = Path("/tmp/gemma4-qualify-ollama-errors.log")
OLLAMA_RETRIES = 3


def get_db_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_columns(conn):
    cursor = conn.execute("PRAGMA table_info(companies)")
    cols = {row[1] for row in cursor.fetchall()}
    if 'ai_reviewed_by' not in cols:
        conn.execute("ALTER TABLE companies ADD COLUMN ai_reviewed_by TEXT")
    if 'ai_confidence' not in cols:
        conn.execute("ALTER TABLE companies ADD COLUMN ai_confidence INTEGER")
    conn.execute("DROP TRIGGER IF EXISTS companies_fts_update")
    conn.execute("DROP TRIGGER IF EXISTS companies_fts_insert")
    conn.execute("DROP TRIGGER IF EXISTS companies_fts_delete")
    conn.commit()


def get_prospects(conn, limit, processed_ids=None):
    query = """
        SELECT id, name, city, state, website, country
        FROM companies
        WHERE status = 'new'
        AND website IS NOT NULL AND website != ''
        AND website NOT LIKE '%instagram.com%'
        AND website NOT LIKE '%facebook.com%'
        AND website NOT LIKE '%yelp.com%'
        AND website NOT LIKE '%google.com/maps%'
        AND (ai_reviewed_by IS NULL OR ai_reviewed_by = '')
    """
    if processed_ids:
        placeholders = ','.join(['?' for _ in processed_ids])
        query += f" AND id NOT IN ({placeholders})"
        query += f" ORDER BY RANDOM() LIMIT {limit}"
        return conn.execute(query, list(processed_ids)).fetchall()
    query += f" ORDER BY RANDOM() LIMIT {limit}"
    return conn.execute(query).fetchall()


async def scrape_site(session, url, also_scrape_contact=True):
    result_parts = []
    emails_found = []
    phones_found = []

    async def fetch_page(page_url, label="Main"):
        nonlocal emails_found, phones_found
        try:
            if not page_url.startswith('http'):
                page_url = 'https://' + page_url
            async with session.get(page_url, timeout=aiohttp.ClientTimeout(total=SCRAPE_TIMEOUT),
                                  allow_redirects=True, ssl=False) as resp:
                if resp.status != 200:
                    return {"text": f"[{label}: HTTP {resp.status}]", "contact_urls": []}
                html = await resp.text()
                text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
                text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
                text = re.sub(r'<[^>]+>', ' ', text)
                text = re.sub(r'\s+', ' ', text).strip()
                emails = list(set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', html)))
                emails = [e for e in emails if not any(x in e.lower() for x in
                          ['sentry.io', 'wixpress', 'example.com', 'shopify', 'cloudflare',
                           'squarespace', 'w3.org', 'schema.org', 'wordpress'])]
                emails_found.extend(emails)
                phones = list(set(re.findall(r'(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', html)))
                phones_found.extend(phones)
                title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
                title = title_match.group(1).strip() if title_match else ""
                meta_match = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']', html, re.IGNORECASE)
                meta_desc = meta_match.group(1).strip() if meta_match else ""
                contact_urls = []
                if also_scrape_contact and label == "Main":
                    contact_links = re.findall(r'href=["\']([^"\']*(?:contact|about|connect)[^"\']*)["\']', html, re.IGNORECASE)
                    base_url = str(resp.url)
                    for link in contact_links[:2]:
                        try:
                            full = urljoin(base_url, link)
                            if urlparse(full).netloc == urlparse(base_url).netloc:
                                contact_urls.append(full)
                        except:
                            pass
                final_url = str(resp.url)
                domain = urlparse(final_url).netloc
                country_hint = ""
                if any(domain.endswith(tld) for tld in ['.au', '.uk', '.co.uk', '.de', '.fr', '.jp', '.cn', '.nz', '.eu', '.it', '.es']):
                    country_hint = f"\nNon-US domain: {domain}"
                return {
                    "text": f"{label} -- Title: {title}\nMeta: {meta_desc}\n{text[:MAX_SITE_CHARS]}{country_hint}",
                    "contact_urls": contact_urls
                }
        except asyncio.TimeoutError:
            return {"text": f"[{label}: TIMEOUT]", "contact_urls": []}
        except Exception as e:
            return {"text": f"[{label}: ERROR {str(e)[:80]}]", "contact_urls": []}

    main_result = await fetch_page(url, "Main")
    if isinstance(main_result, str):
        result_parts.append(main_result)
    else:
        result_parts.append(main_result["text"])
        if also_scrape_contact and main_result.get("contact_urls"):
            contact_result = await fetch_page(main_result["contact_urls"][0], "Contact")
            if isinstance(contact_result, str):
                result_parts.append(contact_result)
            else:
                result_parts.append(contact_result["text"][:600])

    emails_found = list(set(emails_found))[:5]
    phones_found = list(set(phones_found))[:3]
    combined = "\n".join(result_parts)
    if emails_found:
        combined += f"\nEmails found: {', '.join(emails_found)}"
    if phones_found:
        combined += f"\nPhones found: {', '.join(phones_found)}"
    return combined


async def scrape_batch(prospects):
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, ssl=False)
    async with aiohttp.ClientSession(connector=connector,
                                      headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}) as session:
        tasks = [scrape_site(session, p['website']) for p in prospects]
        return await asyncio.gather(*tasks)


def log_ollama_error(message):
    timestamp = datetime.now().isoformat()
    with OLLAMA_DEBUG_LOG.open("a") as f:
        f.write(f"\n[{timestamp}] {message}\n")


def call_gemma4(prompt, timeout=OLLAMA_TIMEOUT):
    import subprocess
    payload = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 256, "num_ctx": 8192}
    })
    # Write payload to temp file to avoid shell arg length/encoding issues
    tmp_path = '/tmp/gemma4_payload.json'
    with open(tmp_path, 'w') as f:
        f.write(payload)
    last_error = "ERROR: unknown"
    for attempt in range(1, OLLAMA_RETRIES + 1):
        try:
            result = subprocess.run(
                ['curl', '-s', '-H', 'Content-Type: application/json',
                 '-X', 'POST', OLLAMA_GENERATE_URL, '-d', f'@{tmp_path}'],
                capture_output=True, text=True, timeout=timeout
            )
            if result.returncode != 0:
                last_error = f"ERROR: curl failed with code {result.returncode}"
                log_ollama_error(f"attempt={attempt} {last_error}")
                time.sleep(min(attempt, 3))
                continue

            stdout = (result.stdout or "").strip()
            if not stdout:
                last_error = "ERROR: empty stdout from ollama"
                log_ollama_error(f"attempt={attempt} {last_error}")
                time.sleep(min(attempt, 3))
                continue

            try:
                data = json.loads(stdout)
            except json.JSONDecodeError as e:
                last_error = f"ERROR: invalid JSON from ollama: {e}"
                log_ollama_error(f"attempt={attempt} {last_error} raw={stdout[:500]}")
                time.sleep(min(attempt, 3))
                continue

            response = (data.get("response") or "").strip()
            if response:
                return response

            if data.get("error"):
                last_error = f"ERROR: ollama error: {data['error']}"
            else:
                last_error = "ERROR: empty model response"
            log_ollama_error(f"attempt={attempt} {last_error} raw={stdout[:500]}")
            time.sleep(min(attempt, 3))
        except subprocess.TimeoutExpired:
            last_error = "ERROR: timeout"
            log_ollama_error(f"attempt={attempt} {last_error}")
        except Exception as e:
            last_error = f"ERROR: {e}"
            log_ollama_error(f"attempt={attempt} {last_error}")
    return last_error


def build_classification_prompt(prospects, site_contents):
    p = prospects[0]
    content = site_contents[0]
    if len(content) > MAX_PROMPT_SITE_CHARS:
        content = content[:MAX_PROMPT_SITE_CHARS]
    city = p['city'] or 'Unknown'
    state = p['state'] or 'Unknown'
    country = p['country'] or 'US'

    # Use pipe-separated format -- no JSON braces which confuse Gemma
    return f"""Classify this store for Jaxy sunglasses wholesale. Jaxy sells trendy sunglasses at $25 retail / $7 wholesale to independent US and Canadian retailers.

Store: {p['name']}
Location: {city}, {state}, {country}
Website: {p['website']}
Content:
{content}

QUALIFIED if: independent physical retailer in US/CA, sells accessories/gifts/impulse items in $15-50 range, customer base would buy sunglasses.
NOT_QUALIFIED if: chain/franchise, online-only, outside US/CA, dead website, baby/pet/auto/medical/restaurant/salon/services, too upscale ($200+) or too downscale (dollar store), wholesale-only.
NEEDS_REVIEW if: cannot tell from website content.

Answer these fields separated by pipes on a single line:
VERDICT | CONFIDENCE | TYPE | REASON | EMAIL

VERDICT = QUALIFIED or NOT_QUALIFIED or NEEDS_REVIEW
CONFIDENCE = 1 to 5 (5 means already sells sunglasses)
TYPE = store type like gift shop, boutique, surf shop
REASON = one sentence why
EMAIL = any email found on the site, or none

Respond with ONLY the single pipe-separated line."""


def parse_gemma_response(response_text, prospect_ids):
    """Parse pipe-separated, JSON, or free-text response from Gemma."""
    cleaned = response_text.strip()
    pid = prospect_ids[0]

    # 1. Try pipe-separated: VERDICT | CONFIDENCE | TYPE | REASON | EMAIL
    for line in cleaned.split('\n'):
        line = line.strip()
        if '|' not in line:
            continue
        # Skip header-like lines
        if any(h in line.upper() for h in ['VERDICT', 'FIELD', '---', '===']):
            continue
        parts = [p.strip() for p in line.split('|')]
        if len(parts) >= 3:
            # Find verdict
            verdict = 'NEEDS_REVIEW'
            for v in ['NOT_QUALIFIED', 'QUALIFIED', 'NEEDS_REVIEW']:
                if v in parts[0].upper().replace(' ', '_'):
                    verdict = v
                    break
            # Confidence
            confidence = 2
            try:
                confidence = int(re.search(r'\d', parts[1]).group())
            except Exception:
                pass
            # Type
            store_type = parts[2].strip() if len(parts) > 2 else 'unknown'
            # Reason
            reason = parts[3].strip() if len(parts) > 3 else 'No reason'
            # Email
            email_val = parts[4].strip() if len(parts) > 4 else None
            if email_val and email_val.lower() in ('none', 'null', 'n/a', '-', ''):
                email_val = None
            if email_val and '@' not in email_val:
                email_val = None
            return [{'id': pid, 'verdict': verdict, 'confidence': confidence,
                     'type': store_type, 'reason': reason, 'email': email_val}]

    # 2. Try JSON
    try:
        c2 = re.sub(r'```json\s*', '', cleaned)
        c2 = re.sub(r'```\s*', '', c2)
        obj_match = re.search(r'\{[^{}]*verdict[^{}]*\}', c2, re.DOTALL | re.IGNORECASE)
        if obj_match:
            obj = json.loads(obj_match.group())
            obj['id'] = pid
            obj.setdefault('verdict', 'NEEDS_REVIEW')
            obj.setdefault('confidence', 2)
            obj.setdefault('type', 'unknown')
            obj.setdefault('reason', 'No reason')
            obj.setdefault('email', None)
            return [obj]
    except Exception:
        pass

    # 3. Free text verdict extraction
    upper = cleaned.upper()
    if 'NOT_QUALIFIED' in upper or 'NOT QUALIFIED' in upper:
        return [{'id': pid, 'verdict': 'NOT_QUALIFIED', 'confidence': 2,
                 'type': 'unknown', 'reason': cleaned[:120], 'email': None}]
    elif 'QUALIFIED' in upper:
        return [{'id': pid, 'verdict': 'QUALIFIED', 'confidence': 2,
                 'type': 'unknown', 'reason': cleaned[:120], 'email': None}]

    # 4. Log and fallback
    log_file = Path('/tmp/gemma4-parse-errors.log')
    with open(log_file, 'a') as f:
        f.write(f"\n{'='*60}\n{datetime.utcnow().isoformat()}\nID: {pid}\nResponse: {response_text[:500]}\n")
    return [{'id': pid, 'verdict': 'NEEDS_REVIEW', 'confidence': 1,
             'type': 'unknown', 'reason': 'Failed to parse AI response', 'email': None}]


def update_db(conn, results, batch_prospects, dry_run=False):
    status_map = {"QUALIFIED": "qualified", "NOT_QUALIFIED": "not_qualified", "NEEDS_REVIEW": "new"}
    updated = {"qualified": 0, "not_qualified": 0, "needs_review": 0}
    for r in results:
        verdict = r.get("verdict", "NEEDS_REVIEW")
        new_status = status_map.get(verdict, "new")
        store_type = r.get("type", "")
        reason = r.get("reason", "")
        confidence = r.get("confidence", 2)
        email = r.get("email")
        pid = r.get("id", "")
        if verdict == "QUALIFIED":
            updated["qualified"] += 1
        elif verdict == "NOT_QUALIFIED":
            updated["not_qualified"] += 1
        else:
            updated["needs_review"] += 1
        if not dry_run and pid:
            now = datetime.utcnow().isoformat()
            dq_reason = reason if verdict == "NOT_QUALIFIED" else None
            conn.execute("""
                UPDATE companies
                SET status = ?, icp_reasoning = ?, category = ?,
                    ai_reviewed_by = 'gemma4-v2', ai_confidence = ?,
                    enrichment_source = 'gemma4-qualify', enriched_at = ?,
                    disqualify_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE disqualify_reason END,
                    updated_at = ?
                WHERE id = ?
            """, (new_status, f"[gemma4-v2] {reason}", store_type,
                  confidence, now, dq_reason, dq_reason, now, pid))
            if email and email not in ("null", "None"):
                conn.execute("UPDATE companies SET email = ? WHERE id = ? AND (email IS NULL OR email = '')",
                             (email, pid))
    if not dry_run:
        conn.commit()
    return updated


def load_checkpoint():
    if CHECKPOINT_FILE.exists():
        try:
            return set(json.loads(CHECKPOINT_FILE.read_text()).get("processed_ids", []))
        except:
            pass
    return set()


def save_checkpoint(processed_ids, stats):
    CHECKPOINT_FILE.write_text(json.dumps({
        "processed_ids": list(processed_ids), "stats": stats,
        "timestamp": datetime.utcnow().isoformat()
    }))


def save_progress(stats, total, elapsed):
    PROGRESS_FILE.write_text(json.dumps({
        "total_prospects": total,
        "processed": stats.get("total_processed", 0),
        "qualified": stats.get("qualified", 0),
        "not_qualified": stats.get("not_qualified", 0),
        "needs_review": stats.get("needs_review", 0),
        "emails_found": stats.get("emails_found", 0),
        "elapsed_seconds": int(elapsed),
        "rate_per_min": round(stats.get("total_processed", 0) / max(elapsed, 1) * 60, 1),
        "status": "running",
        "timestamp": datetime.utcnow().isoformat()
    }))


def save_error_progress(stats, total, elapsed, message):
    PROGRESS_FILE.write_text(json.dumps({
        "total_prospects": total,
        "processed": stats.get("total_processed", 0),
        "qualified": stats.get("qualified", 0),
        "not_qualified": stats.get("not_qualified", 0),
        "needs_review": stats.get("needs_review", 0),
        "emails_found": stats.get("emails_found", 0),
        "elapsed_seconds": int(elapsed),
        "rate_per_min": round(stats.get("total_processed", 0) / max(elapsed, 1) * 60, 1),
        "status": "error",
        "error": message,
        "timestamp": datetime.utcnow().isoformat()
    }))


def main():
    parser = argparse.ArgumentParser(description="Gemma 4 Prospect Qualifier v2")
    parser.add_argument("--limit", type=int, default=999999)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--db", default="/tmp/the-frame-live.db")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    try:
        import urllib.request
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=5)
    except:
        print("Ollama is not running!")
        sys.exit(1)

    if args.reset and CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()

    processed_ids = load_checkpoint()
    if processed_ids:
        print(f"Resuming -- {len(processed_ids)} already processed")

    print(f"Gemma 4 Qualifier v2 | Model: {MODEL} | DB: {args.db} | Batch: {args.batch_size}")
    print()

    conn = get_db_connection(args.db)
    ensure_columns(conn)

    total_unreviewed = conn.execute("""
        SELECT COUNT(*) FROM companies
        WHERE status = 'new' AND website IS NOT NULL AND website != ''
        AND website NOT LIKE '%instagram.com%' AND website NOT LIKE '%facebook.com%'
        AND website NOT LIKE '%yelp.com%' AND website NOT LIKE '%google.com/maps%'
        AND (ai_reviewed_by IS NULL OR ai_reviewed_by = '')
    """).fetchone()[0]

    print(f"{total_unreviewed} prospects to qualify\n")

    total_stats = {"qualified": 0, "not_qualified": 0, "needs_review": 0,
                   "total_processed": 0, "emails_found": 0, "errors": 0}
    start_time = time.time()
    consecutive_errors = 0
    save_progress(total_stats, total_unreviewed, 0)

    while True:
        remaining_limit = args.limit - total_stats["total_processed"]
        if remaining_limit <= 0:
            break
        prospects = get_prospects(conn, min(args.batch_size * 20, remaining_limit), processed_ids)
        if not prospects:
            print("Done -- no more prospects!")
            break

        for batch_start in range(0, len(prospects), args.batch_size):
            batch = prospects[batch_start:batch_start + args.batch_size]
            batch_num = total_stats["total_processed"] + 1

            print(f"--- {batch_num}/{total_unreviewed} ---")

            # Scrape
            print(f"  Scraping...", end=" ", flush=True)
            try:
                site_contents = asyncio.run(scrape_batch(batch))
                print("ok")
            except Exception as e:
                print(f"SCRAPE ERROR: {e}")
                total_stats["errors"] += 1
                consecutive_errors += 1
                if consecutive_errors >= 10:
                    print("Too many errors, stopping")
                    break
                continue

            # Classify
            prompt = build_classification_prompt(batch, site_contents)
            print(f"  Classifying...", end=" ", flush=True)
            try:
                t0 = time.time()
                response = call_gemma4(prompt)
                dt = time.time() - t0
                print(f"{dt:.0f}s")
            except Exception as e:
                print(f"ERROR: {e}")
                total_stats["errors"] += 1
                consecutive_errors += 1
                if consecutive_errors >= 10:
                    break
                time.sleep(3)
                continue

            if response.startswith("ERROR") or not response.strip():
                print(f"  Empty/error response -- skipping")
                total_stats["errors"] += 1
                consecutive_errors += 1
                save_checkpoint(processed_ids, total_stats)
                save_error_progress(
                    total_stats,
                    total_unreviewed,
                    time.time() - start_time,
                    response[:300] if response else "Empty model response",
                )
                if consecutive_errors >= 10:
                    print("Too many errors, stopping")
                    break
                time.sleep(3)
                continue

            consecutive_errors = 0

            # Parse and update
            prospect_ids = [p['id'] for p in batch]
            results = parse_gemma_response(response, prospect_ids)
            batch_stats = update_db(conn, results, batch, args.dry_run)

            for pid in prospect_ids:
                processed_ids.add(pid)

            total_stats["total_processed"] += len(batch)
            for k in ["qualified", "not_qualified", "needs_review"]:
                total_stats[k] += batch_stats[k]
            for r in results:
                if r.get("email") and r["email"] not in ("null", "None", None):
                    total_stats["emails_found"] += 1

            # Print result
            for r in results:
                name = next((p['name'] for p in batch if p['id'] == r.get('id')), '?')
                verdict = r.get('verdict', '?')
                confidence = r.get('confidence', '?')
                e = "Q" if verdict == "QUALIFIED" else "X" if verdict == "NOT_QUALIFIED" else "?"
                reason = r.get('reason', '')[:70]
                em = " email" if r.get('email') and r['email'] not in ('null', 'None', None) else ""
                print(f"  [{e}{confidence}] {name}: {reason}{em}")

            elapsed = time.time() - start_time
            rate = total_stats["total_processed"] / elapsed * 60 if elapsed > 0 else 0
            remaining = total_unreviewed - total_stats["total_processed"]
            eta_min = remaining / rate if rate > 0 else 0
            print(f"  {total_stats['total_processed']}/{total_unreviewed} | {rate:.1f}/min | ETA: {eta_min:.0f}min\n")

            save_checkpoint(processed_ids, total_stats)
            save_progress(total_stats, total_unreviewed, elapsed)

    elapsed = time.time() - start_time
    print(f"\n{'='*50}")
    print(f"COMPLETE: {total_stats['total_processed']} processed")
    print(f"  Qualified: {total_stats['qualified']}")
    print(f"  Not Qualified: {total_stats['not_qualified']}")
    print(f"  Needs Review: {total_stats['needs_review']}")
    print(f"  Emails: {total_stats['emails_found']}")
    print(f"  Errors: {total_stats['errors']}")
    print(f"  Time: {elapsed:.0f}s ({total_stats['total_processed']/max(elapsed,1)*60:.1f}/min)")
    print(f"  Cost: $0.00")

    save_progress(total_stats, total_unreviewed, elapsed)
    try:
        d = json.loads(PROGRESS_FILE.read_text())
        d["status"] = "complete"
        PROGRESS_FILE.write_text(json.dumps(d))
    except:
        pass
    conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        try:
            message = f"{type(e).__name__}: {e}"
            save_error_progress(
                {"qualified": 0, "not_qualified": 0, "needs_review": 0, "total_processed": 0, "emails_found": 0},
                0,
                0,
                message,
            )
        except Exception:
            pass
        raise
