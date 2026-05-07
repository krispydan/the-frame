#!/usr/bin/env python3
import re, sqlite3
DB='/tmp/the-frame-live.db'
conn=sqlite3.connect(DB)
conn.row_factory=sqlite3.Row
rows=conn.execute("SELECT id,name,description FROM catalog_products WHERE description IS NOT NULL AND (description LIKE '%$%' OR description LIKE '%retail%' OR description LIKE '%wholesale%' OR description LIKE '%dollar%')").fetchall()
patterns=[
    r'\s*At (?:just )?\$\d+[\d.,]*(?:,?[^.<]*)?\.',
    r'\s*At a smart price (?:of )?\$\d+[\d.,]*(?:,?[^.<]*)?\.',
    r'\s*At a smart price under \$\d+[\d.,]*(?:,?[^.<]*)?\.',
    r'\s*At \$\d+[\d.,]*(?:,?[^.<]*)?\.',
    r'\s*At just \$\d+[\d.,]*(?:,?[^.<]*)?\.',
    r'\s*At a smart price(?:[^.<]*)?\.',
    r'\s*without breaking the bank\.?',
    r'\s*without the guilt\.?',
    r'\s*your face \(and wallet\) will thank you for\.?',
]
updated=[]
for row in rows:
    desc=row['description']
    new=desc
    for p in patterns:
        new=re.sub(p,'',new,flags=re.I)
    new=re.sub(r'\s+</p>','</p>',new)
    new=re.sub(r'\s{2,}',' ',new)
    new=re.sub(r'</p>\s*<p>','</p>\n\n<p>',new)
    new=new.strip()
    if new!=desc:
        conn.execute("UPDATE catalog_products SET description=?, updated_at=datetime('now') WHERE id=?", (new,row['id']))
        updated.append(row['name'])
conn.commit()
print(f'Updated {len(updated)} products')
for name in updated:
    print(name)
