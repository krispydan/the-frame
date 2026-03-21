export const dynamic = "force-dynamic";
/**
 * F3-007: Reply Inbox — fetches replied leads and auto-classifies unclassified ones
 */
import { sqlite } from "@/lib/db";
import { ReplyInbox } from "@/modules/sales/components/reply-inbox";
import { classifyAndUpdate } from "@/modules/sales/agents/response-classifier";

interface ReplyRow {
  id: string;
  campaign_id: string;
  campaign_name: string;
  company_id: string;
  company_name: string;
  contact_name: string;
  email: string | null;
  status: string;
  reply_text: string | null;
  reply_classification: string | null;
  replied_at: string | null;
  created_at: string;
  dismissed: number;
}

async function getReplies() {
  // Auto-classify any unclassified replies first
  const pending = sqlite.prepare(`
    SELECT id, reply_text FROM campaign_leads
    WHERE status = 'replied' AND reply_text IS NOT NULL AND reply_classification IS NULL
  `).all() as Array<{ id: string; reply_text: string }>;

  for (const lead of pending) {
    classifyAndUpdate(lead.id, lead.reply_text);
  }

  return sqlite.prepare(`
    SELECT cl.id, cl.campaign_id, cl.company_id, cl.email, cl.status,
      cl.reply_text, cl.reply_classification, cl.replied_at, cl.created_at,
      coalesce(cl.dismissed, 0) as dismissed,
      cam.name as campaign_name,
      co.name as company_name,
      coalesce(ct.first_name || ' ' || ct.last_name, co.name) as contact_name
    FROM campaign_leads cl
    JOIN campaigns cam ON cam.id = cl.campaign_id
    LEFT JOIN companies co ON co.id = cl.company_id
    LEFT JOIN contacts ct ON ct.id = cl.contact_id
    WHERE cl.status IN ('replied', 'opened') AND cl.reply_text IS NOT NULL
    ORDER BY cl.replied_at DESC
    LIMIT 200
  `).all() as ReplyRow[];
}

async function getUnreadCount() {
  const row = sqlite.prepare(`
    SELECT count(*) as cnt FROM campaign_leads
    WHERE status = 'replied' AND reply_text IS NOT NULL AND coalesce(dismissed, 0) = 0
  `).get() as { cnt: number };
  return row.cnt;
}

export default async function InboxPage() {
  const replies = await getReplies();
  const unreadCount = await getUnreadCount();
  return <ReplyInbox replies={replies} unreadCount={unreadCount} />;
}
