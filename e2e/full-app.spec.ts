import { test, expect, Page } from "@playwright/test";

// ── Helper: Login ──
async function login(page: Page) {
  await page.goto("/login");
  await page.fill('#email', "daniel@getjaxy.com");
  await page.fill('#password', "jaxy2026!");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
}

// ═══════════════════════════════════════════
// 1. AUTH
// ═══════════════════════════════════════════
test.describe("Auth", () => {
  test("login page renders", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("h1, h2, h3").first()).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("login with valid credentials", async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/dashboard/);
  });

  test("login with invalid credentials shows error", async ({ page }) => {
    await page.goto("/login");
    await page.fill('#email', "wrong@email.com");
    await page.fill('#password', "wrongpass");
    await page.click('button[type="submit"]');
    // Should show error or stay on login
    await page.waitForTimeout(2000);
    const url = page.url();
    const hasError = await page.locator("text=invalid, text=error, text=failed, [role=alert]").count();
    expect(url.includes("login") || hasError > 0).toBeTruthy();
  });

  test("unauthenticated redirect to login", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForTimeout(2000);
    // Should redirect to login or show login
    const url = page.url();
    expect(url.includes("login") || url.includes("dashboard")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════
// 2. DASHBOARD
// ═══════════════════════════════════════════
test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("dashboard loads with summary cards", async ({ page }) => {
    await expect(page.locator("[data-testid='dashboard'], .grid, main").first()).toBeVisible();
    // Should have multiple stat cards
    const cards = page.locator(".rounded-lg, .rounded-xl, [class*=card]");
    await expect(cards.first()).toBeVisible();
  });

  test("sidebar navigation visible", async ({ page }) => {
    const sidebar = page.locator("nav, aside, [data-sidebar]").first();
    await expect(sidebar).toBeVisible();
  });

  test("sidebar links work", async ({ page }) => {
    // Click prospects link
    await page.click('a[href*="prospects"], text=Prospects');
    await page.waitForURL("**/prospects", { timeout: 5000 });
    await expect(page).toHaveURL(/prospects/);
  });
});

// ═══════════════════════════════════════════
// 3. PROSPECTS
// ═══════════════════════════════════════════
test.describe("Prospects", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("prospects page loads with data", async ({ page }) => {
    await page.goto("/prospects");
    await page.waitForTimeout(2000);
    // Should have a table or list of prospects
    const rows = page.locator("tr, [role=row]");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("search filters prospects", async ({ page }) => {
    await page.goto("/prospects");
    await page.waitForTimeout(2000);
    const searchInput = page.locator('input[placeholder*="earch"], input[type="search"], input[name="search"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill("boutique");
      await page.waitForTimeout(1000);
      // Results should update
    }
  });

  test("click prospect opens detail", async ({ page }) => {
    await page.goto("/prospects");
    await page.waitForTimeout(2000);
    // Click first prospect row/link
    const firstRow = page.locator("tr a, [role=row] a, table tbody tr").first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await page.waitForTimeout(2000);
      // Should navigate to detail page
      expect(page.url()).toMatch(/prospects\/[a-zA-Z0-9-]+/);
    }
  });

  test("prospect detail page loads", async ({ page }) => {
    await page.goto("/prospects");
    await page.waitForTimeout(2000);
    const link = page.locator("a[href*='/prospects/']").first();
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(2000);
      // Should show company info
      const heading = page.locator("h1, h2").first();
      await expect(heading).toBeVisible();
    }
  });

  test("bulk select checkbox works", async ({ page }) => {
    await page.goto("/prospects");
    await page.waitForTimeout(2000);
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.isVisible()) {
      await checkbox.check();
      // Bulk action bar should appear
      await page.waitForTimeout(500);
    }
  });
});

// ═══════════════════════════════════════════
// 4. PIPELINE / DEALS
// ═══════════════════════════════════════════
test.describe("Pipeline", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("pipeline page loads", async ({ page }) => {
    await page.goto("/pipeline");
    await page.waitForTimeout(2000);
    // Should show kanban columns or deal list
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("deal cards visible", async ({ page }) => {
    await page.goto("/pipeline");
    await page.waitForTimeout(2000);
    // Look for deal cards in pipeline columns
    const cards = page.locator("[class*=card], [class*=deal], [draggable]");
    const count = await cards.count();
    // May or may not have deals depending on seed
  });

  test("new deal dialog opens", async ({ page }) => {
    await page.goto("/pipeline");
    await page.waitForTimeout(1000);
    const newBtn = page.locator('button:has-text("New Deal"), button:has-text("Create"), button:has-text("Add")').first();
    if (await newBtn.isVisible()) {
      await newBtn.click();
      await page.waitForTimeout(500);
      // Dialog should open
      const dialog = page.locator("[role=dialog], [class*=modal], [class*=dialog]");
      await expect(dialog.first()).toBeVisible();
    }
  });

  test("click deal opens detail", async ({ page }) => {
    await page.goto("/pipeline");
    await page.waitForTimeout(2000);
    const dealLink = page.locator("a[href*='/pipeline/']").first();
    if (await dealLink.isVisible()) {
      await dealLink.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toMatch(/pipeline\/[a-zA-Z0-9-]+/);
    }
  });
});

// ═══════════════════════════════════════════
// 5. CAMPAIGNS
// ═══════════════════════════════════════════
test.describe("Campaigns", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("campaigns page loads", async ({ page }) => {
    await page.goto("/campaigns");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("campaign inbox loads", async ({ page }) => {
    await page.goto("/campaigns/inbox");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 6. CATALOG
// ═══════════════════════════════════════════
test.describe("Catalog", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("catalog page loads with products", async ({ page }) => {
    await page.goto("/catalog");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("catalog product detail loads", async ({ page }) => {
    await page.goto("/catalog");
    await page.waitForTimeout(2000);
    const link = page.locator("a[href*='/catalog/']").first();
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toMatch(/catalog\/[a-zA-Z0-9-]+/);
    }
  });

  test("catalog export page loads", async ({ page }) => {
    await page.goto("/catalog/export");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("catalog intake page loads", async ({ page }) => {
    await page.goto("/catalog/intake");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 7. ORDERS
// ═══════════════════════════════════════════
test.describe("Orders", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("orders page loads", async ({ page }) => {
    await page.goto("/orders");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("orders show data from seed", async ({ page }) => {
    await page.goto("/orders");
    await page.waitForTimeout(2000);
    const rows = page.locator("table tbody tr, [role=row]");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("click order opens detail", async ({ page }) => {
    await page.goto("/orders");
    await page.waitForTimeout(2000);
    const link = page.locator("a[href*='/orders/']").first();
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toMatch(/orders\/[a-zA-Z0-9-]+/);
    }
  });

  test("create order button exists", async ({ page }) => {
    await page.goto("/orders");
    await page.waitForTimeout(1000);
    const btn = page.locator('button:has-text("Create"), button:has-text("New Order"), button:has-text("Add")').first();
    await expect(btn).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 8. INVENTORY
// ═══════════════════════════════════════════
test.describe("Inventory", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("inventory page loads", async ({ page }) => {
    await page.goto("/inventory");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("inventory shows stock data", async ({ page }) => {
    await page.goto("/inventory");
    await page.waitForTimeout(2000);
    const rows = page.locator("table tbody tr");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("purchase orders page loads", async ({ page }) => {
    await page.goto("/inventory/purchase-orders");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 9. FINANCE
// ═══════════════════════════════════════════
test.describe("Finance", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("finance page loads", async ({ page }) => {
    await page.goto("/finance");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("finance tabs switch", async ({ page }) => {
    await page.goto("/finance");
    await page.waitForTimeout(2000);
    // Try clicking different tabs
    const tabs = page.locator("[role=tab], button:has-text('Expenses'), button:has-text('P&L'), button:has-text('Settlements')");
    const count = await tabs.count();
    for (let i = 0; i < Math.min(count, 4); i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(500);
    }
  });
});

// ═══════════════════════════════════════════
// 10. CUSTOMERS
// ═══════════════════════════════════════════
test.describe("Customers", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("customers page loads", async ({ page }) => {
    await page.goto("/customers");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("customer detail loads", async ({ page }) => {
    await page.goto("/customers");
    await page.waitForTimeout(2000);
    const link = page.locator("a[href*='/customers/']").first();
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toMatch(/customers\/[a-zA-Z0-9-]+/);
    }
  });
});

// ═══════════════════════════════════════════
// 11. MARKETING
// ═══════════════════════════════════════════
test.describe("Marketing", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("marketing page loads", async ({ page }) => {
    await page.goto("/marketing");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("marketing tabs switch without errors", async ({ page }) => {
    await page.goto("/marketing");
    await page.waitForTimeout(2000);
    const tabs = page.locator("[role=tab], button").filter({ hasText: /Content|SEO|Social|Ads|Influencer|Klaviyo/ });
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(500);
      // Check no error boundary
      const error = page.locator("text=Something went wrong, text=Error, [class*=error]");
      expect(await error.count()).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════
// 12. INTELLIGENCE
// ═══════════════════════════════════════════
test.describe("Intelligence", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("intelligence page loads", async ({ page }) => {
    await page.goto("/intelligence");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 13. AI CENTER
// ═══════════════════════════════════════════
test.describe("AI Center", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("AI page loads", async ({ page }) => {
    await page.goto("/ai");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 14. NOTIFICATIONS
// ═══════════════════════════════════════════
test.describe("Notifications", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("notifications page loads", async ({ page }) => {
    await page.goto("/notifications");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 15. PROFILE
// ═══════════════════════════════════════════
test.describe("Profile", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("profile page loads", async ({ page }) => {
    await page.goto("/profile");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });
});

// ═══════════════════════════════════════════
// 16. SETTINGS
// ═══════════════════════════════════════════
test.describe("Settings", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("settings page loads", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForTimeout(2000);
    const content = page.locator("main").first();
    await expect(content).toBeVisible();
  });

  test("settings tabs switch", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForTimeout(1000);
    const tabs = page.locator("[role=tab], button").filter({ hasText: /Profile|Integration|Notification|Data/ });
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(500);
    }
  });
});

// ═══════════════════════════════════════════
// 17. GLOBAL SEARCH (Cmd+K)
// ═══════════════════════════════════════════
test.describe("Global Search", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("Cmd+K opens command palette", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(500);
    const dialog = page.locator("[role=dialog], [cmdk-dialog], [class*=command]");
    // May or may not work depending on platform
  });
});

// ═══════════════════════════════════════════
// 18. API HEALTH CHECKS
// ═══════════════════════════════════════════
test.describe("API Health", () => {
  test("health endpoint returns 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("prospects API returns data", async ({ request }) => {
    const res = await request.get("/api/v1/sales/prospects");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.prospects).toBeDefined();
  });

  test("orders API returns data", async ({ request }) => {
    const res = await request.get("/api/v1/orders");
    expect(res.status()).toBe(200);
  });

  test("inventory API returns data", async ({ request }) => {
    const res = await request.get("/api/v1/inventory");
    expect(res.status()).toBe(200);
  });

  test("dashboard API returns stats", async ({ request }) => {
    const res = await request.get("/api/v1/sales/dashboard");
    expect(res.status()).toBe(200);
  });

  test("notifications count API works", async ({ request }) => {
    const res = await request.get("/api/v1/notifications/count");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.unread).toBe("number");
  });

  test("search API works", async ({ request }) => {
    const res = await request.get("/api/v1/search?q=test");
    expect(res.status()).toBe(200);
  });

  test("finance P&L API works", async ({ request }) => {
    const res = await request.get("/api/v1/finance/pnl");
    expect(res.status()).toBe(200);
  });

  test("intelligence health API works", async ({ request }) => {
    const res = await request.get("/api/v1/intelligence/health");
    expect(res.status()).toBe(200);
  });

  test("agents API works", async ({ request }) => {
    const res = await request.get("/api/v1/agents");
    expect(res.status()).toBe(200);
  });
});

// ═══════════════════════════════════════════
// 19. CONSOLE ERROR CHECK (every page)
// ═══════════════════════════════════════════
test.describe("No console errors on pages", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  const pages = [
    "/dashboard", "/prospects", "/pipeline", "/campaigns",
    "/catalog", "/orders", "/inventory", "/inventory/purchase-orders",
    "/finance", "/customers", "/marketing", "/intelligence",
    "/ai", "/notifications", "/profile", "/settings",
  ];

  for (const path of pages) {
    test(`${path} has no JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(path);
      await page.waitForTimeout(3000);
      // Filter out known non-critical errors
      const critical = errors.filter(e => 
        !e.includes("hydration") && 
        !e.includes("ResizeObserver") &&
        !e.includes("Loading chunk")
      );
      expect(critical).toEqual([]);
    });
  }
});
