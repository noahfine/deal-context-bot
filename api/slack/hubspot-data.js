import axios from "axios";
import { batchRead } from "./utils.js";

const HUBSPOT_TIMEOUT_MS = 10000;

// ===== On-Demand HubSpot Data Fetching =====

export async function fetchDealEngagements(hs, dealId) {
  try {
    // Fetch engagements associated with the deal
    const resp = await hs.get(`/engagements/v1/engagements/associated/deal/${dealId}/paged`, {
      params: { limit: 50 }
    });
    return resp.data?.results || [];
  } catch (err) {
    console.error("Error fetching engagements:", err.message);
    return [];
  }
}

export async function fetchDealActivities(hs, dealId) {
  try {
    // Fetch timeline activities for the deal
    const resp = await hs.get(`/integrations/v1/${dealId}/timeline/events`, {
      params: { limit: 50 }
    });
    return resp.data || [];
  } catch (err) {
    console.error("Error fetching activities:", err.message);
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


export function determineRequiredData(question, dealData) {
  const q = question.toLowerCase();
  const required = {
    engagements: false,
    activities: false,
    notes: false,
    contacts: true, // Always fetch contacts
    companies: true // Always fetch companies
  };

  // Check for keywords that indicate what data to fetch
  if (
    q.includes("contact") ||
    q.includes("email") ||
    q.includes("emailed") ||
    q.includes("call") ||
    q.includes("called") ||
    q.includes("meeting") ||
    q.includes("meet") ||
    q.includes("last person") ||
    q.includes("who") ||
    q.includes("communicat")
  ) {
    required.engagements = true;
  }

  if (q.includes("activity") || q.includes("timeline") || q.includes("history") || q.includes("recent")) {
    required.activities = true;
  }

  if (q.includes("note") || q.includes("comment") || q.includes("remark")) {
    required.notes = true;
  }

  return required;
}

export function formatEngagementsForPrompt(engagements) {
  if (!engagements.length) return "No engagements found in HubSpot.";

  const formatted = engagements
    .slice(0, 20)
    .map((eng) => {
      const type = eng.engagement?.type || "unknown";
      const createdAt = eng.engagement?.createdAt ? new Date(eng.engagement.createdAt).toISOString().split("T")[0] : "unknown date";
      const metadata = eng.engagement?.metadata || {};
      let details = "";

      if (type === "EMAIL") {
        details = `Subject: ${metadata.subject || "No subject"}`;
      } else if (type === "CALL") {
        details = `Duration: ${metadata.duration || "unknown"}`;
      } else if (type === "MEETING") {
        details = `Title: ${metadata.title || "No title"}`;
      } else if (type === "NOTE") {
        details = `Body: ${(metadata.body || "").substring(0, 200)}`;
      }

      return `- ${type} on ${createdAt}${details ? ` - ${details}` : ""}`;
    })
    .join("\n");

  return formatted;
}

export function formatActivitiesForPrompt(activities) {
  if (!activities || !activities.length) return "No activities found in HubSpot.";
  return JSON.stringify(activities.slice(0, 20), null, 2);
}

export function formatNotesForPrompt(notes) {
  if (!notes.length) return "No notes found in HubSpot.";

  return notes
    .slice(0, 10)
    .map((n) => {
      const body = (n.properties?.hs_note_body || "").replace(/\s+/g, " ").trim();
      const date = n.properties?.hs_createdate
        ? new Date(n.properties.hs_createdate).toISOString().split("T")[0]
        : "unknown date";
      return `- ${date}: ${body.substring(0, 300)}`;
    })
    .join("\n");
}
