-- Lead Triage Pipeline: Passes 1-5
-- Run against the-frame.db on Railway
-- Every update includes disqualify_reason for traceability

-- ============================================
-- PASS 1: KEYWORD DQ (~3,500 expected)
-- ============================================

-- New keywords (expanding existing 46)
UPDATE companies SET 
  status = 'not_qualified',
  disqualify_reason = 'Auto-DQ Pass 1: keyword match in name',
  updated_at = datetime('now')
WHERE status = 'new' AND (
  -- Home services / trades
  lower(name) LIKE '%plumbing%' OR lower(name) LIKE '%plumber%'
  OR lower(name) LIKE '%hvac%' OR lower(name) LIKE '%roofing%' OR lower(name) LIKE '%roofer%'
  OR lower(name) LIKE '%electrician%' OR lower(name) LIKE '%electrical contractor%'
  OR lower(name) LIKE '%fencing%' OR lower(name) LIKE '%landscape%' OR lower(name) LIKE '%landscaping%'
  OR lower(name) LIKE '%pest control%' OR lower(name) LIKE '%exterminator%'
  OR lower(name) LIKE '%pool service%' OR lower(name) LIKE '%carpet%' OR lower(name) LIKE '%flooring%'
  OR lower(name) LIKE '%garage door%' OR lower(name) LIKE '%gutter%' OR lower(name) LIKE '%insulation%'
  OR lower(name) LIKE '%septic%' OR lower(name) LIKE '%foundation repair%'
  -- Automotive (expanded)
  OR lower(name) LIKE '%auto parts%' OR lower(name) LIKE '%automotive%'
  OR lower(name) LIKE '%tire %' OR lower(name) LIKE '% tire' OR lower(name) LIKE '%tires%'
  OR lower(name) LIKE '%4x4%' OR lower(name) LIKE '% rv %' OR lower(name) LIKE '%offroad%' OR lower(name) LIKE '%off-road%'
  OR lower(name) LIKE '%muffler%' OR lower(name) LIKE '%transmission%' OR lower(name) LIKE '%collision%'
  OR lower(name) LIKE '%body shop%' OR lower(name) LIKE '%windshield%' OR lower(name) LIKE '%tow %'
  OR lower(name) LIKE '%towing%' OR lower(name) LIKE '%tint %' OR lower(name) LIKE '%window tint%'
  -- Industrial / commercial
  OR lower(name) LIKE '%lumber%' OR lower(name) LIKE '%welding%' OR lower(name) LIKE '%weld %'
  OR lower(name) LIKE '%tool supply%' OR lower(name) LIKE '%industrial%' OR lower(name) LIKE '%warehouse%'
  OR lower(name) LIKE '%forklift%' OR lower(name) LIKE '%crane %' OR lower(name) LIKE '%generator%'
  OR lower(name) LIKE '%compressor%' OR lower(name) LIKE '%janitorial%' OR lower(name) LIKE '%safety supply%'
  -- Food service
  OR lower(name) LIKE '%restaurant%' OR lower(name) LIKE '%bar & grill%' OR lower(name) LIKE '%bar and grill%'
  OR lower(name) LIKE '%pizzeria%' OR lower(name) LIKE '%pizza %' OR lower(name) LIKE '% pizza'
  OR lower(name) LIKE '% deli%' OR lower(name) LIKE '%deli %'
  OR lower(name) LIKE '%taco %' OR lower(name) LIKE '%taco%' OR lower(name) LIKE '%burger%'
  OR lower(name) LIKE '%sushi%' OR lower(name) LIKE '%bakery%' OR lower(name) LIKE '%catering%'
  OR lower(name) LIKE '%frozen yogurt%' OR lower(name) LIKE '%donut%' OR lower(name) LIKE '%doughnut%'
  OR lower(name) LIKE '%bagel%' OR lower(name) LIKE '%brewpub%' OR lower(name) LIKE '%brewery%'
  OR lower(name) LIKE '%distillery%'
  -- Personal services (expanded)
  OR lower(name) LIKE '%nail %' OR lower(name) LIKE '% nail' OR lower(name) LIKE '%nails %'
  OR lower(name) LIKE '%lash %' OR lower(name) LIKE '% lash' OR lower(name) LIKE '%lashes%'
  OR lower(name) LIKE '%brow %' OR lower(name) LIKE '% brow' OR lower(name) LIKE '%brows%'
  OR lower(name) LIKE '%tanning%' OR lower(name) LIKE '%chiropractic%' OR lower(name) LIKE '%chiropractor%'
  OR lower(name) LIKE '%physical therapy%' OR lower(name) LIKE '%dermatolog%'
  OR lower(name) LIKE '%orthodont%' OR lower(name) LIKE '%pediatric%'
  OR lower(name) LIKE '%urgent care%' OR lower(name) LIKE '%med spa%'
  -- Professional services
  OR lower(name) LIKE '%insurance%' OR lower(name) LIKE '%real estate%'
  OR lower(name) LIKE '%accounting%' OR lower(name) LIKE '%accountant%'
  OR lower(name) LIKE '%attorney%' OR lower(name) LIKE '%law office%' OR lower(name) LIKE '%lawyer%'
  OR lower(name) LIKE '%notary%' OR lower(name) LIKE '%tax prep%'
  OR lower(name) LIKE '%staffing%' OR lower(name) LIKE '%recruiting%'
  -- Childcare / education
  OR lower(name) LIKE '%daycare%' OR lower(name) LIKE '%day care%'
  OR lower(name) LIKE '%preschool%' OR lower(name) LIKE '%pre-school%'
  OR lower(name) LIKE '%montessori%' OR lower(name) LIKE '%tutoring%' OR lower(name) LIKE '%learning center%'
  -- Other irrelevant
  OR lower(name) LIKE '%storage %' OR lower(name) LIKE '% storage'
  OR lower(name) LIKE '%moving %' OR lower(name) LIKE '% movers%'
  OR lower(name) LIKE '%printing%' OR lower(name) LIKE '%trophy%'
  OR lower(name) LIKE '%embroidery%' OR lower(name) LIKE '%alterations%'
  OR lower(name) LIKE '%tailor%' OR lower(name) LIKE '%dry clean%'
  OR lower(name) LIKE '%laundry%' OR lower(name) LIKE '%cleaners%'
  OR lower(name) LIKE '%pawn%' OR lower(name) LIKE '%funeral%' OR lower(name) LIKE '%cemetery%'
  OR lower(name) LIKE '%mortuary%' OR lower(name) LIKE '%ministry%'
  OR lower(name) LIKE '%locksmith%' OR lower(name) LIKE '%vacuum%'
  OR lower(name) LIKE '%watch repair%' OR lower(name) LIKE '%coin op%'
  OR lower(name) LIKE '%u-haul%' OR lower(name) LIKE '%mattress%' OR lower(name) LIKE '%rent-a%'
  OR lower(name) LIKE '%kennel%' OR lower(name) LIKE '%grooming%'
  -- Service-only patterns
  OR (lower(name) LIKE '%lessons%' AND lower(name) NOT LIKE '%shop%')
  OR (lower(name) LIKE '%school%' AND lower(name) NOT LIKE '%bookstore%' AND lower(name) NOT LIKE '%book school%' AND lower(name) NOT LIKE '%old school%')
  OR (lower(name) LIKE '%repair%' AND lower(name) NOT LIKE '%shop%' AND lower(name) NOT LIKE '%store%')
  OR lower(name) LIKE '%tour operator%' OR lower(name) LIKE '%tours %'
  OR (lower(name) LIKE '%rentals%' AND lower(name) NOT LIKE '%shop%')
  OR lower(name) LIKE '%classes%' OR lower(name) LIKE '%instruction%'
  OR lower(name) LIKE '%training academy%'
);

-- ============================================
-- PASS 2: CHAIN / FRANCHISE DQ (~2,800 expected)
-- ============================================

-- DQ big box and franchise chains (>5 locations, central buying)
-- Using exact name prefix matching
UPDATE companies SET 
  status = 'not_qualified',
  disqualify_reason = 'Auto-DQ Pass 2: franchise/chain (>5 locations, central buying)',
  updated_at = datetime('now')
WHERE status = 'new' AND (
  -- Department stores
  lower(name) LIKE 'nordstrom%' OR lower(name) LIKE 'macy''s%' OR lower(name) LIKE 'macys%'
  OR lower(name) LIKE 'dillard''s%' OR lower(name) LIKE 'dillards%'
  OR lower(name) LIKE 'belk%' OR lower(name) LIKE 'neiman marcus%'
  OR lower(name) LIKE 'bloomingdale%' OR lower(name) LIKE 'saks%'
  OR lower(name) LIKE 'von maur%' OR lower(name) LIKE 'david jones%'
  OR lower(name) LIKE 'jcpenney%' OR lower(name) LIKE 'j.c. penney%'
  OR lower(name) LIKE 'kohl''s%' OR lower(name) LIKE 'kohls%'
  -- Big box retail
  OR lower(name) LIKE 'rei %' OR lower(name) = 'rei'
  OR lower(name) LIKE 'target %' OR lower(name) = 'target'
  OR lower(name) LIKE 'walmart%' OR lower(name) LIKE 'wal-mart%'
  OR lower(name) LIKE 'costco%' OR lower(name) LIKE 'sam''s club%'
  OR lower(name) LIKE 'scheels%' OR lower(name) LIKE 'zumiez%'
  OR lower(name) LIKE 'tillys%' OR lower(name) LIKE 'tilly''s%'
  -- Specialty chains (wrong category)
  OR lower(name) LIKE 'bluemercury%' OR lower(name) LIKE 'fleet feet%'
  OR lower(name) LIKE 'dover saddlery%' OR lower(name) LIKE 'calico corners%'
  OR lower(name) LIKE 'fuzz wax%' OR lower(name) LIKE 'romantix%'
  OR lower(name) LIKE 'cindies%' OR lower(name) LIKE 'galls%'
  OR lower(name) LIKE 'piggly wiggly%' OR lower(name) LIKE 'gelsons%' OR lower(name) LIKE 'gelson''s%'
  OR lower(name) LIKE 'total wine%' OR lower(name) LIKE 'dunnes stores%'
  -- Commercial / industrial chains
  OR lower(name) LIKE 'ferguson home%' OR lower(name) LIKE 'adi %' OR lower(name) = 'adi'
  OR lower(name) LIKE 'general parts group%' OR lower(name) LIKE 'composites one%'
  OR lower(name) LIKE 'banner solutions%' OR lower(name) LIKE 'bumper to bumper%'
  OR lower(name) LIKE 'installer%' OR lower(name) LIKE 'csc %' OR lower(name) = 'csc'
  OR lower(name) LIKE 'tech 24%' OR lower(name) LIKE 'decks & docks%'
  OR lower(name) LIKE 'high tech garden%'
  -- Grocery chains
  OR lower(name) LIKE 'h-e-b%' OR lower(name) LIKE 'kroger%'
  OR lower(name) LIKE 'publix%' OR lower(name) LIKE 'whole foods%'
  OR lower(name) LIKE 'trader joe%' OR lower(name) LIKE 'aldi%'
  -- Other chains
  OR lower(name) LIKE 'good feet%' OR lower(name) LIKE 'pinch-a-penny%'
  OR lower(name) LIKE 'first choice liquor%' OR lower(name) LIKE 'buc-ee%'
  OR lower(name) LIKE 'camping world%' OR lower(name) LIKE 'cycle gear%'
  OR lower(name) LIKE 'west marine%' OR lower(name) LIKE 'bass pro%'
  OR lower(name) LIKE 'cabela%' OR lower(name) LIKE 'academy sports%'
  OR lower(name) LIKE 'dick''s sporting%' OR lower(name) LIKE 'big 5 sporting%'
  -- Barnes & Noble operated stores
  OR lower(name) LIKE '%barnes & noble%' OR lower(name) LIKE '%barnes and noble%'
  -- Generic "Dealer" or "Installer" entries
  OR lower(name) LIKE 'dealer%'
);

-- ============================================
-- PASS 3: BRAND SIGNAL SCORING
-- ============================================

-- 3a: Auto-qualify stores linked to relevant brands
UPDATE companies SET
  status = 'qualified',
  icp_reasoning = 'Auto-qualified Pass 3: linked to relevant brand(s)',
  updated_at = datetime('now')
WHERE status = 'new' AND id IN (
  SELECT DISTINCT cbl.company_id
  FROM company_brand_links cbl
  JOIN brand_accounts ba ON ba.id = cbl.brand_account_id
  WHERE ba.relevance = 'relevant'
);

-- 3b: DQ stores linked ONLY to irrelevant brands (no relevant links)
UPDATE companies SET
  status = 'not_qualified',
  disqualify_reason = 'Auto-DQ Pass 3: only linked to irrelevant brand(s)',
  updated_at = datetime('now')
WHERE status = 'new' AND id IN (
  SELECT DISTINCT cbl.company_id
  FROM company_brand_links cbl
  JOIN brand_accounts ba ON ba.id = cbl.brand_account_id
  WHERE ba.relevance = 'irrelevant'
) AND id NOT IN (
  SELECT DISTINCT cbl.company_id
  FROM company_brand_links cbl
  JOIN brand_accounts ba ON ba.id = cbl.brand_account_id
  WHERE ba.relevance = 'relevant'
);

-- ============================================
-- PASS 4: POSITIVE KEYWORD QUALIFICATION
-- ============================================

UPDATE companies SET
  status = 'qualified',
  icp_reasoning = 'Auto-qualified Pass 4: positive keyword match in name',
  updated_at = datetime('now')
WHERE status = 'new' AND (
  -- Tier A: Highest confidence
  lower(name) LIKE '%boutique%'
  OR lower(name) LIKE '%optical%' OR lower(name) LIKE '%optician%'
  OR lower(name) LIKE '%eyewear%' OR lower(name) LIKE '%sunglass%'
  OR lower(name) LIKE '%eye care%' OR lower(name) LIKE '%vision center%'
  -- Tier B: Strong signal
  OR lower(name) LIKE '%gift shop%' OR lower(name) LIKE '%gift store%' OR lower(name) LIKE '%gift shoppe%'
  OR lower(name) LIKE '%gifts%'
  OR lower(name) LIKE '%pharmacy%' OR lower(name) LIKE '%drugstore%' OR lower(name) LIKE '%drug store%'
  OR lower(name) LIKE '%apothecary%'
  OR lower(name) LIKE '%bookstore%' OR lower(name) LIKE '%book shop%' OR lower(name) LIKE '%bookseller%'
  -- Tier C: Good signal
  OR (lower(name) LIKE '%surf%' AND lower(name) NOT LIKE '%surface%' AND lower(name) NOT LIKE '%lessons%' AND lower(name) NOT LIKE '%school%' AND lower(name) NOT LIKE '%camp%')
  OR lower(name) LIKE '%board shop%' OR lower(name) LIKE '%boardshop%'
  OR lower(name) LIKE '%beach shop%' OR lower(name) LIKE '%beach house%' OR lower(name) LIKE '%beach store%'
  OR lower(name) LIKE '%museum shop%' OR lower(name) LIKE '%museum store%'
  OR (lower(name) LIKE '%museum%' AND lower(name) NOT LIKE '%wax museum%')
  OR (lower(name) LIKE '%vintage%' AND lower(name) NOT LIKE '%vintage car%' AND lower(name) NOT LIKE '%vintage wine%')
  OR lower(name) LIKE '%thrift%' OR lower(name) LIKE '%consignment%'
  OR lower(name) LIKE '%mercantile%' OR lower(name) LIKE '%general store%' OR lower(name) LIKE '%trading post%'
  OR lower(name) LIKE '%outfitter%'
  OR (lower(name) LIKE '%ski %' OR lower(name) LIKE '%ski &%' OR lower(name) LIKE '% ski')
  OR lower(name) LIKE '%snowboard%'
  OR lower(name) LIKE '%resort shop%' OR lower(name) LIKE '%resort store%'
  OR lower(name) LIKE '%hotel shop%' OR lower(name) LIKE '%hotel store%'
  OR lower(name) LIKE '%souvenir%' OR lower(name) LIKE '%tourist%'
  OR lower(name) LIKE '%car wash%'
  OR lower(name) LIKE '%skate shop%' OR lower(name) LIKE '%skate %'
  OR lower(name) LIKE '%record store%' OR lower(name) LIKE '%record shop%' OR lower(name) LIKE '%vinyl%'
  -- Tier D: Moderate (still qualify from name alone)
  OR lower(name) LIKE '%emporium%' OR lower(name) LIKE '%haberdash%'
  OR lower(name) LIKE '%dry goods%' OR lower(name) LIKE '%five and dime%'
  OR lower(name) LIKE '%variety store%'
);

-- ============================================
-- PASS 5: DEAD DATA DQ
-- ============================================

UPDATE companies SET
  status = 'not_qualified',
  disqualify_reason = 'Auto-DQ Pass 5: no state, no website, no email — uncontactable',
  updated_at = datetime('now')
WHERE status = 'new'
  AND (state IS NULL OR state = '')
  AND (website IS NULL OR website = '')
  AND (email IS NULL OR email = '');
