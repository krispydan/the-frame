/**
 * Seed the first three sequences, in Christina's voice (taken from her real
 * sends — see docs/outreach-sequence-engine.md §4).
 *
 * All steps are REVIEW mode and all auto-enrollment starts PROPOSE-ONLY: the
 * engine will show what it would have done for a couple of weeks before it is
 * allowed to actually do it. Idempotent — re-running updates copy in place
 * rather than creating duplicates.
 */

import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";

interface SeedStep {
  step_no: number; delay_days: number; channel: string; send_mode: string;
  body: string; attachment_key?: string; offer_code?: string; task_note?: string;
}
interface SeedSequence {
  key: string; name: string; brand: string; trigger: string; class: string;
  priority: number; description: string; enrollment_mode: string; steps: SeedStep[];
}

const SIGNOFF = "\n\nThanks again,\nChristina\nJaxy Eyewear";

export const SEQUENCES: SeedSequence[] = [
  {
    key: "t0-welcome",
    name: "New account welcome",
    brand: "jaxy",
    trigger: "T0",
    class: "relationship",
    priority: 100,
    enrollment_mode: "auto",
    description: "First order placed. Personal introduction from Christina. Always reviewed.",
    steps: [
      {
        step_no: 1, delay_days: 0, channel: "faire", send_mode: "review",
        attachment_key: "outreach/christina-photo",
        body:
          "Hi {first_name},\n\nHope you are doing great! I am Christina and I will be your rep here at Jaxy Eyewear. " +
          "Thank you so much for your first order, it is being processed now. I am based in Los Angeles, born and raised here, " +
          "and I have been in the eyewear business for over 30 years! Please let me know any time if you would like product " +
          "suggestions, help with what will sell best in your shop, or if you just want to talk sunglasses." + SIGNOFF,
      },
    ],
  },
  {
    key: "t4-review",
    name: "Review request",
    brand: "jaxy",
    trigger: "T4",
    class: "relationship",
    priority: 90,
    enrollment_mode: "auto",
    description: "Delivery + 3 days (ship + 8 when delivery is unknown). Asks about the order before asking for the review.",
    steps: [
      {
        step_no: 1, delay_days: 0, channel: "faire", send_mode: "review",
        body:
          "Hi {first_name},\n\nHope you are doing great! I just wanted to check that everything arrived the way it should " +
          "with your order. If anything was not right, please let me know and I will take care of it. If everything looked good, " +
          "would you mind leaving us a review? Reviews make a big difference for a small brand like ours, and it only takes a minute!" + SIGNOFF,
      },
    ],
  },
  {
    key: "t1-fillin",
    name: "Fill-in due",
    brand: "jaxy",
    trigger: "T1",
    class: "nudge",
    priority: 70,
    enrollment_mode: "auto",
    description: "Five days before their predicted reorder date. Three touches, then it rests until next season.",
    steps: [
      {
        step_no: 1, delay_days: 0, channel: "faire", send_mode: "review",
        attachment_key: "outreach/linesheet",
        body:
          "Hi {first_name},\n\nHope you are doing great! I just wanted to check in and see if you needed any Sunglass fill-ins yet? " +
          "We also have some NEW styles coming soon, as well as READERS! Please let me know if you would like more details or a fill-in order." + SIGNOFF,
      },
      {
        step_no: 2, delay_days: 7, channel: "faire", send_mode: "review",
        body:
          "Hi {first_name},\n\nHope you are doing great! Just circling back to see if you would like me to put together a fill-in order for you? " +
          "I am happy to send over more details on best-sellers or shipping." + SIGNOFF,
      },
      {
        step_no: 3, delay_days: 21, channel: "faire", send_mode: "review",
        body:
          "Hi {first_name},\n\nHope you are doing great! This is my last check-in on fill-ins for now. If the timing is not right, " +
          "no problem at all and I will reach out again next season. Please let me know any time if you would like a linesheet or " +
          "details on our NEW styles." + SIGNOFF,
      },
    ],
  },
  {
    key: "t5-sellthrough",
    name: "Sell-through check-in",
    brand: "jaxy",
    trigger: "T5",
    class: "relationship",
    priority: 40,
    enrollment_mode: "manual",
    description: "Six weeks after delivery — long enough that 'how is it selling' has a real answer.",
    steps: [
      {
        step_no: 1, delay_days: 0, channel: "faire", send_mode: "review",
        attachment_key: "outreach/display-guide",
        body:
          "Hi {first_name},\n\nHope you are doing great! You have had the sunglasses on the floor about six weeks now, how is it selling? " +
          "If anything is sitting, please let me know and I can suggest a swap or send over display ideas, sometimes it is just placement. " +
          "And if something is flying, I would love to know so I can flag it for you before it sells out." + SIGNOFF,
      },
    ],
  },
  {
    key: "t6-winback",
    name: "Lapsed win-back",
    brand: "jaxy",
    trigger: "T6",
    class: "nudge",
    priority: 50,
    enrollment_mode: "manual",
    description: "Past 1.5x their normal reorder gap. Asks what happened rather than assuming.",
    steps: [
      {
        step_no: 1, delay_days: 0, channel: "faire", send_mode: "review",
        attachment_key: "outreach/linesheet",
        body:
          "Hi {first_name},\n\nHope you are doing great! It has been a while since your last order and I wanted to check in rather than assume. " +
          "If the sunglasses did not move the way you hoped, I would really like to know. If they did and it just slipped by, " +
          "I am happy to rebuild your last order for you, and we have NEW styles and READERS since you last ordered!" + SIGNOFF,
      },
      {
        step_no: 2, delay_days: 10, channel: "call", send_mode: "task",
        task_note: "Follow up on the win-back message. Ask what changed, and whether a smaller opening order would work.",
        body: "Call: lapsed account follow-up. Ask what changed; offer to rebuild their last order.",
      },
    ],
  },
  {
    key: "t2-campaign",
    name: "Campaign / market push",
    brand: "jaxy",
    trigger: "T2",
    class: "nudge",
    priority: 30,
    enrollment_mode: "manual",
    description: "Manual or segment enrollment for a market, drop or promo. One send plus a reminder.",
    steps: [
      {
        step_no: 1, delay_days: 0, channel: "faire", send_mode: "review",
        attachment_key: "outreach/linesheet",
        body:
          "Hi {first_name},\n\nHope you are doing great! I wanted to make sure you saw what we have running right now. " +
          "I am attaching our linesheet, and please let me know if you would like more details or a fill-in order." + SIGNOFF,
      },
      {
        step_no: 2, delay_days: 5, channel: "faire", send_mode: "review",
        body:
          "Hi {first_name},\n\nHope you are doing great! Just a quick reminder before this one closes. " +
          "Please let me know if you would like me to put an order together for you." + SIGNOFF,
      },
    ],
  },
];

export function seedSequences(): { created: number; updated: number; steps: number } {
  let created = 0, updated = 0, steps = 0;
  for (const s of SEQUENCES) {
    // Match on the stable seed_key, falling back to name for rows seeded before
    // the key existed. Renaming in the UI must not spawn a rival sequence.
    const existing = (sqlite.prepare("SELECT id FROM sequences WHERE seed_key = ?").get(s.key)
      || sqlite.prepare("SELECT id FROM sequences WHERE seed_key IS NULL AND name = ?").get(s.name)) as { id: string } | undefined;
    let id = existing?.id;
    if (id) {
      sqlite
        .prepare(
          `UPDATE sequences SET seed_key=?, brand=?, trigger=?, class=?, priority=?, description=?,
                  enrollment_mode=?, updated_at=? WHERE id=?`,
        )
        .run(s.key, s.brand, s.trigger, s.class, s.priority, s.description, s.enrollment_mode, new Date().toISOString(), id);
      updated++;
    } else {
      id = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO sequences (id, seed_key, name, brand, trigger, class, status, enrollment_mode,
                                  propose_only, priority, max_touches, description)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?)`,
        )
        .run(id, s.key, s.name, s.brand, s.trigger, s.class, s.enrollment_mode, s.priority, s.steps.length, s.description);
      created++;
    }
    for (const st of s.steps) {
      const ex = sqlite
        .prepare("SELECT id FROM sequence_steps WHERE sequence_id=? AND step_no=?")
        .get(id, st.step_no) as { id: string } | undefined;
      if (ex) {
        sqlite
          .prepare(
            `UPDATE sequence_steps SET delay_days=?, channel=?, send_mode=?, template_body=?,
                    attachment_key=?, offer_code=?, task_note=? WHERE id=?`,
          )
          .run(st.delay_days, st.channel, st.send_mode, st.body, st.attachment_key ?? null,
               st.offer_code ?? null, st.task_note ?? null, ex.id);
      } else {
        sqlite
          .prepare(
            `INSERT INTO sequence_steps (id, sequence_id, step_no, delay_days, channel, send_mode,
                                         template_body, attachment_key, offer_code, task_note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), id, st.step_no, st.delay_days, st.channel, st.send_mode, st.body,
               st.attachment_key ?? null, st.offer_code ?? null, st.task_note ?? null);
      }
      steps++;
    }
  }
  return { created, updated, steps };
}
