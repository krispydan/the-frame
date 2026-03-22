export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import bcrypt from "bcryptjs";
import crypto from "crypto";

function uid() { return crypto.randomUUID(); }
function days(n: number) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); }
function daysAgo(n: number) { return days(-n); }

export async function POST() {
  try {
    // Idempotent: clear all data and reseed
    const tables = [
      'account_health_history', 'customer_accounts', 'deal_activities', 'deals',
      'contacts', 'stores', 'campaign_leads', 'campaigns', 'smart_lists',
      'order_items', 'orders', 'returns',
      'inventory_qc_inspections', 'inventory_po_line_items', 'inventory_purchase_orders',
      'inventory_movements', 'inventory', 'inventory_factories',
      'catalog_tags', 'catalog_images', 'catalog_copy_versions', 'catalog_name_options',
      'catalog_notes', 'catalog_skus', 'catalog_products', 'catalog_purchase_orders',
      'settlement_line_items', 'settlements', 'expenses', 'expense_categories',
      'marketing_ad_campaigns', 'marketing_content_calendar', 'marketing_influencers',
      'marketing_seo_keywords', 'marketing_social_posts', 'marketing_social_accounts',
      'notifications', 'activity_feed',
      'companies', 'users',
    ];

    // Ensure enrichment_status column exists (may be missing from older migrations)
    try { sqlite.exec("ALTER TABLE companies ADD COLUMN enrichment_status TEXT DEFAULT 'none'"); } catch { /* already exists */ }

    // Disable FK checks during cleanup to avoid ordering issues
    sqlite.exec("PRAGMA foreign_keys = OFF");
    for (const t of tables) {
      try { sqlite.exec(`DELETE FROM "${t}"`); } catch { /* table may not exist */ }
    }
    // Clear FTS tables if they exist
    try { sqlite.exec(`DELETE FROM companies_fts`); } catch { /* may not exist */ }
    sqlite.exec("PRAGMA foreign_keys = ON");

    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync("jaxy2026!", 10);
    const danielId = "582f8be0-cad3-47f2-8c3e-bc12b5a69c72";

    // ── Users ──
    sqlite.prepare(`INSERT INTO users (id, email, name, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      danielId, "daniel@getjaxy.com", "Daniel Seeff", passwordHash, "owner", 1, now, now
    );

    // ── 50 Companies with stores and contacts ──
    const companyTypes = ['boutique', 'optical', 'gift_shop', 'department_store', 'online_retailer'];
    const states = ['CA', 'NY', 'TX', 'FL', 'IL', 'WA', 'CO', 'GA', 'PA', 'MA'];
    const cities: Record<string, string[]> = {
      CA: ['Los Angeles', 'San Francisco', 'San Diego', 'Sacramento'],
      NY: ['New York', 'Brooklyn', 'Buffalo', 'Rochester'],
      TX: ['Austin', 'Houston', 'Dallas', 'San Antonio'],
      FL: ['Miami', 'Orlando', 'Tampa', 'Jacksonville'],
      IL: ['Chicago', 'Naperville', 'Evanston'],
      WA: ['Seattle', 'Tacoma', 'Bellevue'],
      CO: ['Denver', 'Boulder', 'Colorado Springs'],
      GA: ['Atlanta', 'Savannah', 'Athens'],
      PA: ['Philadelphia', 'Pittsburgh', 'Lancaster'],
      MA: ['Boston', 'Cambridge', 'Salem'],
    };
    const companyNames = [
      'Luxe Vision Boutique', 'Coastal Eyes Optical', 'Urban Shade Co', 'The Lens Loft', 'Bright Side Eyewear',
      'Crystal Clear Optics', 'Sunset Frames', 'Metro Eye Gallery', 'Golden Gate Glasses', 'Pacific View Optical',
      'Empire Eye Boutique', 'Brooklyn Frames', 'SoHo Specs', 'Fifth Ave Eyewear', 'Uptown Vision',
      'Lone Star Optics', 'Austin Eye Studio', 'Gulf Coast Glasses', 'Hill Country Frames', 'Texas Shade House',
      'South Beach Eyes', 'Orlando Optical', 'Tampa Bay Frames', 'Sunshine Eyewear', 'Palm Tree Optics',
      'Windy City Glasses', 'Lake Shore Optical', 'Prairie Frames', 'Emerald City Eyes', 'Puget Sound Optics',
      'Mile High Eyewear', 'Boulder Frames Co', 'Rocky Mountain Vision', 'Peach State Optical', 'Savannah Shades',
      'Liberty Bell Eyewear', 'Philly Frames', 'Bay State Optics', 'Harbor View Glasses', 'Beacon Hill Eyes',
      'Retro Specs LA', 'Vintage Lens SF', 'Modern Frame NYC', 'Classic Eyes Chicago', 'The Eyewear Emporium',
      'Specs & The City', 'Clear Day Optics', 'Four Eyes Boutique', 'Visionary Frames', 'The Frame Shop'
    ];
    const statuses = ['active', 'new', 'prospect', 'inactive'];
    const icpTiers = ['A', 'B', 'C', 'D'];
    const sources = ['google_maps', 'referral', 'faire', 'trade_show', 'cold_outreach', 'inbound'];
    const firstNames = ['Sarah', 'Mike', 'Jennifer', 'David', 'Emily', 'Chris', 'Amanda', 'James', 'Lisa', 'Tom', 'Rachel', 'Kevin', 'Maria', 'Brian', 'Nicole'];
    const lastNames = ['Johnson', 'Martinez', 'Chen', 'Williams', 'Brown', 'Taylor', 'Anderson', 'Lee', 'Garcia', 'Wilson', 'Park', 'Kim', 'Davis', 'Miller', 'Moore'];
    const titles = ['Owner', 'Buyer', 'Store Manager', 'Purchasing Director', 'General Manager'];

    const companyIds: string[] = [];
    const storeIds: string[] = [];
    const contactIds: string[] = [];

    const insertCompany = sqlite.prepare(`INSERT INTO companies (id, name, type, website, phone, email, city, state, zip, country, status, source, icp_tier, icp_score, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertStore = sqlite.prepare(`INSERT INTO stores (id, company_id, name, is_primary, city, state, zip, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertContact = sqlite.prepare(`INSERT INTO contacts (id, store_id, company_id, first_name, last_name, title, email, phone, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const seedCompanies = sqlite.transaction(() => {
      for (let i = 0; i < 50; i++) {
        const cId = uid();
        companyIds.push(cId);
        const st = states[i % states.length];
        const city = cities[st][i % cities[st].length];
        const type = companyTypes[i % companyTypes.length];
        const tier = icpTiers[Math.min(Math.floor(i / 12), 3)];
        const slug = companyNames[i].toLowerCase().replace(/[^a-z0-9]+/g, '');
        insertCompany.run(
          cId, companyNames[i], type, `https://${slug}.com`,
          `(${310 + i}) 555-${String(1000 + i).slice(-4)}`,
          `info@${slug}.com`, city, st, String(90000 + i * 111),
          'US', statuses[i % statuses.length], sources[i % sources.length],
          tier, 90 - i, JSON.stringify([type]), daysAgo(i * 3), now
        );

        // Store
        const sId = uid();
        storeIds.push(sId);
        insertStore.run(sId, cId, companyNames[i] + ' - Main', 1, city, st, String(90000 + i * 111),
          `(${310 + i}) 555-${String(1000 + i).slice(-4)}`, 'active', daysAgo(i * 3), now);

        // Contact
        const ctId = uid();
        contactIds.push(ctId);
        const fn = firstNames[i % firstNames.length];
        const ln = lastNames[i % lastNames.length];
        insertContact.run(ctId, sId, cId, fn, ln, titles[i % titles.length],
          `${fn.toLowerCase()}.${ln.toLowerCase()}@${slug}.com`,
          `(${310 + i}) 555-${String(2000 + i).slice(-4)}`, 1, daysAgo(i * 3), now);
      }
    });
    seedCompanies();

    // ── 10 Deals across pipeline stages ──
    const dealStages = ['outreach', 'outreach', 'contact_made', 'contact_made', 'interested', 'interested', 'order_placed', 'order_placed', 'interested_later', 'not_interested'];
    const insertDeal = sqlite.prepare(`INSERT INTO deals (id, company_id, store_id, contact_id, title, value, stage, channel, owner_id, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertDealActivity = sqlite.prepare(`INSERT INTO deal_activities (id, deal_id, company_id, type, description, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const dealIds: string[] = [];
    const channels = ['direct', 'faire', 'shopify', 'phone', 'other'];
    const seedDeals = sqlite.transaction(() => {
      for (let i = 0; i < 10; i++) {
        const dId = uid();
        dealIds.push(dId);
        const val = [350, 525, 700, 1050, 1400, 2100, 875, 1750, 3500, 420][i];
        insertDeal.run(dId, companyIds[i], storeIds[i], contactIds[i],
          `${companyNames[i]} - Initial Order`, val, dealStages[i],
          channels[i % channels.length], danielId, daysAgo(i * 2), daysAgo(i * 5), now);
        // Activity
        insertDealActivity.run(uid(), dId, companyIds[i], 'email', `Sent intro email to ${firstNames[i % firstNames.length]}`, danielId, daysAgo(i * 4));
        insertDealActivity.run(uid(), dId, companyIds[i], 'note', `${dealStages[i]} stage - follow up scheduled`, danielId, daysAgo(i * 2));
      }
    });
    seedDeals();

    // ── Catalog Products + SKUs (20 SKUs across 5 products) ──
    const products = [
      { prefix: 'JX1001', name: 'Venice Beach Classic', shape: 'wayfarer', material: 'acetate', gender: 'unisex', colors: ['BLK', 'TORT', 'CLR', 'NAV'] },
      { prefix: 'JX1002', name: 'Malibu Aviator', shape: 'aviator', material: 'metal', gender: 'unisex', colors: ['GLD', 'SLV', 'RSG', 'BLK'] },
      { prefix: 'JX1003', name: 'Santa Monica Round', shape: 'round', material: 'acetate', gender: 'women', colors: ['PNK', 'AMB', 'OLV', 'BLK'] },
      { prefix: 'JX1004', name: 'Silverlake Cat-Eye', shape: 'cat_eye', material: 'acetate', gender: 'women', colors: ['RED', 'BLK', 'TORT', 'CRM'] },
      { prefix: 'JX1005', name: 'Echo Park Sport', shape: 'sport', material: 'TR90', gender: 'men', colors: ['BLK', 'NVY', 'GRY', 'RED'] },
    ];
    const colorNames: Record<string, string> = {
      BLK: 'Black', TORT: 'Tortoise', CLR: 'Clear', NAV: 'Navy', GLD: 'Gold', SLV: 'Silver',
      RSG: 'Rose Gold', PNK: 'Pink', AMB: 'Amber', OLV: 'Olive', RED: 'Red', CRM: 'Cream',
      NVY: 'Navy', GRY: 'Grey'
    };

    const insertProduct = sqlite.prepare(`INSERT INTO catalog_products (id, sku_prefix, name, description, category, frame_shape, frame_material, gender, wholesale_price, retail_price, msrp, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertSku = sqlite.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name, cost_price, wholesale_price, retail_price, in_stock, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertInventory = sqlite.prepare(`INSERT INTO inventory (id, sku_id, location, quantity, reserved_quantity, reorder_point, sell_through_weekly, days_of_stock, needs_reorder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const insertImage = sqlite.prepare(`INSERT INTO catalog_images (id, sku_id, file_path, position, alt_text, status, is_best, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    const productIds: string[] = [];
    const skuIds: string[] = [];
    const seedCatalog = sqlite.transaction(() => {
      for (const p of products) {
        const pId = uid();
        productIds.push(pId);
        insertProduct.run(pId, p.prefix, p.name,
          `Premium ${p.material} ${p.shape} sunglasses. UV400 protection.`,
          'sunglasses', p.shape, p.material, p.gender,
          7.00, 14.00, 25.00, 'active', daysAgo(60), now);

        for (let ci = 0; ci < p.colors.length; ci++) {
          const color = p.colors[ci];
          const skuId = uid();
          skuIds.push(skuId);
          const sku = `${p.prefix}-${color}`;
          insertSku.run(skuId, pId, sku, colorNames[color] || color, 3.50, 7.00, 14.00, 1, 'active', daysAgo(60));

          // Add inventory record for each SKU
          const qty = 150 + Math.floor(Math.random() * 350); // 150-500 units
          const sellThrough = +(5 + Math.random() * 15).toFixed(1);
          const dosVal = +(qty / Math.max(sellThrough, 0.1)).toFixed(1);
          const needsReorder = qty < 50 ? 1 : 0;
          insertInventory.run(uid(), skuId, 'warehouse', qty, 0, 50, sellThrough, dosVal, needsReorder, daysAgo(60), now);

          // Add 2 images for the first 2 colorways of each product
          if (ci < 2) {
            insertImage.run(uid(), skuId, `/images/catalog/${sku}-front.jpg`, 0, `${p.name} ${colorNames[color] || color} - Front`, 'approved', 1, daysAgo(55));
            insertImage.run(uid(), skuId, `/images/catalog/${sku}-angle.jpg`, 1, `${p.name} ${colorNames[color] || color} - Angle`, 'approved', 0, daysAgo(55));
          }
        }
      }
    });
    seedCatalog();

    // ── 5 Orders with line items ──
    const orderChannels = ['shopify_dtc', 'faire', 'shopify_wholesale', 'direct', 'amazon'];
    const orderStatuses = ['delivered', 'shipped', 'pending', 'delivered', 'confirmed'];
    const insertOrder = sqlite.prepare(`INSERT INTO orders (id, order_number, company_id, store_id, contact_id, channel, status, subtotal, discount, shipping, tax, total, placed_at, shipped_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertOrderItem = sqlite.prepare(`INSERT INTO order_items (id, order_id, sku_id, sku, product_name, color_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const orderIds: string[] = [];
    const seedOrders = sqlite.transaction(() => {
      for (let i = 0; i < 5; i++) {
        const oId = uid();
        orderIds.push(oId);
        const qty = [48, 24, 72, 12, 36][i];
        const subtotal = qty * 7;
        const ship = [15, 0, 25, 8, 18][i];
        const tax = +(subtotal * 0.085).toFixed(2);
        const total = +(subtotal - 0 + ship + tax).toFixed(2);
        const orderNum = `JX-${2026}${String(i + 1).padStart(4, '0')}`;
        insertOrder.run(oId, orderNum, companyIds[i], storeIds[i], contactIds[i],
          orderChannels[i], orderStatuses[i], subtotal, 0, ship, tax, total,
          daysAgo(30 - i * 5), orderStatuses[i] === 'pending' ? null : daysAgo(25 - i * 5),
          daysAgo(30 - i * 5), now);

        // 2-3 line items per order
        const itemCount = i < 3 ? 3 : 2;
        for (let j = 0; j < itemCount; j++) {
          const skIdx = (i * 3 + j) % skuIds.length;
          const pIdx = Math.floor(skIdx / 4);
          const itemQty = Math.floor(qty / itemCount);
          insertOrderItem.run(uid(), oId, skuIds[skIdx],
            `${products[pIdx].prefix}-${products[pIdx].colors[skIdx % 4]}`,
            products[pIdx].name, colorNames[products[pIdx].colors[skIdx % 4]], itemQty, 7.00, itemQty * 7);
        }
      }
    });
    seedOrders();

    // ── Factory + 3 Purchase Orders ──
    const factoryId = uid();
    sqlite.prepare(`INSERT INTO inventory_factories (id, code, name, contact_name, contact_email, production_lead_days, transit_lead_days, moq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      factoryId, 'SZ-01', 'Shenzhen Brilliant Optics', 'Wei Zhang', 'wei@brilliantoptics.cn', 30, 25, 300, daysAgo(90)
    );

    const poStatuses = ['draft', 'shipped', 'received'];
    const insertPO = sqlite.prepare(`INSERT INTO inventory_purchase_orders (id, po_number, factory_id, status, total_units, total_cost, order_date, expected_ship_date, expected_arrival_date, actual_arrival_date, tracking_number, shipping_cost, duties_cost, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPOItem = sqlite.prepare(`INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, unit_cost, total_cost) VALUES (?, ?, ?, ?, ?, ?)`);

    const poIds: string[] = [];
    const seedPOs = sqlite.transaction(() => {
      for (let i = 0; i < 3; i++) {
        const poId = uid();
        poIds.push(poId);
        const units = [1200, 600, 900][i];
        const cost = units * 3.50;
        insertPO.run(poId, `PO-2026-${String(i + 1).padStart(3, '0')}`, factoryId, poStatuses[i],
          units, cost,
          i === 0 ? null : daysAgo(60 - i * 15),
          i === 0 ? null : daysAgo(30 - i * 10),
          i === 0 ? null : daysAgo(5 - i * 2),
          i === 2 ? daysAgo(3) : null,
          i === 1 ? 'UPSF-' + String(Math.floor(Math.random() * 9e9)) : null,
          i === 0 ? 0 : [0, 850, 1200][i],
          i === 0 ? 0 : [0, 420, 580][i],
          ['Draft PO for Q2 restock', 'In transit via UPS Freight', 'Received, QC passed'][i],
          daysAgo(60 - i * 15)
        );

        // PO line items (3 SKUs each)
        for (let j = 0; j < 3; j++) {
          const skIdx = (i * 3 + j) % skuIds.length;
          const q = Math.floor(units / 3);
          insertPOItem.run(uid(), poId, skuIds[skIdx], q, 3.50, q * 3.50);
        }
      }

      // QC inspection for received PO
      sqlite.prepare(`INSERT INTO inventory_qc_inspections (id, po_id, inspector, inspection_date, total_units, defect_count, defect_rate, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        uid(), poIds[2], 'Maria Lopez', daysAgo(2), 900, 12, 1.33, 'passed',
        'Minor scratches on 8 lenses, 4 misaligned hinges. Within acceptable range.', daysAgo(2)
      );
    });
    seedPOs();

    // ── Expense Categories + 5 Expenses ──
    const catIds: string[] = [];
    const expCats = ['COGS', 'Shipping & Logistics', 'Marketing', 'Software & Tools', 'Legal & Compliance'];
    const insertExpCat = sqlite.prepare(`INSERT INTO expense_categories (id, name, budget_monthly, created_at) VALUES (?, ?, ?, ?)`);
    const insertExpense = sqlite.prepare(`INSERT INTO expenses (id, category_id, description, amount, vendor, date, recurring, frequency, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const seedExpenses = sqlite.transaction(() => {
      for (const cat of expCats) {
        const cId = uid();
        catIds.push(cId);
        insertExpCat.run(cId, cat, [5000, 2000, 3000, 500, 1000][expCats.indexOf(cat)], daysAgo(90));
      }

      const expenses = [
        { cat: 0, desc: 'Factory invoice PO-2026-002', amount: 2100, vendor: 'Shenzhen Brilliant Optics', date: daysAgo(45), recurring: 0, freq: null, notes: '600 units @ $3.50' },
        { cat: 1, desc: 'UPS Freight - PO-2026-002', amount: 850, vendor: 'UPS', date: daysAgo(20), recurring: 0, freq: null, notes: 'Ocean + last mile' },
        { cat: 2, desc: 'Meta Ads - March campaign', amount: 1500, vendor: 'Meta Platforms', date: daysAgo(10), recurring: 1, freq: 'monthly', notes: 'Sunglasses awareness campaign' },
        { cat: 3, desc: 'Shopify Plus subscription', amount: 299, vendor: 'Shopify', date: daysAgo(5), recurring: 1, freq: 'monthly', notes: 'DTC + Wholesale stores' },
        { cat: 4, desc: 'Trademark filing - JAXY', amount: 1250, vendor: 'IP Law Group LLC', date: daysAgo(60), recurring: 0, freq: null, notes: 'Class 9 trademark application' },
      ];
      for (const e of expenses) {
        insertExpense.run(uid(), catIds[e.cat], e.desc, e.amount, e.vendor, e.date, e.recurring, e.freq, e.notes, e.date);
      }
    });
    seedExpenses();

    // ── 2 Settlements ──
    const insertSettlement = sqlite.prepare(`INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, adjustments, net_amount, status, received_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertSettlementItem = sqlite.prepare(`INSERT INTO settlement_line_items (id, settlement_id, order_id, type, description, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const seedSettlements = sqlite.transaction(() => {
      // Shopify settlement
      const sId1 = uid();
      insertSettlement.run(sId1, 'shopify', daysAgo(30), daysAgo(16), 2856.00, 82.82, 0, 2773.18, 'reconciled', daysAgo(14), 'February Shopify payout', daysAgo(14));
      insertSettlementItem.run(uid(), sId1, orderIds[0], 'sale', 'Order JX-20260001', 336.00, daysAgo(14));
      insertSettlementItem.run(uid(), sId1, null, 'sale', 'DTC orders (batch)', 2520.00, daysAgo(14));
      insertSettlementItem.run(uid(), sId1, null, 'fee', 'Shopify Payments processing', -82.82, daysAgo(14));

      // Faire settlement
      const sId2 = uid();
      insertSettlement.run(sId2, 'faire', daysAgo(15), daysAgo(1), 1680.00, 420.00, -25.00, 1235.00, 'pending', null, 'March Faire payout (pending)', now);
      insertSettlementItem.run(uid(), sId2, orderIds[1], 'sale', 'Order JX-20260002 (Faire)', 168.00, now);
      insertSettlementItem.run(uid(), sId2, null, 'sale', 'Faire wholesale orders', 1512.00, now);
      insertSettlementItem.run(uid(), sId2, null, 'fee', 'Faire commission (25%)', -420.00, now);
      insertSettlementItem.run(uid(), sId2, null, 'adjustment', 'Return credit', -25.00, now);
    });
    seedSettlements();

    // ── 10 Content Calendar Items ──
    const insertContent = sqlite.prepare(`INSERT INTO marketing_content_calendar (id, title, type, platform, status, scheduled_date, published_date, content, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const contentItems = [
      { title: 'Spring Collection Launch Post', type: 'social_post', platform: 'instagram', status: 'published', sched: daysAgo(5), pub: daysAgo(5), tags: 'launch,spring' },
      { title: 'Venice Beach Classic - Product Spotlight', type: 'reel', platform: 'instagram', status: 'published', sched: daysAgo(3), pub: daysAgo(3), tags: 'product,spotlight' },
      { title: 'How to Choose Sunglasses for Your Face Shape', type: 'blog_post', platform: 'website', status: 'draft', sched: days(5), pub: null, tags: 'seo,education' },
      { title: 'Retailer Spotlight: Luxe Vision Boutique', type: 'social_post', platform: 'linkedin', status: 'scheduled', sched: days(2), pub: null, tags: 'b2b,retail' },
      { title: 'Summer UV Protection Tips', type: 'email', platform: 'klaviyo', status: 'draft', sched: days(14), pub: null, tags: 'email,health' },
      { title: 'Behind the Scenes: Factory Visit', type: 'reel', platform: 'tiktok', status: 'idea', sched: days(21), pub: null, tags: 'bts,factory' },
      { title: 'Wholesale Program Benefits', type: 'blog_post', platform: 'website', status: 'published', sched: daysAgo(14), pub: daysAgo(14), tags: 'b2b,wholesale' },
      { title: 'Customer Testimonial - Coastal Eyes', type: 'social_post', platform: 'instagram', status: 'scheduled', sched: days(3), pub: null, tags: 'social_proof' },
      { title: 'National Sunglasses Day Campaign', type: 'campaign', platform: 'multi', status: 'idea', sched: days(90), pub: null, tags: 'holiday,campaign' },
      { title: 'Malibu Aviator Styling Guide', type: 'carousel', platform: 'instagram', status: 'draft', sched: days(7), pub: null, tags: 'product,style' },
    ];
    const seedContent = sqlite.transaction(() => {
      for (const c of contentItems) {
        insertContent.run(uid(), c.title, c.type, c.platform, c.status, c.sched, c.pub, null, c.tags, daysAgo(10));
      }
    });
    seedContent();

    // ── 5 SEO Keywords ──
    const insertKeyword = sqlite.prepare(`INSERT INTO marketing_seo_keywords (id, keyword, current_rank, previous_rank, url, search_volume, difficulty, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const keywords = [
      { kw: 'wholesale sunglasses', rank: 24, prev: 31, url: '/wholesale', vol: 8100, diff: 45 },
      { kw: 'affordable sunglasses brand', rank: 18, prev: 22, url: '/', vol: 4400, diff: 38 },
      { kw: 'bulk sunglasses for retailers', rank: 12, prev: 15, url: '/wholesale', vol: 2900, diff: 32 },
      { kw: 'acetate sunglasses under $25', rank: 35, prev: 42, url: '/collections/acetate', vol: 1600, diff: 28 },
      { kw: 'UV400 sunglasses wholesale', rank: 8, prev: 11, url: '/wholesale', vol: 1200, diff: 22 },
    ];
    const seedKeywords = sqlite.transaction(() => {
      for (const k of keywords) {
        insertKeyword.run(uid(), k.kw, k.rank, k.prev, k.url, k.vol, k.diff, now, daysAgo(30));
      }
    });
    seedKeywords();

    // ── 3 Ad Campaigns ──
    const insertAd = sqlite.prepare(`INSERT INTO marketing_ad_campaigns (id, platform, campaign_name, status, spend, impressions, clicks, conversions, revenue, start_date, end_date, monthly_budget, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ads = [
      { plat: 'meta', name: 'Spring Launch - Awareness', status: 'active', spend: 1245.50, imp: 185000, clicks: 4200, conv: 38, rev: 950.00, start: daysAgo(21), end: days(9), budget: 1500, notes: 'Broad targeting, lookalike audiences' },
      { plat: 'google', name: 'Wholesale Sunglasses - Search', status: 'active', spend: 680.25, imp: 32000, clicks: 1800, conv: 12, rev: 2400.00, start: daysAgo(30), end: null, budget: 800, notes: 'Targeting B2B keywords' },
      { plat: 'meta', name: 'Retargeting - Cart Abandonment', status: 'paused', spend: 320.00, imp: 45000, clicks: 890, conv: 22, rev: 550.00, start: daysAgo(45), end: daysAgo(5), budget: 500, notes: 'Paused for creative refresh' },
    ];
    const seedAds = sqlite.transaction(() => {
      for (const a of ads) {
        insertAd.run(uid(), a.plat, a.name, a.status, a.spend, a.imp, a.clicks, a.conv, a.rev, a.start, a.end, a.budget, a.notes, daysAgo(30));
      }
    });
    seedAds();

    // ── 5 Influencers ──
    const insertInfluencer = sqlite.prepare(`INSERT INTO marketing_influencers (id, name, platform, handle, followers, niche, status, cost, posts_delivered, engagement, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const influencers = [
      { name: 'Sophie Laurent', plat: 'instagram', handle: '@sophielaurentstyle', followers: 125000, niche: 'fashion', status: 'active', cost: 500, posts: 3, eng: 4.2, notes: 'Great engagement, authentic feel' },
      { name: 'Jake Morrison', plat: 'tiktok', handle: '@jakemstyle', followers: 340000, niche: 'lifestyle', status: 'negotiating', cost: 1200, posts: 0, eng: 6.8, notes: 'Interested in collab, reviewing terms' },
      { name: 'Aria Chen', plat: 'instagram', handle: '@ariasunnies', followers: 85000, niche: 'accessories', status: 'completed', cost: 350, posts: 2, eng: 5.1, notes: 'Delivered 2 reels, good ROI' },
      { name: 'Marcus Rivera', plat: 'youtube', handle: '@marcusstyleguide', followers: 210000, niche: 'mens_fashion', status: 'identified', cost: 800, posts: 0, eng: 3.5, notes: 'Great for male audience targeting' },
      { name: 'Taylor Nichols', plat: 'tiktok', handle: '@taylornichols', followers: 520000, niche: 'lifestyle', status: 'active', cost: 1500, posts: 1, eng: 7.2, notes: 'First post exceeded expectations' },
    ];
    const seedInfluencers = sqlite.transaction(() => {
      for (const inf of influencers) {
        insertInfluencer.run(uid(), inf.name, inf.plat, inf.handle, inf.followers, inf.niche, inf.status, inf.cost, inf.posts, inf.eng, inf.notes, daysAgo(30));
      }
    });
    seedInfluencers();

    // ── 5 Notifications ──
    const insertNotif = sqlite.prepare(`INSERT INTO notifications (id, type, title, message, severity, module, entity_id, entity_type, read, dismissed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const notifs = [
      { type: 'inventory_low', title: 'Low Stock Alert', msg: 'JX1001-BLK has 45 units remaining (below reorder point of 50)', sev: 'warning', mod: 'inventory', etype: 'sku' },
      { type: 'order_new', title: 'New Faire Order', msg: 'Coastal Eyes Optical placed order #JX-20260006 for $525.00', sev: 'info', mod: 'orders', etype: 'order' },
      { type: 'deal_stale', title: 'Stale Deal Alert', msg: 'Deal with Metro Eye Gallery has had no activity for 14 days', sev: 'warning', mod: 'sales', etype: 'deal' },
      { type: 'settlement_ready', title: 'Settlement Ready', msg: 'Shopify February payout of $2,773.18 has been deposited', sev: 'success', mod: 'finance', etype: 'settlement' },
      { type: 'po_arrived', title: 'PO Received', msg: 'PO-2026-003 arrived at warehouse. QC inspection: 1.33% defect rate (passed)', sev: 'info', mod: 'inventory', etype: 'purchase_order' },
    ];
    const seedNotifs = sqlite.transaction(() => {
      for (let i = 0; i < notifs.length; i++) {
        const n = notifs[i];
        insertNotif.run(uid(), n.type, n.title, n.msg, n.sev, n.mod, null, n.etype, i > 2 ? 1 : 0, 0, daysAgo(i * 2));
      }
    });
    seedNotifs();

    // ── 3 Customer Accounts with health history ──
    const insertAccount = sqlite.prepare(`INSERT INTO customer_accounts (id, company_id, tier, lifetime_value, total_orders, avg_order_value, first_order_at, last_order_at, next_reorder_estimate, health_score, health_status, payment_terms, discount_rate, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertHealth = sqlite.prepare(`INSERT INTO account_health_history (id, customer_account_id, score, status, factors, calculated_at) VALUES (?, ?, ?, ?, ?, ?)`);

    const accounts = [
      { compIdx: 0, tier: 'gold', ltv: 8750, orders: 12, aov: 729, health: 92, status: 'healthy', terms: 'net_30', disc: 5, notes: 'Top account, consistent reorders' },
      { compIdx: 1, tier: 'silver', ltv: 3500, orders: 5, aov: 700, health: 68, status: 'at_risk', terms: 'net_15', disc: 0, notes: 'Slowing order frequency' },
      { compIdx: 2, tier: 'bronze', ltv: 1050, orders: 2, aov: 525, health: 45, status: 'churning', terms: 'prepaid', disc: 0, notes: 'No order in 60 days' },
    ];
    const seedAccounts = sqlite.transaction(() => {
      for (const a of accounts) {
        const aId = uid();
        insertAccount.run(aId, companyIds[a.compIdx], a.tier, a.ltv, a.orders, a.aov,
          daysAgo(180), daysAgo(a.compIdx * 30 + 10), days(30 - a.compIdx * 15),
          a.health, a.status, a.terms, a.disc, a.notes, daysAgo(180), now);

        // Health history (3 entries each)
        for (let h = 0; h < 3; h++) {
          const score = a.health - h * (a.status === 'healthy' ? 2 : 8);
          insertHealth.run(uid(), aId, score,
            score > 70 ? 'healthy' : score > 50 ? 'at_risk' : 'churning',
            JSON.stringify({ order_frequency: score > 70 ? 'good' : 'declining', payment: 'on_time' }),
            daysAgo(h * 30));
        }
      }
    });
    seedAccounts();

    // ── Activity Feed ──
    const insertActivity = sqlite.prepare(`INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const activities = [
      { type: 'deal_created', mod: 'sales', etype: 'deal', data: { title: 'Luxe Vision Boutique - Initial Order', value: 350 } },
      { type: 'order_placed', mod: 'orders', etype: 'order', data: { order_number: 'JX-20260001', total: 380.86, channel: 'shopify_dtc' } },
      { type: 'po_created', mod: 'inventory', etype: 'purchase_order', data: { po_number: 'PO-2026-001', units: 1200 } },
      { type: 'content_published', mod: 'marketing', etype: 'content', data: { title: 'Spring Collection Launch Post', platform: 'instagram' } },
      { type: 'settlement_received', mod: 'finance', etype: 'settlement', data: { channel: 'shopify', net_amount: 2773.18 } },
      { type: 'deal_stage_changed', mod: 'sales', etype: 'deal', data: { title: 'Coastal Eyes Optical', from: 'outreach', to: 'engaged' } },
      { type: 'inventory_low', mod: 'inventory', etype: 'sku', data: { sku: 'JX1001-BLK', quantity: 45 } },
      { type: 'order_shipped', mod: 'orders', etype: 'order', data: { order_number: 'JX-20260002', tracking: 'UPSN-123456' } },
      { type: 'influencer_posted', mod: 'marketing', etype: 'influencer', data: { name: 'Sophie Laurent', platform: 'instagram' } },
      { type: 'customer_health_changed', mod: 'customers', etype: 'customer_account', data: { company: 'Coastal Eyes Optical', from: 'healthy', to: 'at_risk' } },
    ];
    const seedActivities = sqlite.transaction(() => {
      for (let i = 0; i < activities.length; i++) {
        const a = activities[i];
        insertActivity.run(uid(), a.type, a.mod, a.etype, null, JSON.stringify(a.data), danielId, daysAgo(i * 2));
      }
    });
    seedActivities();

    // Count results
    const counts: Record<string, number> = {};
    for (const t of ['users', 'companies', 'stores', 'contacts', 'deals', 'orders', 'order_items',
      'inventory', 'inventory_purchase_orders', 'expenses', 'settlements', 'marketing_content_calendar',
      'marketing_seo_keywords', 'marketing_ad_campaigns', 'marketing_influencers', 'notifications',
      'customer_accounts', 'account_health_history', 'activity_feed', 'catalog_products', 'catalog_skus', 'catalog_images']) {
      try { counts[t] = (sqlite.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get() as any).c; } catch { counts[t] = 0; }
    }

    return NextResponse.json({ success: true, message: 'Demo data seeded successfully', counts });
  } catch (error: any) {
    return NextResponse.json({ error: String(error), stack: error?.stack }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: "POST to this endpoint to seed the database with demo data" });
}
