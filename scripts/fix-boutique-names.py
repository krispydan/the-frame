#!/usr/bin/env python3
"""
Generate company-name corrections for the 8,547 boutique-cohort leads
queued for Instantly. Reads /tmp/boutique-names.json and writes
/tmp/boutique-name-fixes.json with an array of {id, before, after, reason}.

Each rule is conservative — only fixes clear problems (URL-as-name,
emoji, wrapped/leading punctuation). Legitimate fashion branding
(ALL CAPS, lowercase brand names) is left alone.
"""
import json, re, sys

names = json.load(open('/tmp/boutique-names.json'))

TLD_RE = re.compile(r'\.(com|shop|co|net|store|us|io|nyc|biz|info|myshopify\.com)$', re.IGNORECASE)
EMOJI_RE = re.compile(r'[\U00002300-\U0001FFFF‍]', re.UNICODE)

def strip_url(s: str) -> str:
    """Strip http(s)://, www., trailing TLD. Returns the bare slug."""
    s = re.sub(r'^https?://', '', s, flags=re.IGNORECASE)
    s = re.sub(r'^www\.', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\.myshopify\.com$', '', s, flags=re.IGNORECASE)
    s = TLD_RE.sub('', s)
    return s.strip(' /')

def prettify(slug: str) -> str:
    """Turn a domain-slug into a brand name.
    e.g. '1008stores' → '1008stores' (numbers ok)
         'almontecollection' → 'Almonte Collection' (camel-split)
         'adeptt' → 'Adeptt'
         '22-shades-of-gray' → '22 Shades Of Gray'
    """
    s = slug.replace('-', ' ').replace('_', ' ')
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', s)
    s = re.sub(r'\s+', ' ', s).strip()
    if not s: return s
    # Title-case only when needed (preserve all-caps brand styling)
    if s == s.lower() or s == s.upper():
        s = s.title()
    return s

def fix_one(entry):
    name = (entry.get('name') or '').strip()
    domain = (entry.get('domain') or '').strip()
    if not name: return None
    orig = name
    reasons = []

    # 1a. Strip wrapping markers (markdown-style emphasis around a token)
    #     Handles *Sisters* Clothing Collective → Sisters Clothing Collective
    for ch in '*_~':
        if name.count(ch) >= 2:
            name = name.replace(ch, '')
            reasons.append(f'strip-{ch}-wrapping')
            break
    name = name.strip()

    # 2. Pipe split: "Brand | URL" → "Brand"
    if '|' in name:
        left = name.split('|')[0].strip()
        if left and not left.lower().startswith(('www.', 'http')):
            name = left
            reasons.append('pipe-left')

    # 3. Leading garbage chars
    while name and name[0] in "'*-._,~`":
        name = name[1:].strip()
        reasons.append('strip-leading')
    while name and name[-1] in ",;:|~`":
        name = name[:-1].strip()
        reasons.append('strip-trailing')

    # 4a. Strip embedded ".myshopify" (SLD) — must come before TLD strip
    pre = name
    name = re.sub(r'\.myshopify(\.com)?', '', name, flags=re.IGNORECASE)
    if name != pre: reasons.append('strip-myshopify')

    # 4b. Strip embedded ".com" / ".net" etc. inside the name
    #     "4 modesty.com – 4MODESTY.COM" → "4 modesty – 4MODESTY"
    pre = name
    name = re.sub(r'\.(com|shop|net|store|us|io|co)\b', '', name, flags=re.IGNORECASE)
    if name != pre: reasons.append('strip-embedded-tld')

    # 4b. URL-as-name (whole name reads as a URL)
    looks_like_url = (
        name.lower().startswith(('http://', 'https://', 'www.'))
        or TLD_RE.search(name)
        or '.myshopify.com' in name.lower()
    )
    if looks_like_url:
        bare = strip_url(name)
        if bare:
            name = prettify(bare)
            reasons.append('url-to-name')

    # 5. Strip emoji
    if EMOJI_RE.search(name):
        no_emoji = EMOJI_RE.sub('', name).strip()
        no_emoji = re.sub(r'\s+', ' ', no_emoji)
        if no_emoji:
            name = no_emoji
            reasons.append('strip-emoji')

    # 6. Collapse internal whitespace
    name = re.sub(r'\s+', ' ', name).strip()

    # Fallback: name became empty — derive from domain
    if not name and domain:
        name = prettify(strip_url(domain))
        reasons.append('derived-from-domain')

    if not name or name == orig: return None
    return {'id': entry['id'], 'before': orig, 'after': name, 'reasons': reasons}

fixes = []
for entry in names:
    f = fix_one(entry)
    if f: fixes.append(f)

# Group by reason for summary
from collections import Counter
reason_counts = Counter()
for f in fixes:
    for r in f['reasons']:
        reason_counts[r] += 1

print(f"Total names scanned: {len(names)}")
print(f"Total fixes proposed: {len(fixes)}")
print()
print("Fix reasons:")
for r, n in reason_counts.most_common():
    print(f"  {r}: {n}")

print()
print("Sample fixes (first 30):")
for f in fixes[:30]:
    print(f"  {f['before']!r:50}  →  {f['after']!r:40}  [{', '.join(f['reasons'])}]")

# Write output
with open('/tmp/boutique-name-fixes.json', 'w') as out:
    json.dump(fixes, out, indent=2)
print(f"\n✓ Wrote /tmp/boutique-name-fixes.json")
