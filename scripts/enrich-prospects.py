#!/usr/bin/env python3
"""
Jaxy Prospect Website Enrichment Script

Scrapes prospect websites to extract:
- Email addresses (homepage + contact page)
- Phone numbers
- Social media links (Facebook, Instagram, Twitter/X, LinkedIn, Yelp, TikTok, Pinterest, YouTube)
- Contact form URL + form fields
- Website title + meta description
- CMS detection (Shopify, WordPress, Squarespace, Wix, BigCommerce, etc.)
- Domain status (live, redirect, dead, parked)
- Shopify product catalog: sells_sunglasses, sunglass_brands, product_types, product_count

Usage:
  # Test on 20 sites first
  python3 scripts/enrich-prospects.py --test --limit 20

  # Full run (27K+ sites, ~30 concurrent)
  python3 scripts/enrich-prospects.py --db /tmp/the-frame-live.db --concurrency 30

  # Resume after crash
  python3 scripts/enrich-prospects.py --db /tmp/the-frame-live.db --resume

  # Dry run (don't write to DB)
  python3 scripts/enrich-prospects.py --test --limit 20 --dry-run
"""

import asyncio
import aiohttp
import sqlite3
import re
import json
import argparse
import time
import sys
import os
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup
from datetime import datetime
from typing import Optional
import warnings
from bs4 import XMLParsedAsHTMLWarning
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

# ─── Config ───────────────────────────────────────────────────────────────
DEFAULT_CONCURRENCY = 30
REQUEST_TIMEOUT = 12  # seconds per request
MAX_PAGE_SIZE = 2_000_000  # 2MB max page download
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# ─── Patterns ─────────────────────────────────────────────────────────────
EMAIL_RE = re.compile(
    r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}',
    re.IGNORECASE
)
PHONE_RE = re.compile(
    r'(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}'
)
# Skip junk emails
EMAIL_BLACKLIST = {
    'sentry.io', 'ingest.us.sentry.io', 'ingest.sentry.io',
    'wixpress.com', 'example.com', 'email.com',
    'yourdomain.com', 'domain.com', 'yoursite.com', 'test.com',
    'placeholder.com', 'squarespace.com', 'shopify.com',
    'klaviyo.com', 'mailchimp.com', 'sendgrid.net',
}
EMAIL_BLACKLIST_PREFIXES = [
    'no-reply', 'noreply', 'donotreply', 'mailer-daemon',
    'postmaster', 'webmaster', 'hostmaster', 'admin@localhost',
]

# Social media patterns
SOCIAL_PATTERNS = {
    'facebook_url': [
        re.compile(r'https?://(?:www\.)?facebook\.com/[a-zA-Z0-9._\-]+/?', re.I),
        re.compile(r'https?://(?:www\.)?fb\.com/[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'instagram_url': [
        re.compile(r'https?://(?:www\.)?instagram\.com/[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'twitter_url': [
        re.compile(r'https?://(?:www\.)?(?:twitter\.com|x\.com)/[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'linkedin_url': [
        re.compile(r'https?://(?:www\.)?linkedin\.com/(?:company|in)/[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'yelp_url': [
        re.compile(r'https?://(?:www\.)?yelp\.com/biz/[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'tiktok_url': [
        re.compile(r'https?://(?:www\.)?tiktok\.com/@[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'pinterest_url': [
        re.compile(r'https?://(?:www\.)?pinterest\.com/[a-zA-Z0-9._\-]+/?', re.I),
    ],
    'youtube_url': [
        re.compile(r'https?://(?:www\.)?youtube\.com/(?:c/|channel/|@)[a-zA-Z0-9._\-]+/?', re.I),
    ],
}

# Contact page detection
CONTACT_KEYWORDS = [
    'contact', 'contact-us', 'contactus', 'get-in-touch',
    'reach-us', 'connect', 'about', 'about-us',
]

# CMS detection signatures
CMS_SIGNATURES = {
    'shopify': ['cdn.shopify.com', 'Shopify.theme', 'shopify-section', 'myshopify.com'],
    'wordpress': ['wp-content', 'wp-includes', 'wordpress', 'wp-json'],
    'squarespace': ['squarespace.com', 'sqsp.net', 'squarespace-cdn'],
    'wix': ['wixpress.com', 'wix.com', 'parastorage.com', 'wixstatic.com'],
    'bigcommerce': ['bigcommerce.com', 'cdn11.bigcommerce.com'],
    'webflow': ['webflow.com', 'assets.website-files.com'],
    'magento': ['mage/', 'Magento_', 'magento'],
    'weebly': ['weebly.com', 'editmysite.com'],
    'godaddy': ['godaddy.com', 'secureserver.net', 'wsimg.com'],
}

# Parked domain detection
PARKED_SIGNATURES = [
    'domain is for sale', 'buy this domain', 'parked free',
    'godaddy', 'hugedomains', 'dan.com', 'sedo.com',
    'this domain may be for sale', 'domain parking',
    'this webpage is not available', 'expired domain',
    'register this domain', 'afternic',
]


# ─── Helpers ──────────────────────────────────────────────────────────────

def clean_email(email: str) -> Optional[str]:
    """Validate and clean an email address."""
    email = email.lower().strip().rstrip('.')
    # Skip image filenames, CSS, etc.
    if any(email.endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js', '.webp']):
        return None
    domain = email.split('@')[-1]
    if domain in EMAIL_BLACKLIST:
        return None
    # Also check parent domains (e.g. x.ingest.us.sentry.io → sentry.io)
    parts = domain.split('.')
    for i in range(len(parts) - 1):
        parent = '.'.join(parts[i:])
        if parent in EMAIL_BLACKLIST:
            return None
    if any(email.startswith(p) for p in EMAIL_BLACKLIST_PREFIXES):
        return None
    if len(email) > 80 or len(email) < 6:
        return None
    return email


def clean_phone(phone: str) -> Optional[str]:
    """Clean and validate US phone number."""
    digits = re.sub(r'\D', '', phone)
    if len(digits) == 11 and digits[0] == '1':
        digits = digits[1:]
    if len(digits) != 10:
        return None
    area = int(digits[:3])
    # Valid US area codes: 2xx-9xx (first digit 2-9), second digit 0-9
    # But filter known invalid/toll-free/special
    if area < 200 or area > 999:
        return None
    if digits.startswith(('000', '111', '555')):
        return None
    # Skip toll-free
    if digits.startswith(('800', '888', '877', '866', '855', '844', '833')):
        return None
    # Skip clearly fake patterns
    if digits[3:6] in ('000', '555') or digits == '2147483645':
        return None
    # Skip numbers that look like tracking IDs / timestamps (area codes that don't exist)
    # Valid area codes have first digit 2-9
    if int(digits[0]) < 2:
        return None
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"


def normalize_url(url: str) -> str:
    """Ensure URL has scheme."""
    if not url:
        return ''
    url = url.strip()
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url
    return url


def detect_cms(html: str, url: str) -> Optional[str]:
    """Detect CMS from HTML source."""
    html_lower = html.lower()
    for cms, signatures in CMS_SIGNATURES.items():
        for sig in signatures:
            if sig.lower() in html_lower or sig.lower() in url.lower():
                return cms
    return None


def is_parked(html: str) -> bool:
    """Check if domain appears parked/for sale."""
    html_lower = html.lower()
    matches = sum(1 for sig in PARKED_SIGNATURES if sig in html_lower)
    return matches >= 2  # Need at least 2 signals


SOCIAL_BLACKLIST_PATHS = {
    # Meta Pixel / generic fragments
    '/tr', '/p', '/sharer', '/share', '/dialog', '/intent',
    '/login', '/signup', '/help', '/policies', '/about',
    '/settings', '/pages', '/watch',
}
SOCIAL_BLACKLIST_ACCOUNTS = {
    # Platform-owned / generic accounts
    'shopify', 'wordpress', 'squarespace', 'wix', 'weebly',
    'latimes', 'nytimes', 'google', 'youtube', 'meta',
}

def extract_socials(html: str, soup: BeautifulSoup) -> dict:
    """Extract social media URLs from page."""
    socials = {}
    # Only look at <a> tag hrefs — more reliable than raw HTML regex
    all_hrefs = [a.get('href', '') for a in soup.find_all('a', href=True)]
    href_text = '\n'.join(all_hrefs)
    
    for key, patterns in SOCIAL_PATTERNS.items():
        for pattern in patterns:
            matches = pattern.findall(href_text)
            if matches:
                for url in matches:
                    url = url.rstrip('/')
                    parsed = urlparse(url)
                    path = parsed.path.rstrip('/')
                    
                    # Skip share/tracking/generic URLs
                    if any(bp == path.lower() for bp in SOCIAL_BLACKLIST_PATHS):
                        continue
                    if 'share' in url.lower() or 'intent' in url.lower() or 'sharer' in url.lower():
                        continue
                    
                    # Skip platform-owned accounts
                    account = path.split('/')[-1].lower().lstrip('@')
                    if account in SOCIAL_BLACKLIST_ACCOUNTS:
                        continue
                    
                    # Must have a meaningful path (not just the domain)
                    if len(path.strip('/')) < 2:
                        continue
                    
                    socials[key] = url
                    break
            if key in socials:
                break
    return socials


def extract_form_info(soup: BeautifulSoup, page_url: str) -> Optional[dict]:
    """Extract contact form details."""
    forms = soup.find_all('form')
    for form in forms:
        # Skip search forms, login forms, newsletter forms
        form_html = str(form).lower()
        if any(skip in form_html for skip in ['search', 'login', 'signin', 'sign-in', 'password', 'newsletter', 'subscribe', 'mailchimp']):
            continue
        
        # Look for forms with message/comment/body fields (likely contact forms)
        fields = []
        for inp in form.find_all(['input', 'textarea', 'select']):
            field_type = inp.get('type', 'text')
            if field_type in ('hidden', 'submit', 'button', 'image'):
                continue
            name = inp.get('name', inp.get('id', ''))
            placeholder = inp.get('placeholder', '')
            label_text = ''
            # Try to find associated label
            field_id = inp.get('id')
            if field_id:
                label = soup.find('label', attrs={'for': field_id})
                if label:
                    label_text = label.get_text(strip=True)
            
            fields.append({
                'name': name,
                'type': field_type if inp.name != 'textarea' else 'textarea',
                'placeholder': placeholder,
                'label': label_text,
                'required': inp.get('required') is not None,
            })
        
        if len(fields) >= 2:  # At least 2 fields to be a real form
            action = form.get('action', '')
            if action and not action.startswith(('http', '/')):
                action = urljoin(page_url, action)
            elif action and action.startswith('/'):
                action = urljoin(page_url, action)
            
            # Check for embedded form services
            form_service = None
            if 'typeform.com' in form_html:
                form_service = 'typeform'
            elif 'jotform.com' in form_html:
                form_service = 'jotform'
            elif 'google.com/forms' in form_html:
                form_service = 'google_forms'
            elif 'hubspot' in form_html:
                form_service = 'hubspot'
            
            return {
                'url': page_url,
                'action': action,
                'method': form.get('method', 'POST').upper(),
                'fields': fields,
                'service': form_service,
            }
    
    # Also check for iframe-embedded forms
    for iframe in soup.find_all('iframe'):
        src = iframe.get('src', '')
        if any(svc in src for svc in ['typeform.com', 'jotform.com', 'google.com/forms', 'hubspot']):
            service = 'typeform' if 'typeform' in src else 'jotform' if 'jotform' in src else 'google_forms' if 'google' in src else 'hubspot'
            return {
                'url': page_url,
                'action': src,
                'method': 'IFRAME',
                'fields': [],
                'service': service,
            }
    
    return None


def extract_meta(soup: BeautifulSoup) -> dict:
    """Extract page title and meta description."""
    title = ''
    if soup.title and soup.title.string:
        title = soup.title.string.strip()[:200]
    
    desc = ''
    meta_desc = soup.find('meta', attrs={'name': re.compile(r'^description$', re.I)})
    if meta_desc:
        desc = (meta_desc.get('content', '') or '').strip()[:500]
    
    return {'title': title, 'meta_description': desc}


def find_contact_page_url(soup: BeautifulSoup, base_url: str) -> Optional[str]:
    """Find a contact page link on the site."""
    for a in soup.find_all('a', href=True):
        href = a['href'].lower().strip()
        text = a.get_text(strip=True).lower()
        
        # Check link text and href for contact keywords
        for keyword in CONTACT_KEYWORDS:
            if keyword in href or keyword in text:
                full_url = urljoin(base_url, a['href'])
                parsed = urlparse(full_url)
                base_parsed = urlparse(base_url)
                # Only follow links on same domain
                if parsed.netloc == base_parsed.netloc or not parsed.netloc:
                    return full_url
    return None


# ─── Main Enrichment ─────────────────────────────────────────────────────

async def fetch_page(session: aiohttp.ClientSession, url: str) -> tuple:
    """Fetch a page, return (final_url, html, status)."""
    try:
        async with session.get(
            url,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            allow_redirects=True,
            max_redirects=5,
            ssl=False,
        ) as resp:
            if resp.status >= 400:
                return (str(resp.url), '', resp.status)
            content_type = resp.headers.get('content-type', '')
            if 'text/html' not in content_type and 'application/xhtml' not in content_type:
                return (str(resp.url), '', resp.status)
            html = await resp.text(errors='replace')
            if len(html) > MAX_PAGE_SIZE:
                html = html[:MAX_PAGE_SIZE]
            return (str(resp.url), html, resp.status)
    except asyncio.TimeoutError:
        return (url, '', -1)
    except Exception as e:
        return (url, '', -2)


SUNGLASS_KEYWORDS = [
    'sunglass', 'sunglasses', 'eyewear', 'shades', 'aviator',
    'wayfarer', 'polarized lens', 'uv400', 'uv protection',
]
EYEWEAR_BRANDS = [
    'ray-ban', 'rayban', 'oakley', 'maui jim', 'costa', 'quay',
    'goodr', 'blenders', 'pit viper', 'knockaround', 'sunski',
    'prada', 'gucci', 'versace', 'tom ford', 'persol', 'carrera',
    'smith optics', 'spy optic', 'electric', 'vonzipper', 'dragon',
    'diff', 'krewe', 'warby parker', 'izipizi', 'le specs',
    'aj morgan', 'fossil', 'kate spade', 'coach', 'michael kors',
    'tory burch', 'jimmy choo', 'celine', 'fendi', 'dior',
    'dolce', 'burberry', 'armani', 'boss', 'lacoste',
    'nike vision', 'under armour', 'columbia', 'zeal', 'native',
    'julbo', 'kaenon', 'bolle', 'serengeti', 'revo', 'costa del mar',
]

async def scan_shopify_products(session: aiohttp.ClientSession, base_url: str) -> Optional[dict]:
    """Scan Shopify /products.json for sunglasses and catalog info."""
    url = f"{base_url.rstrip('/')}/products.json?limit=250"
    try:
        async with session.get(
            url,
            timeout=aiohttp.ClientTimeout(total=8),
            ssl=False,
        ) as resp:
            if resp.status != 200:
                return None
            ct = resp.headers.get('content-type', '')
            if 'json' not in ct:
                return None
            data = await resp.json(content_type=None)
    except Exception:
        return None
    
    products = data.get('products', [])
    if not products:
        return None
    
    product_types = set()
    vendors = set()
    sunglass_products = []
    sunglass_brands = set()
    
    for p in products:
        pt = (p.get('product_type') or '').strip()
        vendor = (p.get('vendor') or '').strip()
        title = (p.get('title') or '')
        tags = ' '.join(p.get('tags', [])) if isinstance(p.get('tags'), list) else (p.get('tags') or '')
        
        if pt:
            product_types.add(pt)
        if vendor:
            vendors.add(vendor)
        
        # Check if this product is sunglasses/eyewear
        all_text = f'{pt} {title} {tags}'.lower()
        is_sunglass = any(kw in all_text for kw in SUNGLASS_KEYWORDS)
        
        if is_sunglass:
            sunglass_products.append({
                'title': title,
                'vendor': vendor,
                'type': pt,
            })
            if vendor:
                sunglass_brands.add(vendor)
    
    # Also check if any known eyewear brands appear as vendors
    for vendor in vendors:
        if any(brand in vendor.lower() for brand in EYEWEAR_BRANDS):
            sunglass_brands.add(vendor)
    
    return {
        'product_count': len(products),
        'product_types': sorted(product_types)[:20],
        'top_vendors': sorted(vendors)[:20],
        'sells_sunglasses': len(sunglass_products) > 0,
        'sunglass_count': len(sunglass_products),
        'sunglass_brands': sorted(sunglass_brands),
        'sunglass_products': sunglass_products[:10],  # Sample
        'has_more_products': len(products) >= 250,
    }


async def enrich_one(session: aiohttp.ClientSession, company: dict) -> dict:
    """Enrich a single company by scraping its website."""
    result = {
        'id': company['id'],
        'emails': [],
        'phones': [],
        'socials': {},
        'contact_form': None,
        'meta': {},
        'cms': None,
        'domain_status': 'unknown',
        'contact_page_url': None,
        'shopify_catalog': None,
    }
    
    url = normalize_url(company['website'])
    if not url:
        result['domain_status'] = 'no_website'
        return result
    
    # ── Step 1: Fetch homepage ──
    final_url, html, status = await fetch_page(session, url)
    
    if status == -1:
        result['domain_status'] = 'timeout'
        return result
    if status == -2 or not html:
        result['domain_status'] = 'dead'
        return result
    if status >= 400:
        result['domain_status'] = f'error_{status}'
        return result
    
    # Check for redirect to different domain
    orig_domain = urlparse(url).netloc.replace('www.', '')
    final_domain = urlparse(final_url).netloc.replace('www.', '')
    if orig_domain != final_domain:
        result['domain_status'] = f'redirect:{final_domain}'
    else:
        result['domain_status'] = 'live'
    
    # Check if parked
    if is_parked(html):
        result['domain_status'] = 'parked'
        return result
    
    soup = BeautifulSoup(html, 'lxml')
    
    # Extract emails from full HTML (they appear in mailto: links, meta tags, etc.)
    result['emails'] = [e for e in (clean_email(e) for e in EMAIL_RE.findall(html)) if e]
    
    # Extract phones from visible text only (avoids JS tracking numbers)
    visible_text = soup.get_text(separator=' ')
    result['phones'] = [p for p in (clean_phone(p) for p in PHONE_RE.findall(visible_text)) if p]
    result['socials'] = extract_socials(html, soup)
    result['meta'] = extract_meta(soup)
    result['cms'] = detect_cms(html, final_url)
    
    # ── Step 2: If no email found, look for contact page ──
    if not result['emails']:
        contact_url = find_contact_page_url(soup, final_url)
        if contact_url:
            result['contact_page_url'] = contact_url
            _, contact_html, contact_status = await fetch_page(session, contact_url)
            
            if contact_html and contact_status < 400:
                contact_soup = BeautifulSoup(contact_html, 'lxml')
                
                # Extract emails and phones from contact page
                contact_emails = [e for e in (clean_email(e) for e in EMAIL_RE.findall(contact_html)) if e]
                contact_visible = contact_soup.get_text(separator=' ')
                contact_phones = [p for p in (clean_phone(p) for p in PHONE_RE.findall(contact_visible)) if p]
                result['emails'].extend(contact_emails)
                result['phones'].extend(contact_phones)
                
                # Merge socials from contact page
                contact_socials = extract_socials(contact_html, contact_soup)
                for key, val in contact_socials.items():
                    if key not in result['socials']:
                        result['socials'][key] = val
                
                # If still no email, check for contact form
                if not result['emails']:
                    result['contact_form'] = extract_form_info(contact_soup, contact_url)
    
    # ── Step 3: If Shopify, scan product catalog ──
    if result['cms'] == 'shopify':
        result['shopify_catalog'] = await scan_shopify_products(session, final_url)
    
    # Deduplicate
    result['emails'] = list(dict.fromkeys(result['emails']))[:5]  # Keep max 5
    result['phones'] = list(dict.fromkeys(result['phones']))[:3]
    
    return result


# ─── Database ─────────────────────────────────────────────────────────────

def get_prospects(db_path: str, limit: Optional[int] = None, resume: bool = False) -> list:
    """Get prospects with website but no email."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    
    query = """
        SELECT id, name, website, domain, email, phone
        FROM companies
        WHERE website IS NOT NULL AND website != ''
          AND (email IS NULL OR email = '')
          AND status != 'rejected'
    """
    if resume:
        query += " AND enrichment_status != 'enriched'"
    
    query += " ORDER BY google_rating DESC NULLS LAST, google_review_count DESC NULLS LAST"
    
    if limit:
        query += f" LIMIT {limit}"
    
    rows = conn.execute(query).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def ensure_columns(conn: sqlite3.Connection):
    """Add enrichment columns if they don't exist."""
    new_cols = [
        ('shopify_product_count', 'INTEGER'),
        ('sells_sunglasses', 'INTEGER DEFAULT 0'),
        ('sunglass_brands', 'TEXT'),
        ('product_types', 'TEXT'),
        ('shopify_data', 'TEXT'),
        ('page_title', 'TEXT'),
        ('meta_description', 'TEXT'),
        ('cms', 'TEXT'),
        ('domain_status', 'TEXT'),
    ]
    for col, col_type in new_cols:
        try:
            conn.execute(f"ALTER TABLE companies ADD COLUMN {col} {col_type}")
        except Exception:
            pass  # Column already exists


_columns_ensured = False

def save_results(db_path: str, results: list, dry_run: bool = False):
    """Save enrichment results to database."""
    if dry_run:
        return
    
    global _columns_ensured
    conn = sqlite3.connect(db_path)
    if not _columns_ensured:
        ensure_columns(conn)
        _columns_ensured = True
    
    for r in results:
        updates = {
            'enrichment_status': 'enriched',
            'enriched_at': datetime.utcnow().isoformat(),
            'enrichment_source': 'website_scrape',
        }
        
        # Email — save best one to company, rest to notes
        if r['emails']:
            updates['email'] = r['emails'][0]
        
        # Phone — save if not already set
        if r['phones']:
            updates['phone'] = r['phones'][0]
        
        # Socials
        for key in ['facebook_url', 'instagram_url', 'twitter_url', 'linkedin_url', 'yelp_url']:
            if key in r['socials']:
                updates[key] = r['socials'][key]
        
        # Additional socials as JSON
        extra_socials = {k: v for k, v in r['socials'].items() 
                        if k not in ['facebook_url', 'instagram_url', 'twitter_url', 'linkedin_url', 'yelp_url']}
        if extra_socials:
            updates['socials'] = json.dumps(extra_socials)
        
        # Contact form
        if r['contact_form']:
            updates['contact_form_url'] = r['contact_form']['url']
            # Store full form details in notes for now
            form_note = f"[Contact Form] {r['contact_form']['url']}"
            if r['contact_form'].get('service'):
                form_note += f" ({r['contact_form']['service']})"
            form_note += f"\nFields: {json.dumps(r['contact_form']['fields'])}"
            existing_notes = conn.execute(
                "SELECT notes FROM companies WHERE id = ?", (r['id'],)
            ).fetchone()
            existing = (existing_notes[0] or '') if existing_notes else ''
            updates['notes'] = f"{form_note}\n{existing}" if existing else form_note
        
        # Meta — dedicated columns
        if r['meta'].get('title'):
            updates['page_title'] = r['meta']['title'][:200]
        if r['meta'].get('meta_description'):
            updates['meta_description'] = r['meta']['meta_description'][:500]
        
        # CMS — dedicated column + category
        if r['cms']:
            updates['cms'] = r['cms']
            updates['category'] = r['cms']  # Keep category for backwards compat
        
        # Shopify catalog data
        if r.get('shopify_catalog'):
            cat = r['shopify_catalog']
            updates['shopify_product_count'] = cat['product_count']
            updates['sells_sunglasses'] = 1 if cat['sells_sunglasses'] else 0
            updates['sunglass_brands'] = json.dumps(cat['sunglass_brands']) if cat['sunglass_brands'] else None
            updates['product_types'] = json.dumps(cat['product_types']) if cat['product_types'] else None
            updates['shopify_data'] = json.dumps({
                'top_vendors': cat['top_vendors'],
                'sunglass_count': cat['sunglass_count'],
                'sunglass_products': cat['sunglass_products'],
                'has_more_products': cat['has_more_products'],
            })
        
        # Domain status
        updates['domain_status'] = r['domain_status'][:50]
        if r['domain_status'] in ('dead', 'parked', 'timeout'):
            updates['enrichment_status'] = 'failed'
        elif r['domain_status'].startswith('redirect:'):
            updates['domain'] = r['domain_status'].split(':')[1]
        
        # Build UPDATE query
        set_clauses = ', '.join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values()) + [r['id']]
        conn.execute(
            f"UPDATE companies SET {set_clauses}, updated_at = datetime('now') WHERE id = ?",
            values
        )
    
    conn.commit()
    conn.close()


# ─── Runner ───────────────────────────────────────────────────────────────

async def run_enrichment(
    db_path: str,
    limit: Optional[int] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    dry_run: bool = False,
    resume: bool = False,
    batch_size: int = 100,
):
    """Main enrichment loop."""
    prospects = get_prospects(db_path, limit=limit, resume=resume)
    total = len(prospects)
    
    if total == 0:
        print("No prospects to enrich.")
        return
    
    print(f"\n{'='*60}")
    print(f"  Jaxy Prospect Website Enrichment")
    print(f"  Prospects to process: {total:,}")
    print(f"  Concurrency: {concurrency}")
    print(f"  Dry run: {dry_run}")
    print(f"  Resume mode: {resume}")
    print(f"{'='*60}\n")
    
    # Stats
    stats = {
        'processed': 0, 'emails_found': 0, 'phones_found': 0,
        'socials_found': 0, 'forms_found': 0, 'cms_detected': 0,
        'shopify_stores': 0, 'sells_sunglasses': 0,
        'dead': 0, 'parked': 0, 'timeout': 0, 'live': 0,
        'errors': 0, 'start_time': time.time(),
    }
    
    connector = aiohttp.TCPConnector(limit=concurrency, ttl_dns_cache=300)
    
    async with aiohttp.ClientSession(
        connector=connector,
        headers={'User-Agent': USER_AGENT},
    ) as session:
        
        # Process in batches
        for batch_start in range(0, total, batch_size):
            batch = prospects[batch_start:batch_start + batch_size]
            
            # Create tasks for this batch
            semaphore = asyncio.Semaphore(concurrency)
            
            async def bounded_enrich(company):
                async with semaphore:
                    return await enrich_one(session, company)
            
            tasks = [bounded_enrich(p) for p in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Process results
            valid_results = []
            for i, r in enumerate(results):
                if isinstance(r, Exception):
                    stats['errors'] += 1
                    print(f"  ❌ {batch[i]['name']}: {str(r)[:60]}")
                    continue
                
                valid_results.append(r)
                stats['processed'] += 1
                
                if r['emails']:
                    stats['emails_found'] += 1
                if r['phones']:
                    stats['phones_found'] += 1
                if r['socials']:
                    stats['socials_found'] += 1
                if r['contact_form']:
                    stats['forms_found'] += 1
                if r['cms']:
                    stats['cms_detected'] += 1
                if r['cms'] == 'shopify':
                    stats['shopify_stores'] += 1
                if r.get('shopify_catalog') and r['shopify_catalog'].get('sells_sunglasses'):
                    stats['sells_sunglasses'] += 1
                
                ds = r['domain_status']
                if ds == 'live' or ds.startswith('redirect'):
                    stats['live'] += 1
                elif ds == 'dead':
                    stats['dead'] += 1
                elif ds == 'parked':
                    stats['parked'] += 1
                elif ds == 'timeout':
                    stats['timeout'] += 1
            
            # Save batch to DB
            save_results(db_path, valid_results, dry_run=dry_run)
            
            # Progress report
            done = batch_start + len(batch)
            elapsed = time.time() - stats['start_time']
            rate = stats['processed'] / elapsed if elapsed > 0 else 0
            eta = (total - done) / rate / 60 if rate > 0 else 0
            
            print(
                f"  [{done:>6,}/{total:,}] "
                f"📧 {stats['emails_found']:,} emails  "
                f"📱 {stats['phones_found']:,} phones  "
                f"🔗 {stats['socials_found']:,} socials  "
                f"🕶️ {stats['sells_sunglasses']:,} sell sunglasses  "
                f"📝 {stats['forms_found']:,} forms  "
                f"🏷️ {stats['cms_detected']:,} CMS  "
                f"| ⚡ {rate:.1f}/s  "
                f"⏱️ ~{eta:.0f}m left"
            )
    
    # Final summary
    elapsed = time.time() - stats['start_time']
    print(f"\n{'='*60}")
    print(f"  ENRICHMENT COMPLETE")
    print(f"  Time: {elapsed/60:.1f} minutes")
    print(f"  Processed: {stats['processed']:,}")
    print(f"  Emails found: {stats['emails_found']:,} ({stats['emails_found']/max(stats['processed'],1)*100:.1f}%)")
    print(f"  Phones found: {stats['phones_found']:,}")
    print(f"  Social links: {stats['socials_found']:,}")
    print(f"  Contact forms: {stats['forms_found']:,}")
    print(f"  CMS detected: {stats['cms_detected']:,}")
    print(f"  Shopify stores: {stats['shopify_stores']:,}")
    print(f"  🕶️ Sell sunglasses: {stats['sells_sunglasses']:,}")
    print(f"  Domain status: {stats['live']:,} live, {stats['dead']:,} dead, {stats['parked']:,} parked, {stats['timeout']:,} timeout")
    print(f"  Errors: {stats['errors']:,}")
    print(f"{'='*60}\n")
    
    return stats


# ─── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Enrich Jaxy prospects by scraping websites')
    parser.add_argument('--db', default='/tmp/the-frame-live.db', help='Path to SQLite database')
    parser.add_argument('--limit', type=int, help='Max prospects to process')
    parser.add_argument('--concurrency', type=int, default=DEFAULT_CONCURRENCY, help='Max concurrent requests')
    parser.add_argument('--test', action='store_true', help='Test mode (20 sites, verbose)')
    parser.add_argument('--dry-run', action='store_true', help='Do not write to database')
    parser.add_argument('--resume', action='store_true', help='Skip already enriched prospects')
    parser.add_argument('--batch-size', type=int, default=100, help='DB write batch size')
    parser.add_argument('--verbose', action='store_true', help='Print details for each prospect')
    args = parser.parse_args()
    
    if args.test:
        args.limit = args.limit or 20
        args.verbose = True
        print("🧪 TEST MODE — processing", args.limit, "sites")
    
    if not os.path.exists(args.db):
        print(f"❌ Database not found: {args.db}")
        print(f"   Pull it first: cd ~/the-frame && railway ssh -- base64 /data/the-frame.db | base64 -d > {args.db}")
        sys.exit(1)
    
    # Run with verbose output in test mode
    if args.verbose:
        orig_enrich = enrich_one
        
        async def verbose_enrich(session, company):
            result = await orig_enrich(session, company)
            status_icon = {
                'live': '🟢', 'dead': '🔴', 'parked': '🟡',
                'timeout': '⏱️', 'no_website': '❌',
            }.get(result['domain_status'].split(':')[0], '🔵')
            
            print(f"\n  {status_icon} {company['name']}")
            print(f"     URL: {company['website']}")
            print(f"     Status: {result['domain_status']}")
            if result['meta'].get('title'):
                print(f"     Title: {result['meta']['title'][:60]}")
            if result['cms']:
                print(f"     CMS: {result['cms']}")
            if result['emails']:
                print(f"     📧 Emails: {', '.join(result['emails'])}")
            if result['phones']:
                print(f"     📱 Phones: {', '.join(result['phones'])}")
            if result['socials']:
                for k, v in result['socials'].items():
                    print(f"     🔗 {k}: {v}")
            if result['contact_form']:
                svc = result['contact_form'].get('service', '')
                fields = [f['name'] or f['placeholder'] for f in result['contact_form'].get('fields', [])]
                print(f"     📝 Form: {result['contact_form']['url']}")
                if svc:
                    print(f"        Service: {svc}")
                if fields:
                    print(f"        Fields: {', '.join(fields)}")
            if result.get('shopify_catalog'):
                cat = result['shopify_catalog']
                print(f"     🛍️ Shopify: {cat['product_count']} products, {len(cat['product_types'])} types")
                if cat['sells_sunglasses']:
                    print(f"     🕶️ SELLS SUNGLASSES! {cat['sunglass_count']} products")
                    if cat['sunglass_brands']:
                        print(f"     🏷️ Brands: {', '.join(cat['sunglass_brands'])}")
            if not result['emails'] and not result['contact_form'] and result['domain_status'] == 'live':
                print(f"     ⚠️  No email or form found")
            
            return result
        
        # Monkey-patch for verbose mode
        import types
        globals()['enrich_one'] = verbose_enrich
    
    stats = asyncio.run(run_enrichment(
        db_path=args.db,
        limit=args.limit,
        concurrency=args.concurrency,
        dry_run=args.dry_run,
        resume=args.resume,
        batch_size=args.batch_size,
    ))


if __name__ == '__main__':
    main()
