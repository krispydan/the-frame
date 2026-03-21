import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { createRequest, parseResponse, seedTestData, seedDeals, seedCampaigns } from "../api-helpers";

// ── Route handler imports ──
import { GET as getProspects } from "@/app/api/v1/sales/prospects/route";
import { GET as getProspectDetail, PATCH as patchProspect } from "@/app/api/v1/sales/prospects/[id]/route";
import { POST as bulkProspects } from "@/app/api/v1/sales/prospects/bulk/route";
import { GET as getDeals, POST as postDeal } from "@/app/api/v1/sales/deals/route";
import { GET as getDealDetail, PATCH as patchDeal, DELETE as deleteDeal } from "@/app/api/v1/sales/deals/[id]/route";
import { POST as snoozeDeal, DELETE as unsnoozeDeal } from "@/app/api/v1/sales/deals/[id]/snooze/route";
import { GET as getDealActivities, POST as postDealActivity } from "@/app/api/v1/sales/deals/[id]/activities/route";
import { GET as getCampaigns, POST as postCampaign } from "@/app/api/v1/sales/campaigns/route";
import { GET as getCampaignDetail, PATCH as patchCampaign, DELETE as deleteCampaign } from "@/app/api/v1/sales/campaigns/[id]/route";
import { POST as postContact, PATCH as patchContact } from "@/app/api/v1/sales/contacts/route";
import { GET as getSmartLists, POST as postSmartList, PUT as putSmartList, DELETE as deleteSmartList } from "@/app/api/v1/sales/smart-lists/route";
import { GET as getDashboard } from "@/app/api/v1/sales/dashboard/route";

// Helper to create params object matching Next.js dynamic route pattern
function routeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("Sales API Routes", () => {
  beforeEach(() => {
    resetTestDb();
  });

  // ══════════════════════════════════════════
  // PROSPECTS
  // ══════════════════════════════════════════
  describe("Prospects", () => {
    beforeEach(() => seedTestData());

    it("GET returns all prospects", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects");
      const res = await getProspects(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(200);
      expect(data.data.length).toBe(3);
      expect(data.total).toBe(3);
    });

    it("GET filters by state", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects", {
        searchParams: { state: "CA" },
      });
      const res = await getProspects(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe("Sunny Shades");
    });

    it("GET filters by status", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects", {
        searchParams: { status: "qualified" },
      });
      const res = await getProspects(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1);
      expect(data.data[0].id).toBe("c1");
    });

    it("GET filters by has_email", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects", {
        searchParams: { has_email: "true" },
      });
      const res = await getProspects(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(2); // c1 and c3 have emails
    });

    it("GET filters by icp_min", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects", {
        searchParams: { icp_min: "70" },
      });
      const res = await getProspects(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(2); // c1 (85) and c3 (72)
    });

    it("GET paginates correctly", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects", {
        searchParams: { page: "1", limit: "2" },
      });
      const res = await getProspects(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(2);
      expect(data.total).toBe(3);
      expect(data.totalPages).toBe(2);
    });

    it("GET prospect detail by id", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects/c1");
      const res = await getProspectDetail(req, routeParams("c1"));
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(200);
      expect(data.company.name).toBe("Sunny Shades");
      expect(data.stores.length).toBe(1);
      expect(data.contacts.length).toBe(1);
    });

    it("GET prospect detail returns 404 for missing id", async () => {
      const req = createRequest("GET", "/api/v1/sales/prospects/nonexistent");
      const res = await getProspectDetail(req, routeParams("nonexistent"));
      expect(res.status).toBe(404);
    });

    it("PATCH updates prospect fields", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/prospects/c1", {
        body: { status: "customer", notes: "Great client" },
      });
      const res = await patchProspect(req, routeParams("c1"));
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(200);
      expect(data.success).toBe(true);

      // Verify
      const db = getTestDb();
      const row = db.prepare("SELECT status, notes FROM companies WHERE id = 'c1'").get() as any;
      expect(row.status).toBe("customer");
      expect(row.notes).toBe("Great client");
    });

    it("PATCH returns 400 for no valid fields", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/prospects/c1", {
        body: { invalid_field: "test" },
      });
      const res = await patchProspect(req, routeParams("c1"));
      expect(res.status).toBe(400);
    });

    it("POST bulk approve updates status", async () => {
      const req = createRequest("POST", "/api/v1/sales/prospects/bulk", {
        body: { action: "approve", ids: ["c2", "c3"] },
      });
      const res = await bulkProspects(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(200);
      expect(data.affected).toBe(2);

      const db = getTestDb();
      const c2 = db.prepare("SELECT status FROM companies WHERE id = 'c2'").get() as any;
      expect(c2.status).toBe("qualified");
    });

    it("POST bulk rejects with missing action", async () => {
      const req = createRequest("POST", "/api/v1/sales/prospects/bulk", {
        body: { ids: ["c1"] },
      });
      const res = await bulkProspects(req);
      expect(res.status).toBe(400);
    });

    it("POST bulk tag adds tag to companies", async () => {
      const req = createRequest("POST", "/api/v1/sales/prospects/bulk", {
        body: { action: "tag", ids: ["c1"], params: { tag: "vip" } },
      });
      const res = await bulkProspects(req);
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      const db = getTestDb();
      const row = db.prepare("SELECT tags FROM companies WHERE id = 'c1'").get() as any;
      expect(JSON.parse(row.tags)).toContain("vip");
    });
  });

  // ══════════════════════════════════════════
  // DEALS
  // ══════════════════════════════════════════
  describe("Deals", () => {
    beforeEach(() => { seedTestData(); seedDeals(); });

    it("GET lists active deals", async () => {
      const req = createRequest("GET", "/api/v1/sales/deals");
      const res = await getDeals(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1); // d2 is snoozed
      expect(data.data[0].id).toBe("d1");
    });

    it("GET lists snoozed deals", async () => {
      const req = createRequest("GET", "/api/v1/sales/deals", {
        searchParams: { tab: "snoozed" },
      });
      const res = await getDeals(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1);
      expect(data.data[0].id).toBe("d2");
    });

    it("GET filters by stage", async () => {
      const req = createRequest("GET", "/api/v1/sales/deals", {
        searchParams: { stage: "outreach" },
      });
      const res = await getDeals(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1);
      expect(data.data[0].stage).toBe("outreach");
    });

    it("POST creates deal", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals", {
        body: { company_id: "c1", title: "New Deal", value: 1000, stage: "interested", channel: "direct" },
      });
      const res = await postDeal(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.id).toBeTruthy();

      const db = getTestDb();
      const deal = db.prepare("SELECT * FROM deals WHERE id = ?").get(data.id) as any;
      expect(deal.title).toBe("New Deal");
      expect(deal.stage).toBe("interested");
    });

    it("POST deal requires company_id and title", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals", {
        body: { value: 500 },
      });
      const res = await postDeal(req);
      expect(res.status).toBe(400);
    });

    it("GET deal detail", async () => {
      const req = createRequest("GET", "/api/v1/sales/deals/d1");
      const res = await getDealDetail(req, routeParams("d1"));
      const { data } = await parseResponse<any>(res);
      expect(data.deal.title).toBe("Sunny Initial Order");
      expect(data.deal.company_name).toBe("Sunny Shades");
    });

    it("GET deal detail 404", async () => {
      const req = createRequest("GET", "/api/v1/sales/deals/nope");
      const res = await getDealDetail(req, routeParams("nope"));
      expect(res.status).toBe(404);
    });

    it("PATCH deal stage change", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/deals/d1", {
        body: { stage: "interested" },
      });
      const res = await patchDeal(req, routeParams("d1"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      const db = getTestDb();
      const deal = db.prepare("SELECT stage, previous_stage FROM deals WHERE id = 'd1'").get() as any;
      expect(deal.stage).toBe("interested");
      expect(deal.previous_stage).toBe("outreach");
    });

    it("PATCH deal 404 for missing deal", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/deals/nope", {
        body: { stage: "interested" },
      });
      const res = await patchDeal(req, routeParams("nope"));
      expect(res.status).toBe(404);
    });

    it("DELETE deal removes deal and activities", async () => {
      // Add an activity first
      const db = getTestDb();
      db.prepare("INSERT INTO deal_activities (id, deal_id, company_id, type) VALUES ('da1', 'd1', 'c1', 'note')").run();

      const req = createRequest("DELETE", "/api/v1/sales/deals/d1");
      const res = await deleteDeal(req, routeParams("d1"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      expect(db.prepare("SELECT * FROM deals WHERE id = 'd1'").get()).toBeUndefined();
      expect(db.prepare("SELECT * FROM deal_activities WHERE deal_id = 'd1'").all().length).toBe(0);
    });

    it("POST snooze deal", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals/d1/snooze", {
        body: { until: "2026-06-01", reason: "Follow up later" },
      });
      const res = await snoozeDeal(req, routeParams("d1"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      const db = getTestDb();
      const deal = db.prepare("SELECT snooze_until, snooze_reason FROM deals WHERE id = 'd1'").get() as any;
      expect(deal.snooze_until).toBe("2026-06-01");
      expect(deal.snooze_reason).toBe("Follow up later");
    });

    it("POST snooze requires until", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals/d1/snooze", {
        body: { reason: "no date" },
      });
      const res = await snoozeDeal(req, routeParams("d1"));
      expect(res.status).toBe(400);
    });

    it("DELETE unsnooze deal", async () => {
      const req = createRequest("DELETE", "/api/v1/sales/deals/d2/snooze");
      const res = await unsnoozeDeal(req, routeParams("d2"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      const db = getTestDb();
      const deal = db.prepare("SELECT snooze_until FROM deals WHERE id = 'd2'").get() as any;
      expect(deal.snooze_until).toBeNull();
    });

    it("POST deal activity", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals/d1/activities", {
        body: { type: "note", description: "Left voicemail" },
      });
      const res = await postDealActivity(req, routeParams("d1"));
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.id).toBeTruthy();
    });

    it("POST deal activity requires type", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals/d1/activities", {
        body: { description: "no type" },
      });
      const res = await postDealActivity(req, routeParams("d1"));
      expect(res.status).toBe(400);
    });

    it("POST deal activity 404 for missing deal", async () => {
      const req = createRequest("POST", "/api/v1/sales/deals/nope/activities", {
        body: { type: "note" },
      });
      const res = await postDealActivity(req, routeParams("nope"));
      expect(res.status).toBe(404);
    });

    it("GET deal activities", async () => {
      const db = getTestDb();
      db.prepare("INSERT INTO deal_activities (id, deal_id, company_id, type, description) VALUES ('da1', 'd1', 'c1', 'note', 'Test note')").run();

      const req = createRequest("GET", "/api/v1/sales/deals/d1/activities");
      const res = await getDealActivities(req, routeParams("d1"));
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1);
      expect(data.data[0].description).toBe("Test note");
    });
  });

  // ══════════════════════════════════════════
  // CAMPAIGNS
  // ══════════════════════════════════════════
  describe("Campaigns", () => {
    beforeEach(() => { seedTestData(); seedCampaigns(); });

    it("GET lists campaigns with summary", async () => {
      const req = createRequest("GET", "/api/v1/sales/campaigns");
      const res = await getCampaigns(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(2);
      expect(data.summary).toBeDefined();
      expect(data.summary.active_campaigns).toBe(1);
      expect(data.summary.total_sent).toBe(100);
    });

    it("GET filters campaigns by status", async () => {
      const req = createRequest("GET", "/api/v1/sales/campaigns", {
        searchParams: { status: "draft" },
      });
      const res = await getCampaigns(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.length).toBe(1);
      expect(data.data[0].name).toBe("Re-engage Old Leads");
    });

    it("POST creates campaign", async () => {
      const req = createRequest("POST", "/api/v1/sales/campaigns", {
        body: { name: "New Campaign", type: "calling", description: "Phone outreach" },
      });
      const res = await postCampaign(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.data.name).toBe("New Campaign");
      expect(data.data.type).toBe("calling");
    });

    it("POST campaign requires name", async () => {
      const req = createRequest("POST", "/api/v1/sales/campaigns", {
        body: { type: "email_sequence" },
      });
      const res = await postCampaign(req);
      expect(res.status).toBe(400);
    });

    it("GET campaign detail with leads", async () => {
      const db = getTestDb();
      db.prepare("INSERT INTO campaign_leads (id, campaign_id, company_id, status) VALUES ('cl1', 'camp1', 'c1', 'sent')").run();

      const req = createRequest("GET", "/api/v1/sales/campaigns/camp1");
      const res = await getCampaignDetail(req, routeParams("camp1"));
      const { data } = await parseResponse<any>(res);
      expect(data.data.name).toBe("Launch Campaign");
      expect(data.data.leads.length).toBe(1);
    });

    it("GET campaign detail 404", async () => {
      const req = createRequest("GET", "/api/v1/sales/campaigns/nope");
      const res = await getCampaignDetail(req, routeParams("nope"));
      expect(res.status).toBe(404);
    });

    it("PATCH updates campaign", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/campaigns/camp1", {
        body: { status: "paused", description: "Taking a break" },
      });
      const res = await patchCampaign(req, routeParams("camp1"));
      const { data } = await parseResponse<any>(res);
      expect(data.data.status).toBe("paused");
    });

    it("PATCH campaign 400 for no fields", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/campaigns/camp1", {
        body: { garbage: true },
      });
      const res = await patchCampaign(req, routeParams("camp1"));
      expect(res.status).toBe(400);
    });

    it("DELETE campaign removes campaign and leads", async () => {
      const db = getTestDb();
      db.prepare("INSERT INTO campaign_leads (id, campaign_id, company_id) VALUES ('cl1', 'camp2', 'c1')").run();

      const req = createRequest("DELETE", "/api/v1/sales/campaigns/camp2");
      const res = await deleteCampaign(req, routeParams("camp2"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      expect(db.prepare("SELECT * FROM campaigns WHERE id = 'camp2'").get()).toBeUndefined();
      expect(db.prepare("SELECT * FROM campaign_leads WHERE campaign_id = 'camp2'").all().length).toBe(0);
    });
  });

  // ══════════════════════════════════════════
  // CONTACTS
  // ══════════════════════════════════════════
  describe("Contacts", () => {
    beforeEach(() => seedTestData());

    it("POST creates contact", async () => {
      const req = createRequest("POST", "/api/v1/sales/contacts", {
        body: { company_id: "c1", first_name: "Bob", last_name: "Smith", email: "bob@test.com" },
      });
      const res = await postContact(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.data.first_name).toBe("Bob");
    });

    it("POST contact requires company_id", async () => {
      const req = createRequest("POST", "/api/v1/sales/contacts", {
        body: { first_name: "Bob" },
      });
      const res = await postContact(req);
      expect(res.status).toBe(400);
    });

    it("PATCH updates contact", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/contacts", {
        body: { id: "ct1", title: "CEO", phone: "555-9999" },
      });
      const res = await patchContact(req);
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);

      const db = getTestDb();
      const ct = db.prepare("SELECT title, phone FROM contacts WHERE id = 'ct1'").get() as any;
      expect(ct.title).toBe("CEO");
      expect(ct.phone).toBe("555-9999");
    });

    it("PATCH contact requires id", async () => {
      const req = createRequest("PATCH", "/api/v1/sales/contacts", {
        body: { first_name: "Nobody" },
      });
      const res = await patchContact(req);
      expect(res.status).toBe(400);
    });
  });

  // ══════════════════════════════════════════
  // SMART LISTS
  // ══════════════════════════════════════════
  describe("Smart Lists", () => {
    beforeEach(() => seedTestData());

    it("GET returns empty initially", async () => {
      const req = createRequest("GET", "/api/v1/sales/smart-lists");
      const res = await getSmartLists();
      const { data } = await parseResponse<any>(res);
      expect(data.data).toEqual([]);
    });

    it("POST creates smart list", async () => {
      const req = createRequest("POST", "/api/v1/sales/smart-lists", {
        body: { name: "CA Prospects", filters: { state: ["CA"] } },
      });
      const res = await postSmartList(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.data.name).toBe("CA Prospects");
      expect(data.data.resultCount).toBe(1); // Only c1 is in CA
    });

    it("POST smart list requires name and filters", async () => {
      const req = createRequest("POST", "/api/v1/sales/smart-lists", {
        body: { name: "Missing filters" },
      });
      const res = await postSmartList(req);
      expect(res.status).toBe(400);
    });

    it("PUT updates smart list", async () => {
      const db = getTestDb();
      db.prepare("INSERT INTO smart_lists (id, name, filters) VALUES ('sl1', 'Old Name', '{\"state\":[\"CA\"]}')").run();

      const req = createRequest("PUT", "/api/v1/sales/smart-lists", {
        body: { id: "sl1", name: "New Name", filters: { state: ["NY"] } },
      });
      const res = await putSmartList(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data.name).toBe("New Name");
    });

    it("DELETE removes smart list", async () => {
      const db = getTestDb();
      db.prepare("INSERT INTO smart_lists (id, name, filters, is_default) VALUES ('sl1', 'Custom', '{}', 0)").run();

      const req = createRequest("DELETE", "/api/v1/sales/smart-lists", {
        body: { id: "sl1" },
      });
      const res = await deleteSmartList(req);
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);
    });

    it("DELETE refuses to remove default smart list", async () => {
      const db = getTestDb();
      db.prepare("INSERT INTO smart_lists (id, name, filters, is_default) VALUES ('sl-def', 'All Prospects', '{}', 1)").run();

      const req = createRequest("DELETE", "/api/v1/sales/smart-lists", {
        body: { id: "sl-def" },
      });
      const res = await deleteSmartList(req);
      expect(res.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════
  // DASHBOARD
  // ══════════════════════════════════════════
  describe("Dashboard", () => {
    beforeEach(() => { seedTestData(); seedDeals(); });

    it("GET returns aggregated stats", async () => {
      const res = await getDashboard();
      const { data } = await parseResponse<any>(res);
      expect(data.totalProspects).toBe(3);
      expect(data.outreachReady).toBe(1); // c1 has email and is qualified
      expect(data.icpABCount).toBe(2); // c1=A, c3=B
      expect(data.activeDeals).toBe(2); // d1 and d2 are not closed stages
      expect(data.pipelineValue).toBe(800); // 500 + 300
    });
  });
});
