// morning-briefing Edge Function
// Aggregates last 24h of household sensor data, sleep/readiness,
// iMessages (with contact names, mute filter applied), and Gmail
// (with mute filter, per-account context, Gmail's own categorization
// used to drop noise).
//
// Output is a JSON digest consumed by an external script that formats
// it with Claude. This function does NOT call Claude itself.
//
// v34 (2026-07-17): gmail direction support.
//   - `threads` is now INBOUND-ONLY and keeps its existing shape, so
//     api/digest.js (briefing.gmail.accounts[].threads) is unaffected
//     once sent mail begins syncing.
//   - New sibling `conversations` groups by thread_id and mirrors the
//     imessages shape (last_message_from_me / last_inbound_at /
//     last_outbound_at) for reply-suppression logic.
//   - Direction is derived from the SENT label; no schema/view change.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ACCOUNT_CONTEXT: Record<string, string> = {
  "vramdon@gmail.com":              "personal",
  "goodnewsentbooking@gmail.com":   "gne_business",
  "vijay.ramdon@serveants.com":     "serveants_professional",
};

const GMAIL_NOISE_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
]);

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const [
      airRes,
      sleepRes,
      readinessRes,
      nestRes,
      contextRes,
      imessagesRes,
      gmailRes,
    ] = await Promise.all([
      supabase
        .from("air_readings")
        .select("recorded_at, co2, humidity, temp_c, voc, pm1, pm25, radon_bq_m3, radon_pci_l")
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true }),
      supabase
        .from("oura_sleep")
        .select("day, score, deep_sleep, efficiency, latency, rem_sleep, restfulness, timing, total_sleep, recorded_at")
        .order("day", { ascending: false })
        .limit(2),
      supabase
        .from("oura_readiness")
        .select("*")
        .order("day", { ascending: false })
        .limit(2),
      supabase
        .from("nest_readings")
        .select("recorded_at, temp_c, temp_f, humidity, hvac_status, thermostat_mode, setpoint_cool_c, setpoint_cool_f, fan_mode")
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true }),
      supabase.from("household_context").select("key, value"),

      supabase
        .from("imessage_messages_filtered")
        .select("sender, resolved_name, sender_relationship, text, received_at, is_from_me")
        .gte("received_at", since)
        .order("received_at", { ascending: true }),

      supabase
        .from("gmail_messages_filtered")
        .select("account, gmail_id, from_address, from_name, sender_known_name, sender_relationship, subject, snippet, body_text, received_at, labels, thread_id")
        .gte("received_at", since)
        .order("received_at", { ascending: true }),
    ]);

    const errors = [airRes, sleepRes, readinessRes, nestRes, contextRes, imessagesRes, gmailRes]
      .map((r, i) => r.error ? { source: ["air", "sleep", "readiness", "nest", "context", "imessages", "gmail"][i], err: r.error.message } : null)
      .filter(Boolean);

    if (errors.length) {
      return new Response(JSON.stringify({ ok: false, errors }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const context: Record<string, string> = {};
    for (const row of contextRes.data || []) {
      context[row.key] = row.value;
    }

    let pregnancyWeek: number | null = null;
    let weeksUntilDue: number | null = null;
    if (context.mia_due_date) {
      const dueDate = new Date(context.mia_due_date);
      const conceptionDate = new Date(dueDate.getTime() - 280 * 24 * 60 * 60 * 1000);
      const daysSinceConception = (now.getTime() - conceptionDate.getTime()) / (24 * 60 * 60 * 1000);
      pregnancyWeek = Math.floor(daysSinceConception / 7);
      weeksUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000));
    }

    const airReadings = airRes.data || [];
    const air = airReadings.length === 0 ? null : {
      reading_count: airReadings.length,
      latest_recorded_at: airReadings[airReadings.length - 1].recorded_at,
      co2: agg(airReadings, "co2"),
      humidity: agg(airReadings, "humidity"),
      temp_c: agg(airReadings, "temp_c"),
      voc: agg(airReadings, "voc"),
      pm25: agg(airReadings, "pm25"),
      radon_bq_m3: agg(airReadings, "radon_bq_m3"),
      anomalies: detectAirAnomalies(airReadings),
    };

    const latestSleep = sleepRes.data?.[0] || null;
    const latestReadiness = readinessRes.data?.[0] || null;

    const nestReadings = nestRes.data || [];
    const nest = nestReadings.length === 0 ? null : {
      reading_count: nestReadings.length,
      latest: nestReadings[nestReadings.length - 1],
      temp_f: agg(nestReadings, "temp_f"),
      humidity: agg(nestReadings, "humidity"),
      hvac_status_distribution: countBy(nestReadings, "hvac_status"),
      anomalies: detectNestAnomalies(nestReadings),
    };

    const imessageRows = imessagesRes.data || [];
    const imessageBySender = groupBy(imessageRows, (r) => r.sender);
    const imessages = {
      total_count: imessageRows.length,
      unique_senders: Object.keys(imessageBySender).length,
 threads: Object.entries(imessageBySender).map(([sender, msgs]) => {
        const inbound = msgs.filter((m) => !m.is_from_me);
        const outbound = msgs.filter((m) => m.is_from_me);
        const lastMsg = msgs[msgs.length - 1];
        return {
          sender,
          resolved_name: msgs[0].resolved_name,
          relationship: msgs[0].sender_relationship,
          message_count: msgs.length,
          first_at: msgs[0].received_at,
          last_at: lastMsg.received_at,
          last_message_from_me: !!lastMsg.is_from_me,
          last_inbound_at: inbound.length ? inbound[inbound.length - 1].received_at : null,
          last_outbound_at: outbound.length ? outbound[outbound.length - 1].received_at : null,
          messages: msgs.slice(-5).map((m) => ({
            received_at: m.received_at,
            from_me: !!m.is_from_me,
            text: (m.text || "").slice(0, 500),
          })),
          truncated: msgs.length > 5,
        };
      }),
    };

    const gmailRowsAll = gmailRes.data || [];
    const gmailRows = gmailRowsAll.filter((r) => {
      const labels: string[] = r.labels || [];
      return !labels.some((l) => GMAIL_NOISE_LABELS.has(l));
    });
    const gmailByAccount = groupBy(gmailRows, (r) => r.account);
    const gmailNoiseDropped = gmailRowsAll.length - gmailRows.length;

    const isSent = (m: any) => (m.labels || []).includes("SENT");

    const gmail = {
      total_count: gmailRows.length,
      noise_dropped: gmailNoiseDropped,
      accounts: Object.entries(gmailByAccount).map(([account, msgs]) => {
        const inbound = msgs.filter((m) => !isSent(m));
        const byThread = groupBy(msgs, (m) => m.thread_id);
        return {
          account,
          context: ACCOUNT_CONTEXT[account] || "unknown",
          account_note: ACCOUNT_CONTEXT[account] ? undefined : `unmapped account: ${account}`,
          message_count: inbound.length,
          unread_count: inbound.filter((m) => (m.labels || []).includes("UNREAD")).length,
          sent_count: msgs.length - inbound.length,
          threads: inbound.map((m) => ({
            received_at: m.received_at,
            from_address: m.from_address,
            from_name: m.sender_known_name || m.from_name,
            known_relationship: m.sender_relationship,
            subject: m.subject,
            snippet: m.snippet,
            unread: (m.labels || []).includes("UNREAD"),
          })),
          conversations: Object.entries(byThread).map(([thread_id, tmsgs]) => {
            const tIn = tmsgs.filter((m) => !isSent(m));
            const tOut = tmsgs.filter((m) => isSent(m));
            const last = tmsgs[tmsgs.length - 1];
            return {
              thread_id,
              subject: tmsgs[0].subject,
              counterparty: tIn[0]?.from_address ?? null,
              message_count: tmsgs.length,
              last_at: last.received_at,
              last_message_from_me: isSent(last),
              last_inbound_at: tIn.length ? tIn[tIn.length - 1].received_at : null,
              last_outbound_at: tOut.length ? tOut[tOut.length - 1].received_at : null,
              messages: tmsgs.slice(-5).map((m) => ({
                received_at: m.received_at,
                from_me: isSent(m),
                from_address: m.from_address,
                text: (m.body_text || m.snippet || "").slice(0, 500),
              })),
              truncated: tmsgs.length > 5,
            };
          }),
        };
      }),
    };

    const digest = {
      generated_at: now.toISOString(),
      window: { start: since, end: now.toISOString() },
      household: {
        mia_due_date: context.mia_due_date || null,
        pregnancy_week: pregnancyWeek,
        weeks_until_due: weeksUntilDue,
        mia_name: context.mia_name || "Mia",
        location: context.location || null,
      },
      air,
      sleep: latestSleep,
      readiness: latestReadiness,
      nest,
      imessages,
      gmail,
    };

    return new Response(JSON.stringify(digest, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ---------- Helpers ----------

function agg(rows: any[], field: string) {
  const vals = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  return {
    current: vals[vals.length - 1],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
  };
}

function countBy(rows: any[], field: string) {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const k = r[field] || "unknown";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function groupBy<T>(rows: T[], keyFn: (r: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const k = keyFn(r);
    (out[k] = out[k] || []).push(r);
  }
  return out;
}

function detectAirAnomalies(rows: any[]): string[] {
  const a: string[] = [];
  const lastCo2 = rows[rows.length - 1]?.co2;
  const maxCo2 = Math.max(...rows.map((r) => r.co2 || 0));
  const lastHumidity = rows[rows.length - 1]?.humidity;
  const maxHumidity = Math.max(...rows.map((r) => r.humidity || 0));
  const maxRadon = Math.max(...rows.map((r) => r.radon_bq_m3 || 0));

  if (maxCo2 >= 1200) a.push(`co2_high: peaked at ${maxCo2} ppm in last 24h`);
  else if (lastCo2 >= 1000) a.push(`co2_elevated: currently ${lastCo2} ppm`);

  if (maxHumidity >= 65) a.push(`humidity_high: peaked at ${maxHumidity}% in last 24h`);
  if (lastHumidity >= 60) a.push(`humidity_elevated: currently ${lastHumidity}%`);

  if (maxRadon >= 100) a.push(`radon_action_threshold: peaked at ${maxRadon} Bq/m³`);
  return a;
}

function detectNestAnomalies(rows: any[]): string[] {
  const a: string[] = [];
  const last = rows[rows.length - 1];
  if (last?.humidity >= 60) a.push(`nest_humidity_high: ${last.humidity}%`);
  if ((last?.hvac_status || "").toUpperCase() === "OFF" && last?.humidity >= 65) {
    a.push(`hvac_off_with_high_humidity: consider running fan or AC`);
  }
  return a;
}
