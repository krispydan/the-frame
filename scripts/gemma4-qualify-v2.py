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
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "gemma4:e4b"
SCRAPE_TIMEOUT = 12  # seconds per website
OLLAMA_TIMEOUT = 300  # seconds for Gemma 4 response
BATCH_SIZE = 3  # prospects per Gemma 4 call (smaller = more reliable JSON)
MAX_SITE_CHARS = 1200  # increased for better context
CONCURRENCY = 8  # concurrent web scrapes
CHECKPOINT_FILE = Path("/tmp/gemma4-qualify-checkpoint.json")
PROGRESS_FILE = Path("/tmp/gemma4-qualify-progress.json")

# --- Improved ICP Prompt ---
ICP_PROMPT = """You are a wholesale lead qualifier for Jaxy, a trendy lifestyle sunglasses brand.
Wholesale: $7/unit. Retail: $25. Target: independent US/Canadian physical retailers.

QUALIFICATION CRITERIA — must meet ALL:
1. Independent retailer (NOT a chain/franchise — no Nordstrom, Target, Walgreens, etc.)
2. Physical store in US or Canada (NOT online-only)
3. Would logically carry impulse-buy accessories like sunglasses
4. Price range includes $15-50 items (NOT luxury-only $200+, NOT dollar stores)
5. Customer demographic overlaps with sunglasses buyers (fashion-aware, lifestyle, tourists, etc.)

STRONG QUALIFIED (confidence 4-5):
- Boutiques, gift shops, accessories stores, lifestyle shops
- Surf/skate/outdoor shops, beach/resort shops
- Optical stores, eyewear retailers
- Museum/bookstore/novelty gift shops
- Vintage/thrift/consignment with accessories
- General stores, mercantile, tourist shops
- Record stores, smoke shops with accessories
- Pharmacies with gift/accessories sections

WEAK QUALIFIED (confidence 2-3):
- Stores that MIGHT carry sunglasses but it's uncertain
- Clothing stores that don't obviously do accessories
- Home decor that sometimes carries small gifts

NOT QUALIFIED — any ONE of these disqualifies:
- Baby/kids/maternity/pet stores
- Florists, nurseries, garden centers (plant nurseries)
- Spas, salons, yoga studios, wellness-only
- Restaurants, cafes, bars, breweries
- Auto/hardware/plumbing/electrical
- Medical/dental/veterinary offices
- Chain stores or franchises
- Online-only (no physical location evident)
- Outside US/Canada
- Dead/parked/redirecting/error websites
- Wholesale-only (no retail component)
- Too upscale (average item $200+, fine jewelry, art galleries with $1000+ pieces)
- Too downscale (dollar stores, check cashing)
- Services only (lawyers, accountants, contractors)
- Real estate, insurance, financial services

CONFIDENCE SCORING (1-5):
5 = Perfect fit, already sells sunglasses or accessories
4 = Strong fit, clearly carries impulse accessories
3 = Decent fit, would likely carry sunglasses
2 = Possible fit, uncertain from website
1 = Barely qualifies, borderline

For each store, respond with EXACTLY this JSON array (no other text):
[
  {
    "id": "STORE_ID",
    "verdict": "QUALIFIED|NOT_QUALIFIED|NEEDS_REVIEW",
    "confidence": 3,
    "type": "store type (e.g. gift shop, boutique, surf shop)",
    "reason": "one clear sentence explaining why",
    "email": "email@found.com or null",
    "sells_accessories": true,
    "has_physical_store": true,
    "price_range": "$15-80"
  }
]"""


def get_db_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_columns(conn):
    """Add ai_reviewed_by and ai_confidence columns if they don't exist."""
    cursor = conn.execute("PRAGMA table_info(companies)")
    cols = {row[1] for row in cursor.fetchall()}
    if 'ai_reviewed_by' not in cols:
        conn.execute("ALTER TABLE companies ADD COLUMN ai_reviewed_by TEXT")
    if 'ai_confidence' not in cols:
        conn.execute("ALTER TABLE companies ADD COLUMN ai_confidence INTEGER")
    # Drop FTS triggers that can break on local copies
    conn.execute("DROP TRIGGER IF EXISTS companies_fts_update")
    conn.execute("DROP TRIGGER IF EXISTS companies_fts_insert")
    conn.execute("DROP TRIGGER IF EXISTS companies_fts_delete")
    conn.commit()


def get_prospects(conn, limit, processed_ids=None):
    """Get unprocessed prospects with websites."""
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
    """Scrape a website and its contact page, return combined text content."""
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
                    return f"[{label}: HTTP {resp.status}]"
                
                html = await resp.text()
                
                # Extract text
                text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
                text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
                text = re.sub(r'<[^>]+>', ' ', text)
                text = re.sub(r'\s+', ' ', text).strip()
                
                # Extract emails
                emails = list(set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', html)))
                emails = [e for e in emails if not any(x in e.lower() for x in 
                          ['sentry.io', 'wixpress', 'example.com', 'shopify', 'cloudflare',
                           'squarespace', 'w3.org', 'schema.org', 'wordpress'])]
                emails_found.extend(emails)
                
                # Extract phones
                phones = list(set(re.findall(r'(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', html)))
                phones_found.extend(phones)
                
                # Title
                title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
                title = title_match.group(1).strip() if title_match else ""
                
                # Meta description
                meta_match = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']', html, re.IGNORECASE)
                meta_desc = meta_match.group(1).strip() if meta_match else ""
                
                # Find contact page URL
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
                
                # Check final URL domain for country hints
                final_url = str(resp.url)
                domain = urlparse(final_url).netloc
                country_hint = ""
                if any(domain.endswith(tld) for tld in ['.au', '.uk', '.co.uk', '.de', '.fr', '.jp', '.cn', '.nz', '.eu', '.it', '.es']):
                    country_hint = f"\n⚠️ Non-US domain: {domain}"
                
                return {
                    "text": f"{label} — Title: {title}\nMeta: {meta_desc}\n{text[:MAX_SITE_CHARS]}{country_hint}",
                    "contact_urls": contact_urls
                }
        
        except asyncio.TimeoutError:
            return {"text": f"[{label}: TIMEOUT]", "contact_urls": []}
        except Exception as e:
            return {"text": f"[{label}: ERROR {str(e)[:80]}]", "contact_urls": []}
    
    # Fetch main page
    main_result = await fetch_page(url, "Main")
    if isinstance(main_result, str):
        result_parts.append(main_result)
    else:
        result_parts.append(main_result["text"])
        
        # Fetch contact page if found
        if also_scrape_contact and main_result.get("contact_urls"):
            contact_result = await fetch_page(main_result["contact_urls"][0], "Contact")
            if isinstance(contact_result, str):
                result_parts.append(contact_result)
            else:
                result_parts.append(contact_result["text"][:600])
    
    # Dedupe emails and phones
    emails_found = list(set(emails_found))[:5]
    phones_found = list(set(phones_found))[:3]
    
    combined = "\n".join(result_parts)
    if emails_found:
        combined += f"\nEmails found: {', '.join(emails_found)}"
    if phones_found:
        combined += f"\nPhones found: {', '.join(phones_found)}"
    
    return combined


async def scrape_batch(prospects):
    """Scrape websites for a batch of prospects."""
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, ssl=False)
    async with aiohttp.ClientSession(connector=connector,
                                      headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}) as session:
        tasks = [scrape_site(session, p['website']) for p in prospects]
        return await asyncio.gather(*tasks)


def call_gemma4(prompt, timeout=OLLAMA_TIMEOUT):
    """Call Gemma 4 via Ollama generate API (more reliable for long prompts)."""
    import urllib.request
    
    payload = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 4096
        }
    }).encode()
    
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            return data.get("response", "")
    except Exception as e:
        return f"ERROR: {e}"


def build_classification_prompt(prospects, site_contents):
    """Build a single prompt for Gemma 4 to classify a batch."""
    stores_text = ""
    for i, (prospect, content) in enumerate(zip(prospects, site_contents)):
        city = prospect['city'] or 'Unknown'
        state = prospect['state'] or 'Unknown'
        country = prospect['country'] or 'US'
        stores_text += f"\n--- Store {i+1} ---\n"
        stores_text += f"ID: {prospect['id']}\n"
        stores_text += f"Name: {prospect['name']}\n"
        stores_text += f"Location: {city}, {state}, {country}\n"
        stores_text += f"Website: {prospect['website']}\n"
        stores_text += f"Content:\n{content}\n"
    
    return f"""{ICP_PROMPT}

Classify these {len(prospects)} stores:
{stores_text}

Respond with ONLY the JSON array. No markdown, no explanations, just the JSON."""


def parse_gemma_response(response_text, prospect_ids):
    """Parse Gemma 4's JSON response with better error handling."""
    try:
        # Strip markdown code blocks if present
        cleaned = re.sub(r'```json\s*', '', response_text)
        cleaned = re.sub(r'```\s*', '', cleaned)
        
        # Find JSON array
        match = re.search(r'\[.*\]', cleaned, re.DOTALL)
        if match:
            results = json.loads(match.group())
            # Validate each result has required fields
            validated = []
            seen_ids = set()
            for r in results:
                if isinstance(r, dict) and 'id' in r:
                    r.setdefault('verdict', 'NEEDS_REVIEW')
                    r.setdefault('confidence', 2)
                    r.setdefault('type', 'unknown')
                    r.setdefault('reason', 'No reason provided')
                    r.setdefault('email', None)
                    validated.append(r)
                    seen_ids.add(r['id'])
            
            # Add fallback entries for any prospect IDs that Gemma didn't return
            for pid in prospect_ids:
                if pid not in seen_ids:
                    validated.append({
                        "id": pid,
                        "verdict": "NEEDS_REVIEW",
                        "confidence": 1,
                        "type": "unknown",
                        "reason": "AI did not return classification for this store",
                        "email": None
                    })
            
            if validated:
                return validated
    except json.JSONDecodeError as e:
        print(f"    ⚠️  JSON parse error: {e}")
        # Log the problematic response for debugging
        log_file = Path("/tmp/gemma4-parse-errors.log")
        with open(log_file, "a") as f:
            f.write(f"\n{'='*60}\n{datetime.utcnow().isoformat()}\n")
            f.write(f"Prospect IDs: {prospect_ids}\n")
            f.write(f"Response (first 500 chars): {response_text[:500]}\n")
    
    # Fallback: mark all as NEEDS_REVIEW
    results = []
    for pid in prospect_ids:
        results.append({
            "id": pid,
            "verdict": "NEEDS_REVIEW",
            "confidence": 1,
            "type": "unknown",
            "reason": "Failed to parse AI response",
            "email": None
        })
    return results


def update_db(conn, results, batch_prospects, dry_run=False):
    """Update prospect statuses in the database."""
    status_map = {
        "QUALIFIED": "qualified",
        "NOT_QUALIFIED": "not_qualified",
        "NEEDS_REVIEW": "new"
    }
    
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
            
            # Build disqualify reason if not qualified
            dq_reason = None
            if verdict == "NOT_QUALIFIED":
                dq_reason = reason
            
            conn.execute("""
                UPDATE companies 
                SET status = ?,
                    icp_reasoning = ?,
                    category = ?,
                    ai_reviewed_by = 'gemma4-v2',
                    ai_confidence = ?,
                    enrichment_source = 'gemma4-qualify',
                    enriched_at = ?,
                    disqualify_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE disqualify_reason END,
                    updated_at = ?
                WHERE id = ?
            """, (new_status, f"[gemma4-v2] {reason}", store_type, 
                  confidence, now, dq_reason, dq_reason, now, pid))
            
            # Update email if found and not already set
            if email and email != "null" and email != "None":
                conn.execute("""
                    UPDATE companies SET email = ? 
                    WHERE id = ? AND (email IS NULL OR email = '')
                """, (email, pid))
    
    if not dry_run:
        conn.commit()
    
    return updated


def load_checkpoint():
    """Load checkpoint of already-processed IDs."""
    if CHECKPOINT_FILE.exists():
        try:
            data = json.loads(CHECKPOINT_FILE.read_text())
            return set(data.get("processed_ids", []))
        except:
            pass
    return set()


def save_checkpoint(processed_ids, stats):
    """Save checkpoint for crash recovery."""
    CHECKPOINT_FILE.write_text(json.dumps({
        "processed_ids": list(processed_ids),
        "stats": stats,
        "timestamp": datetime.utcnow().isoformat()
    }))


def save_progress(stats, total, elapsed):
    """Save progress for external monitoring."""
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


def main():
    parser = argparse.ArgumentParser(description="Gemma 4 Prospect Qualifier v2")
    parser.add_argument("--limit", type=int, default=999999, help="Max prospects to process")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to DB")
    parser.add_argument("--db", default="/tmp/the-frame-live.db", help="Database path")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help="Prospects per Gemma call")
    parser.add_argument("--reset", action="store_true", help="Clear checkpoint and start fresh")
    args = parser.parse_args()
    
    # Check Ollama is running
    try:
        import urllib.request
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=5)
    except:
        print("❌ Ollama is not running! Start it with: brew services start ollama")
        sys.exit(1)
    
    # Load checkpoint
    if args.reset and CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()
        print("🔄 Checkpoint cleared")
    
    processed_ids = load_checkpoint()
    if processed_ids:
        print(f"📌 Resuming from checkpoint — {len(processed_ids)} already processed")
    
    print(f"🔧 Gemma 4 Prospect Qualifier v2")
    print(f"   Model: {MODEL}")
    print(f"   DB: {args.db}")
    print(f"   Batch size: {args.batch_size}")
    print(f"   Dry run: {args.dry_run}")
    print()
    
    conn = get_db_connection(args.db)
    ensure_columns(conn)
    
    # Get total count first
    total_unreviewed = conn.execute("""
        SELECT COUNT(*) FROM companies 
        WHERE status = 'new' AND website IS NOT NULL AND website != ''
        AND website NOT LIKE '%instagram.com%' AND website NOT LIKE '%facebook.com%'
        AND website NOT LIKE '%yelp.com%' AND website NOT LIKE '%google.com/maps%'
        AND (ai_reviewed_by IS NULL OR ai_reviewed_by = '')
    """).fetchone()[0]
    
    print(f"📋 {total_unreviewed} prospects to qualify")
    print()
    
    total_stats = {"qualified": 0, "not_qualified": 0, "needs_review": 0, 
                   "total_processed": 0, "emails_found": 0, "errors": 0}
    start_time = time.time()
    consecutive_errors = 0
    
    # Process in waves (re-query DB each wave to get fresh unprocessed)
    wave = 0
    while True:
        wave += 1
        prospects = get_prospects(conn, min(args.batch_size * 20, args.limit - total_stats["total_processed"]), processed_ids)
        
        if not prospects:
            print("✅ No more prospects to process!")
            break
        
        if total_stats["total_processed"] >= args.limit:
            print(f"📊 Reached limit of {args.limit}")
            break
        
        # Process this wave in batches
        for batch_start in range(0, len(prospects), args.batch_size):
            batch = prospects[batch_start:batch_start + args.batch_size]
            batch_num = total_stats["total_processed"] // args.batch_size + 1
            
            print(f"━━━ Batch {batch_num} | {total_stats['total_processed']}/{total_unreviewed} done ━━━")
            
            # Step 1: Scrape websites + contact pages
            print(f"  🌐 Scraping {len(batch)} sites (+contact pages)...", end=" ", flush=True)
            try:
                scrape_start = time.time()
                site_contents = asyncio.run(scrape_batch(batch))
                scrape_time = time.time() - scrape_start
                print(f"done ({scrape_time:.1f}s)")
            except Exception as e:
                print(f"SCRAPE ERROR: {e}")
                total_stats["errors"] += 1
                consecutive_errors += 1
                if consecutive_errors >= 5:
                    print("❌ Too many consecutive errors, stopping")
                    break
                continue
            
            # Step 2: Classify with Gemma 4
            prompt = build_classification_prompt(batch, site_contents)
            print(f"  🤖 Classifying with Gemma 4...", end=" ", flush=True)
            
            try:
                gemma_start = time.time()
                response = call_gemma4(prompt)
                gemma_time = time.time() - gemma_start
                print(f"done ({gemma_time:.1f}s)")
            except Exception as e:
                print(f"GEMMA ERROR: {e}")
                total_stats["errors"] += 1
                consecutive_errors += 1
                if consecutive_errors >= 5:
                    print("❌ Too many consecutive errors, stopping")
                    break
                time.sleep(5)
                continue
            
            if response.startswith("ERROR"):
                print(f"  ❌ Gemma 4 error: {response}")
                total_stats["errors"] += 1
                consecutive_errors += 1
                if consecutive_errors >= 5:
                    print("❌ Too many consecutive errors, stopping")
                    break
                time.sleep(5)
                continue
            
            if not response.strip():
                print(f"  ❌ Empty Gemma response")
                total_stats["errors"] += 1
                consecutive_errors += 1
                if consecutive_errors >= 5:
                    print("❌ Too many consecutive errors, stopping")
                    break
                time.sleep(5)
                continue
            
            # Reset consecutive error counter on success
            consecutive_errors = 0
            
            # Step 3: Parse and update
            prospect_ids = [p['id'] for p in batch]
            results = parse_gemma_response(response, prospect_ids)
            batch_stats = update_db(conn, results, batch, args.dry_run)
            
            # Track processed IDs for checkpoint
            for pid in prospect_ids:
                processed_ids.add(pid)
            
            total_stats["total_processed"] += len(batch)
            for k in ["qualified", "not_qualified", "needs_review"]:
                total_stats[k] += batch_stats[k]
            
            # Count new emails found
            for r in results:
                if r.get("email") and r["email"] not in ("null", "None", None):
                    total_stats["emails_found"] += 1
            
            # Print batch results
            for r in results:
                name = next((p['name'] for p in batch if p['id'] == r.get('id')), '?')
                verdict = r.get('verdict', '?')
                confidence = r.get('confidence', '?')
                emoji = "✅" if verdict == "QUALIFIED" else "❌" if verdict == "NOT_QUALIFIED" else "🔍"
                reason = r.get('reason', '')[:70]
                email_str = f" 📧" if r.get('email') and r['email'] not in ('null', 'None', None) else ""
                print(f"  {emoji} [{confidence}] {name}: {verdict} — {reason}{email_str}")
            
            elapsed = time.time() - start_time
            rate = total_stats["total_processed"] / elapsed * 60 if elapsed > 0 else 0
            remaining = total_unreviewed - total_stats["total_processed"]
            eta_min = remaining / rate if rate > 0 else 0
            print(f"  ⏱️  {total_stats['total_processed']}/{total_unreviewed} | {rate:.0f}/min | ETA: {eta_min:.0f}min")
            print()
            
            # Save checkpoint every batch
            save_checkpoint(processed_ids, total_stats)
            save_progress(total_stats, total_unreviewed, elapsed)
    
    # Final summary
    elapsed = time.time() - start_time
    print()
    print(f"{'━' * 60}")
    print(f"  COMPLETE")
    print(f"  Processed: {total_stats['total_processed']}")
    print(f"  ✅ Qualified: {total_stats['qualified']}")
    print(f"  ❌ Not Qualified: {total_stats['not_qualified']}")
    print(f"  🔍 Needs Review: {total_stats['needs_review']}")
    print(f"  📧 Emails found: {total_stats['emails_found']}")
    print(f"  ⚠️  Errors: {total_stats['errors']}")
    print(f"  ⏱️  Total: {elapsed:.0f}s ({total_stats['total_processed']/max(elapsed,1)*60:.0f}/min)")
    print(f"  💰 Cost: $0.00 (100% local)")
    print(f"{'━' * 60}")
    
    # Save final progress
    save_progress(total_stats, total_unreviewed, elapsed)
    PROGRESS_FILE.write_text(json.dumps({
        **json.loads(PROGRESS_FILE.read_text()),
        "status": "complete"
    }))
    
    conn.close()


if __name__ == "__main__":
    main()
