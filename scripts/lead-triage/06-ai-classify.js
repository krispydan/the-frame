#!/usr/bin/env node
// Pass 6: AI Classification of remaining "new" leads
// Uses Gemini 2.0 Flash for cheap batch classification
// Processes 50 leads per API call, 5 concurrent calls

const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.argv[2] || '/tmp/triage-test.db';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 50;
const CONCURRENCY = 5;
const MODEL = 'gemini-2.0-flash';

// Load API key
const envFile = fs.readFileSync('/Users/bubbe/Dropbox/Obsidian/.secrets/google-gemini.env', 'utf8');
const API_KEY = envFile.match(/GOOGLE_GEMINI_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) throw new Error('No API key found');

const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const SYSTEM_PROMPT = `You are classifying retail stores for Jaxy, a wholesale sunglasses brand.
Jaxy sells affordable fashion sunglasses ($25 retail, $7 wholesale) to independent retailers in the US and Canada.

For each store, determine if it would likely carry sunglasses (spinner rack, display case, accessories section).

QUALIFY (score 4-5) if the store is:
- A boutique, gift shop, pharmacy, bookstore, surf/beach/ski shop, museum gift shop
- A vintage/thrift/consignment store, general store, outfitter, or mercantile
- A car wash with a retail area
- A resort or hotel gift shop
- An independent clothing, accessories, or lifestyle store
- A souvenir, tourist, or convenience shop
- A record/vinyl store, skate shop, or board shop
- Any retail store where sunglasses are a natural impulse-buy add-on
- A Hallmark or card/gift store

DISQUALIFY (score 1-2) if the store is:
- A service business (lessons, repairs, schools, tours, cleaning)
- A restaurant, bar, cafe, or food service
- A personal care business (salon, spa, nail, lash, tanning, barber)
- A medical/dental/health/veterinary practice
- A professional service (law, accounting, insurance, real estate)
- An automotive shop, home services, or industrial supplier
- A big box chain with central buying (Walmart, Target, etc.)
- A pet store, kids-only store, or fitness/gym
- A church, funeral home, nonprofit, or government office
- An online-only brand with no physical retail
- A closed or defunct business
- A manufacturer, distributor, or wholesaler (not retail)
- A garden center, nursery, or landscaping company
- A technology/IT/software company

Score 3 if genuinely unclear from the name alone.

Respond with ONLY a JSON array, no other text:
[{"id":"xxx","score":4,"type":"boutique","reason":"Women's clothing and accessories"}]`;

async function classifyBatch(leads) {
  const leadsText = leads.map(l => 
    `${l.id}|${l.name}|${l.city || ''}|${l.state || ''}|${l.domain || ''}`
  ).join('\n');

  const body = {
    contents: [{
      parts: [{ text: `Classify these stores:\n\nid|name|city|state|domain\n${leadsText}` }]
    }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.status === 429) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        console.log(`  Rate limited, waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text.substring(0, 200)}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('No text in response');

      // Parse JSON (handle markdown wrapping)
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(jsonStr);
    } catch (e) {
      if (attempt === 2) {
        console.error(`  Failed after 3 attempts: ${e.message}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const db = new Database(DB_PATH);
  
  // Drop FTS triggers to avoid issues
  db.exec("DROP TRIGGER IF EXISTS companies_fts_insert;");
  db.exec("DROP TRIGGER IF EXISTS companies_fts_delete;");
  db.exec("DROP TRIGGER IF EXISTS companies_fts_update;");

  // Get all remaining "new" leads
  const leads = db.prepare(`
    SELECT id, name, city, state, domain, website 
    FROM companies 
    WHERE status = 'new' 
    ORDER BY name
  `).all();

  console.log(`Total leads to classify: ${leads.length}`);
  if (DRY_RUN) {
    console.log('DRY RUN — would classify', leads.length, 'leads');
    process.exit(0);
  }

  // Prepare update statements
  const qualifyStmt = db.prepare(`
    UPDATE companies SET 
      status = 'qualified', 
      icp_score = ?, 
      icp_reasoning = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);
  const dqStmt = db.prepare(`
    UPDATE companies SET 
      status = 'not_qualified', 
      icp_score = ?,
      disqualify_reason = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);
  const reviewStmt = db.prepare(`
    UPDATE companies SET 
      icp_score = 3,
      icp_reasoning = ?,
      tags = json_set(COALESCE(tags, '[]'), '$[#]', 'manual_review'),
      updated_at = datetime('now')
    WHERE id = ?
  `);

  // Process in batches
  const batches = [];
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    batches.push(leads.slice(i, i + BATCH_SIZE));
  }

  let processed = 0;
  let qualified = 0;
  let dqd = 0;
  let review = 0;
  let errors = 0;
  const startTime = Date.now();

  // Process with concurrency limit
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(batch => classifyBatch(batch)));

    for (let j = 0; j < results.length; j++) {
      const batchResults = results[j];
      const batch = chunk[j];

      if (!batchResults) {
        errors += batch.length;
        continue;
      }

      // Create lookup for results
      const resultMap = new Map();
      for (const r of batchResults) {
        resultMap.set(r.id, r);
      }

      // Apply results
      const txn = db.transaction(() => {
        for (const lead of batch) {
          const result = resultMap.get(lead.id);
          if (!result) {
            errors++;
            continue;
          }

          const reason = `AI Pass 6: ${result.type || 'unknown'} — ${result.reason || ''}`;

          if (result.score >= 4) {
            qualifyStmt.run(result.score, reason, lead.id);
            qualified++;
          } else if (result.score <= 2) {
            dqStmt.run(result.score, reason, lead.id);
            dqd++;
          } else {
            reviewStmt.run(reason, lead.id);
            review++;
          }
          processed++;
        }
      });
      txn();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct = ((processed / leads.length) * 100).toFixed(1);
    console.log(`[${elapsed}s] ${processed}/${leads.length} (${pct}%) — Q:${qualified} DQ:${dqd} Review:${review} Err:${errors}`);

    // Small delay between concurrent batches to avoid rate limits
    if (i + CONCURRENCY < batches.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Recreate FTS triggers and rebuild
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS companies_fts_insert AFTER INSERT ON companies BEGIN
      INSERT INTO companies_fts(rowid, name, city, state, website, domain, notes)
      VALUES (new.rowid, new.name, new.city, new.state, new.website, new.domain, new.notes);
    END;
    CREATE TRIGGER IF NOT EXISTS companies_fts_delete AFTER DELETE ON companies BEGIN
      INSERT INTO companies_fts(companies_fts, rowid, name, city, state, website, domain, notes)
      VALUES ('delete', old.rowid, old.name, old.city, old.state, old.website, old.domain, old.notes);
    END;
    CREATE TRIGGER IF NOT EXISTS companies_fts_update AFTER UPDATE ON companies BEGIN
      INSERT INTO companies_fts(companies_fts, rowid, name, city, state, website, domain, notes)
      VALUES ('delete', old.rowid, old.name, old.city, old.state, old.website, old.domain, old.notes);
      INSERT INTO companies_fts(rowid, name, city, state, website, domain, notes)
      VALUES (new.rowid, new.name, new.city, new.state, new.website, new.domain, new.notes);
    END;
    INSERT INTO companies_fts(companies_fts) VALUES('rebuild');
  `);

  // Final stats
  const stats = db.prepare("SELECT status, COUNT(*) as count FROM companies GROUP BY status ORDER BY count DESC").all();
  console.log('\n=== FINAL RESULTS ===');
  console.log(`Processed: ${processed}, Qualified: ${qualified}, DQ: ${dqd}, Review: ${review}, Errors: ${errors}`);
  console.log('\nStatus breakdown:');
  stats.forEach(s => console.log(`  ${s.status}: ${s.count}`));

  db.close();
}

main().catch(console.error);
