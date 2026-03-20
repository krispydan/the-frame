import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "the-frame.db");
const db = new Database(DB_PATH);

// Create FTS5 virtual table for companies search (content-synced per CTO review)
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS companies_fts USING fts5(
    name, city, state, website, domain, notes,
    content='companies',
    content_rowid='rowid'
  );
`);

// Create triggers for auto-sync
db.exec(`
  CREATE TRIGGER IF NOT EXISTS companies_fts_insert AFTER INSERT ON companies BEGIN
    INSERT INTO companies_fts(rowid, name, city, state, website, domain, notes)
    VALUES (new.rowid, new.name, new.city, new.state, new.website, new.domain, new.notes);
  END;
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS companies_fts_delete AFTER DELETE ON companies BEGIN
    INSERT INTO companies_fts(companies_fts, rowid, name, city, state, website, domain, notes)
    VALUES ('delete', old.rowid, old.name, old.city, old.state, old.website, old.domain, old.notes);
  END;
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS companies_fts_update AFTER UPDATE ON companies BEGIN
    INSERT INTO companies_fts(companies_fts, rowid, name, city, state, website, domain, notes)
    VALUES ('delete', old.rowid, old.name, old.city, old.state, old.website, old.domain, old.notes);
    INSERT INTO companies_fts(rowid, name, city, state, website, domain, notes)
    VALUES (new.rowid, new.name, new.city, new.state, new.website, new.domain, new.notes);
  END;
`);

console.log("✅ FTS5 virtual table and triggers created");
db.close();
