import { batchRead } from "./utils.js";

// ===== Modern CRM v4 Deal Activity Fetching =====
// Uses associations API (v4) + batch read (v3) — same proven pattern as fetchDealNotes.
// Replaces deprecated /engagements/v1/ and non-functional /integrations/v1/ endpoints.

export async function fetchDealEmails(hs, dealId) {
  try {
    console.log("[fetchDealEmails] fetching associations for deal %s...", dealId);
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/emails`);
    console.log("[fetchDealEmails] assoc response status=%s results=%s", assoc.status, JSON.stringify(assoc.data?.results?.length ?? "no results key"));

    const emailIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .slice(0, 20);

    console.log("[fetchDealEmails] found %d email IDs: %s", emailIds.length, emailIds.slice(0, 5).join(", "));
    if (!emailIds.length) return [];

    const emails = await batchRead(hs, "emails", emailIds, [
      "hs_email_subject",
      "hs_email_direction",
      "hs_email_status",
      "hs_email_text",
      "hs_email_html",
      "hs_timestamp",
      "hs_email_sender_email",
      "hs_email_to_email"
    ]);
    console.log("[fetchDealEmails] batch read returned %d emails", emails.length);
    if (emails.length) {
      const first = emails[0]?.properties;
      console.log("[fetchDealEmails] most recent: subject=%s ts=%s", first?.hs_email_subject, first?.hs_timestamp);
    }
    return emails.sort(
      (a, b) =>
        Number(new Date(b.properties?.hs_timestamp || 0)) -
        Number(new Date(a.properties?.hs_timestamp || 0))
    );
  } catch (err) {
    console.error("[fetchDealEmails] ERROR: %s (status=%s, data=%s)", err.message, err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 500));
    return [];
  }
}

export async function fetchDealCalls(hs, dealId) {
  try {
    console.log("[fetchDealCalls] fetching associations for deal %s...", dealId);
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/calls`);
    console.log("[fetchDealCalls] assoc response status=%s results=%s", assoc.status, assoc.data?.results?.length ?? "no results key");
    const callIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .slice(0, 20);

    console.log("[fetchDealCalls] found %d call IDs", callIds.length);
    if (!callIds.length) return [];

    const calls = await batchRead(hs, "calls", callIds, [
      "hs_call_title",
      "hs_call_body",
      "hs_call_direction",
      "hs_call_duration",
      "hs_call_disposition",
      "hs_call_status",
      "hs_timestamp"
    ]);
    console.log("[fetchDealCalls] batch read returned %d calls", calls.length);
    return calls.sort(
      (a, b) =>
        Number(new Date(b.properties?.hs_timestamp || 0)) -
        Number(new Date(a.properties?.hs_timestamp || 0))
    );
  } catch (err) {
    console.error("[fetchDealCalls] ERROR: %s (status=%s, data=%s)", err.message, err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 500));
    return [];
  }
}

export async function fetchDealMeetings(hs, dealId) {
  try {
    console.log("[fetchDealMeetings] fetching associations for deal %s...", dealId);
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/meetings`);
    console.log("[fetchDealMeetings] assoc response status=%s results=%s", assoc.status, assoc.data?.results?.length ?? "no results key");
    const meetingIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .slice(0, 20);

    console.log("[fetchDealMeetings] found %d meeting IDs", meetingIds.length);
    if (!meetingIds.length) return [];

    const meetings = await batchRead(hs, "meetings", meetingIds, [
      "hs_meeting_title",
      "hs_meeting_body",
      "hs_meeting_start_time",
      "hs_meeting_end_time",
      "hs_meeting_outcome",
      "hs_timestamp"
    ]);
    console.log("[fetchDealMeetings] batch read returned %d meetings", meetings.length);
    return meetings.sort(
      (a, b) =>
        Number(new Date(b.properties?.hs_timestamp || 0)) -
        Number(new Date(a.properties?.hs_timestamp || 0))
    );
  } catch (err) {
    console.error("[fetchDealMeetings] ERROR: %s (status=%s, data=%s)", err.message, err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 500));
    return [];
  }
}

export async function fetchDealNotes(hs, dealId) {
  try {
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/notes`);
    const noteIds = (assoc.data?.results || []).map((r) => r.toObjectId).filter(Boolean).slice(0, 20);

    if (!noteIds.length) return [];

    const notes = await batchRead(hs, "notes", noteIds, ["hs_note_body", "hs_createdate", "hubspot_owner_id"]);
    return notes.sort(
      (a, b) => Number(new Date(b.properties?.hs_createdate || 0)) - Number(new Date(a.properties?.hs_createdate || 0))
    );
  } catch (err) {
    console.error("Error fetching notes:", err.message);
    return [];
  }
}

// ===== Keyword-Based Data Requirements =====

export function determineRequiredData(question, dealData) {
  const q = question.toLowerCase();
  const required = {
    emails: true,     // Always fetch — most commonly asked about
    notes: true,      // Always fetch — most commonly asked about
    calls: false,
    meetings: false,
    contacts: true,
    companies: true
  };

  // Broad triggers for calls and meetings
  const activityTriggers =
    q.includes("call") ||
    q.includes("called") ||
    q.includes("phone") ||
    q.includes("spoke") ||
    q.includes("spoken") ||
    q.includes("conversation") ||
    q.includes("meet") ||
    q.includes("meeting") ||
    q.includes("demo") ||
    q.includes("schedule") ||
    q.includes("calendar") ||
    q.includes("activity") ||
    q.includes("timeline") ||
    q.includes("history") ||
    q.includes("recent") ||
    q.includes("latest") ||
    q.includes("update") ||
    q.includes("status") ||
    q.includes("happen") ||
    q.includes("touch") ||
    q.includes("communicat") ||
    q.includes("engag") ||
    q.includes("interact") ||
    q.includes("outreach") ||
    q.includes("last") ||
    q.includes("summary") ||
    q.includes("overview") ||
    q.includes("what's going on") ||
    q.includes("whats going on");

  if (activityTriggers) {
    required.calls = true;
    required.meetings = true;
  }

  return required;
}

// ===== Unified Timeline Formatter =====

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function formatTimelineForPrompt(emails, calls, meetings, notes) {
  const items = [];

  for (const e of (emails || [])) {
    const p = e.properties || {};
    const date = p.hs_timestamp
      ? new Date(p.hs_timestamp).toISOString().split("T")[0]
      : "unknown date";
    const direction = p.hs_email_direction === "INCOMING_EMAIL" ? "Received" : "Sent";
    const subject = p.hs_email_subject || "No subject";
    const from = p.hs_email_sender_email || "";
    const to = p.hs_email_to_email || "";
    const body = (p.hs_email_text || stripHtml(p.hs_email_html) || "").replace(/\s+/g, " ").trim();
    const snippet = body ? `: ${body.substring(0, 200)}` : "";
    items.push({
      timestamp: p.hs_timestamp || "0",
      line: `- EMAIL (${direction}) on ${date} — Subject: "${subject}"${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}${snippet}`
    });
  }

  for (const c of (calls || [])) {
    const p = c.properties || {};
    const date = p.hs_timestamp
      ? new Date(p.hs_timestamp).toISOString().split("T")[0]
      : "unknown date";
    const title = p.hs_call_title || "Call";
    const direction = p.hs_call_direction === "INBOUND" ? "Inbound" : "Outbound";
    const duration = p.hs_call_duration
      ? `${Math.round(Number(p.hs_call_duration) / 1000 / 60)}min`
      : "";
    const disposition = p.hs_call_disposition || "";
    const body = (p.hs_call_body || "").replace(/\s+/g, " ").trim();
    const snippet = body ? `: ${body.substring(0, 200)}` : "";
    items.push({
      timestamp: p.hs_timestamp || "0",
      line: `- CALL (${direction}) on ${date} — ${title}${duration ? `, ${duration}` : ""}${disposition ? ` [${disposition}]` : ""}${snippet}`
    });
  }

  for (const m of (meetings || [])) {
    const p = m.properties || {};
    const date = p.hs_timestamp
      ? new Date(p.hs_timestamp).toISOString().split("T")[0]
      : "unknown date";
    const title = p.hs_meeting_title || "Meeting";
    const outcome = p.hs_meeting_outcome || "";
    const body = (p.hs_meeting_body || "").replace(/\s+/g, " ").trim();
    const snippet = body ? `: ${stripHtml(body).substring(0, 200)}` : "";
    items.push({
      timestamp: p.hs_timestamp || "0",
      line: `- MEETING on ${date} — ${title}${outcome ? ` [${outcome}]` : ""}${snippet}`
    });
  }

  for (const n of (notes || [])) {
    const p = n.properties || {};
    const date = p.hs_createdate
      ? new Date(p.hs_createdate).toISOString().split("T")[0]
      : "unknown date";
    const body = stripHtml(p.hs_note_body || "").replace(/\s+/g, " ").trim();
    items.push({
      timestamp: p.hs_createdate || "0",
      line: `- NOTE on ${date}: ${body.substring(0, 300)}`
    });
  }

  if (!items.length) return "No activity found in HubSpot.";

  // Sort descending by timestamp (most recent first)
  items.sort(
    (a, b) => Number(new Date(b.timestamp)) - Number(new Date(a.timestamp))
  );

  return items.slice(0, 25).map((i) => i.line).join("\n");
}
