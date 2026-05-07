#!/usr/bin/env python3
"""
Gemma 4 Prospect Qualifier
Runs entirely on local Gemma 4 (Ollama) — zero API cost.

Usage:
  python3 gemma4-qualify.py                    # Process 50 prospects (default)
  python3 gemma4-qualify.py --limit 200        # Process 200
  python3 gemma4-qualify.py --resume           # Skip already-processed
  python3 gemma4-qualify.py --dry-run          # Don't write to DB
  python3 gemma4-qualify.py --db /path/to.db   # Custom DB path
"""

import argparse
import json
import sqlite3
import sys
import time
import re
import asyncio
import aiohttp
from urllib.parse import urlparse
from datetime import datetime

# --- Config ---
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "gemma4:e4b"
SCRAPE_TIMEOUT = 15  # seconds per website
OLLAMA_TIMEOUT = 120  # seconds for Gemma 4 response
BATCH_SIZE = 5  # prospects per Gemma 4 call
MAX_SITE_CHARS = 800  # max chars of website content per prospect
CONCURRENCY = 10  # concurrent web scrapes

# --- ICP Criteria ---
ICP_PROMPT = """You are a wholesale lead qualifier for Jaxy, a trendy eyewear/sunglasses brand.
Price: $25 retail / $7 wholesale. Target: independent US/Canadian retailers.

QUALIFIED stores (our ideal customers):
- Independent boutiques, gift shops, accessories stores
- Surf/skate/outdoor shops
- Bookstores, museum gift shops, resort/hotel shops
- Pharmacies with gift/accessories sections
- Vintage/thrift/consignment stores
- Optical stores, eyewear retailers
- Lifestyle/fashion boutiques
- General stores, mercantile shops
- Record stores, novelty shops

NOT QUALIFIED (hard no):
- Baby/kids/maternity stores
- Pet stores, veterinary
- Florists, nurseries (plant)
- Spas, salons, yoga studios
- Restaurants, cafes, bars
- Auto shops, hardware stores
- Medical/dental offices
- Chain/franchise stores (Nordstrom, REI, etc.)
- Non-US/Canadian stores (we only sell domestically)
- Dead/parked websites
- Stores with no apparent retail component

Rules:
- If the website is dead, parked, or just redirects: NOT_QUALIFIED (reason: "dead website")
- If the store is outside US/Canada: NOT_QUALIFIED (reason: "non-US/CA")
- If unclear from the content, lean toward NEEDS_REVIEW
- Be decisive — most stores should get a clear YES or NO

For each store, respond with EXACTLY this JSON format (no extra text):
[
  {"id": "STORE_ID", "verdict": "QUALIFIED|NOT_QUALIFIED|NEEDS_REVIEW", "type": "store type", "reason": "one sentence", "email": "email@found.com or null"}
]"""


def get_db_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def get_prospects(conn, limit, resume):
    """Get unprocessed prospects with websites."""
    query = """
        SELECT id, name, city, state, website, country
        FROM companies
        WHERE status = 'new'
        AND website IS NOT NULL AND website != ''
        AND website NOT LIKE '%instagram.com%'
        AND website NOT LIKE '%facebook.com%'
    """
    if resume:
        query += " AND (icp_reasoning IS NULL OR icp_reasoning = '')"
    query += f" LIMIT {limit}"
    return conn.execute(query).fetchall()


async def scrape_site(session, url, max_chars=MAX_SITE_CHARS):
    """Scrape a website and return text content."""
    try:
        # Clean URL
        if not url.startswith('http'):
            url = 'https://' + url
        
        # Try main page
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=SCRAPE_TIMEOUT), 
                              allow_redirects=True, ssl=False) as resp:
            if resp.status != 200:
                return f"[HTTP {resp.status}]"
            html = await resp.text()
        
        # Basic HTML to text
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        
        # Extract emails
        emails = list(set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', html)))
        # Filter out common junk
        emails = [e for e in emails if not any(x in e.lower() for x in 
                  ['sentry.io', 'wixpress', 'example.com', 'shopify', 'cloudflare'])]
        
        # Get title
        title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
        title = title_match.group(1).strip() if title_match else ""
        
        result = f"Title: {title}\n{text[:max_chars]}"
        if emails:
            result += f"\nEmails found: {', '.join(emails[:3])}"
        
        # Check final URL for country hints
        final_url = str(resp.url)
        domain = urlparse(final_url).netloc
        if any(domain.endswith(tld) for tld in ['.au', '.uk', '.de', '.fr', '.jp', '.cn', '.nz', '.eu']):
            result += f"\n⚠️ Non-US domain: {domain}"
        
        return result
        
    except asyncio.TimeoutError:
        return "[TIMEOUT - site did not respond]"
    except Exception as e:
        return f"[ERROR: {str(e)[:100]}]"


async def scrape_batch(prospects):
    """Scrape websites for a batch of prospects."""
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, ssl=False)
    async with aiohttp.ClientSession(connector=connector, 
                                      headers={"User-Agent": "Mozilla/5.0 (compatible; JaxyBot/1.0)"}) as session:
        tasks = [scrape_site(session, p['website']) for p in prospects]
        return await asyncio.gather(*tasks)


def call_gemma4(prompt, timeout=OLLAMA_TIMEOUT):
    """Call Gemma 4 via Ollama API synchronously."""
    import urllib.request
    
    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {
            "temperature": 0.1,  # Low temp for consistent classification
            "num_predict": 2048
        }
    }).encode()
    
    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            return data.get("message", {}).get("content", "")
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
        stores_text += f"Content: {content}\n"
    
    return f"""{ICP_PROMPT}

Classify these {len(prospects)} stores:
{stores_text}

Respond with ONLY the JSON array, no other text."""


def parse_gemma_response(response_text, prospect_ids):
    """Parse Gemma 4's JSON response."""
    # Try to extract JSON from response
    try:
        # Find JSON array in response
        match = re.search(r'\[.*\]', response_text, re.DOTALL)
        if match:
            results = json.loads(match.group())
            return results
    except json.JSONDecodeError:
        pass
    
    # Fallback: try to parse line by line
    results = []
    for pid in prospect_ids:
        results.append({
            "id": pid,
            "verdict": "NEEDS_REVIEW",
            "type": "unknown",
            "reason": "Failed to parse Gemma 4 response",
            "email": None
        })
    return results


def update_db(conn, results, dry_run=False):
    """Update prospect statuses in the database."""
    status_map = {
        "QUALIFIED": "qualified",
        "NOT_QUALIFIED": "not_qualified",
        "NEEDS_REVIEW": "new"  # Keep as new for manual review
    }
    
    updated = {"qualified": 0, "not_qualified": 0, "needs_review": 0}
    
    for r in results:
        verdict = r.get("verdict", "NEEDS_REVIEW")
        new_status = status_map.get(verdict, "new")
        store_type = r.get("type", "")
        reason = r.get("reason", "")
        email = r.get("email")
        pid = r.get("id", "")
        
        if verdict == "QUALIFIED":
            updated["qualified"] += 1
        elif verdict == "NOT_QUALIFIED":
            updated["not_qualified"] += 1
        else:
            updated["needs_review"] += 1
        
        if not dry_run and pid:
            # Update status and ICP fields
            conn.execute("""
                UPDATE companies 
                SET status = ?,
                    icp_reasoning = ?,
                    category = ?,
                    enrichment_source = 'gemma4-qualify',
                    enriched_at = ?
                WHERE id = ?
            """, (new_status, f"[gemma4] {reason}", store_type, 
                  datetime.utcnow().isoformat(), pid))
            
            # Update email if found and not already set
            if email and email != "null":
                conn.execute("""
                    UPDATE companies SET email = ? 
                    WHERE id = ? AND (email IS NULL OR email = '')
                """, (email, pid))
    
    if not dry_run:
        conn.commit()
    
    return updated


def main():
    parser = argparse.ArgumentParser(description="Gemma 4 Prospect Qualifier")
    parser.add_argument("--limit", type=int, default=50, help="Max prospects to process")
    parser.add_argument("--resume", action="store_true", help="Skip already-processed")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to DB")
    parser.add_argument("--db", default="/tmp/the-frame-live.db", help="Database path")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help="Prospects per Gemma call")
    args = parser.parse_args()
    
    # Check Ollama is running
    try:
        import urllib.request
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=5)
    except:
        print("❌ Ollama is not running! Start it with: brew services start ollama")
        sys.exit(1)
    
    print(f"🔧 Gemma 4 Prospect Qualifier")
    print(f"   Model: {MODEL}")
    print(f"   DB: {args.db}")
    print(f"   Limit: {args.limit}")
    print(f"   Batch size: {args.batch_size}")
    print(f"   Dry run: {args.dry_run}")
    print()
    
    conn = get_db_connection(args.db)
    prospects = get_prospects(conn, args.limit, args.resume)
    
    if not prospects:
        print("✅ No prospects to process!")
        return
    
    print(f"📋 Found {len(prospects)} prospects to qualify")
    print()
    
    total_stats = {"qualified": 0, "not_qualified": 0, "needs_review": 0}
    total_processed = 0
    start_time = time.time()
    
    # Process in batches
    for batch_start in range(0, len(prospects), args.batch_size):
        batch = prospects[batch_start:batch_start + args.batch_size]
        batch_num = (batch_start // args.batch_size) + 1
        total_batches = (len(prospects) + args.batch_size - 1) // args.batch_size
        
        print(f"━━━ Batch {batch_num}/{total_batches} ({len(batch)} prospects) ━━━")
        
        # Step 1: Scrape websites
        print(f"  🌐 Scraping {len(batch)} websites...", end=" ", flush=True)
        scrape_start = time.time()
        site_contents = asyncio.run(scrape_batch(batch))
        scrape_time = time.time() - scrape_start
        print(f"done ({scrape_time:.1f}s)")
        
        # Step 2: Classify with Gemma 4
        prompt = build_classification_prompt(batch, site_contents)
        print(f"  🤖 Classifying with Gemma 4...", end=" ", flush=True)
        gemma_start = time.time()
        response = call_gemma4(prompt)
        gemma_time = time.time() - gemma_start
        print(f"done ({gemma_time:.1f}s)")
        
        if response.startswith("ERROR"):
            print(f"  ❌ Gemma 4 error: {response}")
            continue
        
        # Step 3: Parse and update
        prospect_ids = [p['id'] for p in batch]
        results = parse_gemma_response(response, prospect_ids)
        batch_stats = update_db(conn, results, args.dry_run)
        
        total_processed += len(batch)
        for k in total_stats:
            total_stats[k] += batch_stats[k]
        
        # Print batch results
        for r in results:
            name = next((p['name'] for p in batch if p['id'] == r.get('id')), '?')
            verdict = r.get('verdict', '?')
            emoji = "✅" if verdict == "QUALIFIED" else "❌" if verdict == "NOT_QUALIFIED" else "🔍"
            reason = r.get('reason', '')[:60]
            email_str = f" 📧 {r['email']}" if r.get('email') and r['email'] != 'null' else ""
            print(f"  {emoji} {name}: {verdict} — {reason}{email_str}")
        
        elapsed = time.time() - start_time
        rate = total_processed / elapsed * 60 if elapsed > 0 else 0
        print(f"  ⏱️  {total_processed}/{len(prospects)} done ({rate:.0f}/min)")
        print()
    
    # Summary
    elapsed = time.time() - start_time
    print(f"━━━ COMPLETE ━━━")
    print(f"  Processed: {total_processed}")
    print(f"  ✅ Qualified: {total_stats['qualified']}")
    print(f"  ❌ Not Qualified: {total_stats['not_qualified']}")
    print(f"  🔍 Needs Review: {total_stats['needs_review']}")
    print(f"  ⏱️  Total time: {elapsed:.0f}s ({total_processed/elapsed*60:.0f}/min)")
    print(f"  💰 Cost: $0.00 (100% local)")
    
    conn.close()


if __name__ == "__main__":
    main()
