/**
 * F3-007: Reply Inbox
 */
import { sqlite } from "@/lib/db";
import { ReplyInbox } from "@/modules/sales/components/reply-inbox";

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
}

async function getReplies() {
  return sqlite.prepare(`
    SELECT cl.id, cl.campaign_id, cl.company_id, cl.email, cl.status,
      cl.reply_text, cl.reply_classification, cl.replied_at, cl.created_at,
      cam.name as campaign_name,
      co.name as company_name,
      coalesce(ct.first_name || ' ' || ct.last_name, co.name) as contact_name
    FROM campaign_leads cl
    JOIN campaigns cam ON cam.id = cl.campaign_id
    LEFT JOIN companies co ON co.id = cl.company_id
    LEFT JOIN contacts ct ON ct.id = cl.contact_id
    WHERE cl.status = 'replied' AND cl.reply_text IS NOT NULL
    ORDER BY cl.replied_at DESC
    LIMIT 200
  `).all() as ReplyRow[];
}

export default async function InboxPage() {
  const replies = await getReplies();
  return <ReplyInbox replies={replies} />;
}
