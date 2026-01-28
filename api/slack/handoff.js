import crypto from "crypto";
import axios from "axios";
import Redis from "ioredis";
import { getSlackChannelName, slackPost, channelNameToDealQuery } from "./utils.js";

const SLACK_TIMEOUT_MS = 2500;
const HUBSPOT_TIMEOUT_MS = 10000;
const OPENAI_TIMEOUT_MS = 20000;

const redisUrl = process.env.deal_summarizer_bot_REDIS_URL;
if (!redisUrl) throw new Error("Missing deal_summarizer_bot_REDIS_URL environment variable");
const redis = new Redis(redisUrl, { connectTimeout: 10000, maxRetriesPerRequest: 2, enableReadyCheck: true });

function verifySlackRequest(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const fiveMinutes = 60 * 5;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > fiveMinutes) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const mySig =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(sigBase, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function postToResponseUrl(responseUrl, text, replaceOriginal = false) {
  if (!responseUrl) return;
  await axios.post(
    responseUrl,
    { text, replace_original: replaceOriginal },
    { headers: { "Content-Type": "application/json" }, timeout: SLACK_TIMEOUT_MS }
  );
}

async function hubspotTokenExchange(form) {
  const resp = await axios.post("https://api.hubapi.com/oauth/v1/token", form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: HUBSPOT_TIMEOUT_MS
  });
  return resp.data;
}

async function getHubSpotAccessToken() {
  const access = await redis.get("hubspot:access_token");
  const refresh = await redis.get("hubspot:refresh_token");
  const expiresAtMsStr = await redis.get("hubspot:expires_at_ms");
  const expiresAtMs = expiresAtMsStr ? Number(expiresAtMsStr) : 0;

  if (!refresh) throw new Error("HubSpot not connected: missing refresh token in Redis");

  const now = Date.now();
  const bufferMs = 60 * 1000; // refresh 60s early
  if (access && expiresAtMs && now < expiresAtMs - bufferMs) return access;

  // Refresh
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", process.env.HUBSPOT_CLIENT_ID);
  form.set("client_secret", process.env.HUBSPOT_CLIENT_SECRET);
  form.set("refresh_token", refresh);

  const data = await hubspotTokenExchange(form);
  const newAccess = data.access_token;
  const expiresIn = Number(data.expires_in || 0);
  const newExpiresAt = Date.now() + expiresIn * 1000;

  await redis.set("hubspot:access_token", newAccess);
  await redis.set("hubspot:expires_at_ms", String(newExpiresAt));

  return newAccess;
}

function hubspotClient(accessToken) {
  return axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: HUBSPOT_TIMEOUT_MS
  });
}

async function findBestDeal(hs, dealQuery) {
  // Search deals by name. We'll bias toward Closed Won + most recent closedate.
  // Endpoint: POST /crm/v3/objects/deals/search
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: dealQuery }
        ]
      }
    ],
    properties: ["dealname", "createdate", "closedate", "dealstage", "pipeline", "hubspot_owner_id"],
    limit: 10
  };

  const resp = await hs.post("/crm/v3/objects/deals/search", body);
  const results = resp.data?.results || [];
  if (!results.length) return null;

  // prefer closed won if we can detect it by stage label isn't available here.
  // We'll just pick the one with the most recent closedate if present.
  results.sort((a, b) => {
    const ac = a.properties?.closedate ? Number(new Date(a.properties.closedate)) : 0;
    const bc = b.properties?.closedate ? Number(new Date(b.properties.closedate)) : 0;
    return bc - ac;
  });

  return results[0];
}

async function getDealAssociations(hs, dealId) {
  // Grab associated contacts + company ids
  const [contacts, companies] = await Promise.allSettled([
    hs.get(`/crm/v4/objects/deals/${dealId}/associations/contacts`),
    hs.get(`/crm/v4/objects/deals/${dealId}/associations/companies`)
  ]);

  const contactIds =
    contacts.status === "fulfilled"
      ? (contacts.value.data?.results || []).map((r) => r.toObjectId).filter(Boolean)
      : [];

  const companyIds =
    companies.status === "fulfilled"
      ? (companies.value.data?.results || []).map((r) => r.toObjectId).filter(Boolean)
      : [];

  return { contactIds, companyIds };
}

async function batchRead(hs, objectType, ids, properties) {
  if (!ids.length) return [];
  const resp = await hs.post(`/crm/v3/objects/${objectType}/batch/read`, {
    inputs: ids.slice(0, 50).map((id) => ({ id })),
    properties
  });
  return resp.data?.results || [];
}

async function resolveOwnerName(hs, ownerId) {
  if (!ownerId) return null;
  try {
    const resp = await hs.get(`/crm/v3/owners/${ownerId}`);
    const o = resp.data;
    const name = [o?.firstName, o?.lastName].filter(Boolean).join(" ").trim();
    return name || null;
  } catch {
    return null;
  }
}

function daysBetweenISO(a, b) {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (!da || !db) return null;
  const diff = Math.round((db - da) / (1000 * 60 * 60 * 24));
  return diff;
}

async function callOpenAI(promptText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Using Responses API
  const resp = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-4.1-mini",
      input: promptText
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: OPENAI_TIMEOUT_MS
    }
  );

  // Extract text
  const output = resp.data?.output || [];
  const text = output
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text;
}

function buildPromptFromHubSpotData({ dealName, hubspotDealUrl, ownerLine, created, closed, cycleDays, contactsLine, notesSummary }) {
  /* ===== MANUAL INPUT REQUIRED HERE =====
     Paste your production prompt template (system+user rules) into this string,
     but DO NOT include “Find the HubSpot deal named ...” as an instruction.
     Instead, we provide the deal context directly below.

     You can paste your text exactly and just change the first sentence to:
     "Using the HubSpot data below for deal {dealName}, produce exactly 3–5 bullets..."
  ====================================== */

  const instructions = `
You are generating a post-sales handoff summary for a project Slack channel. Be concise, factual, and write like a salesperson giving a short verbal handoff to Deployments and Customer Success.

Using the HubSpot data below for deal "${dealName}", produce exactly 3–5 bullets that cover the KEY deployment/CSM points. Use Slack mrkdwn or plain text bullets only.

Rules:
- Return exactly 3 to 5 bullet lines only. Each bullet must be 1–2 sentences. No raw JSON or field dumps.
- Do not invent facts. If something is not present or clear, write: Not observed in HubSpot history.

HubSpot data:
- Deal: ${dealName}
- Deal link: ${hubspotDealUrl}
- Sales owner: ${ownerLine}
- Created/Closed: ${created || "Not observed in HubSpot history"} / ${closed || "Not observed in HubSpot history"}${
    cycleDays != null ? ` — ${cycleDays} days` : ""
  }
- Contacts: ${contactsLine}
- Notes / recent activity summary: ${notesSummary}
`.trim();

  return instructions;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await readRawBody(req);

  if (!process.env.SLACK_SIGNING_SECRET) {
    return res.status(500).send("Missing SLACK_SIGNING_SECRET");
  }

  if (!verifySlackRequest(req, rawBody)) {
    return res.status(401).send("Invalid signature");
  }

  const payload = Object.fromEntries(new URLSearchParams(rawBody));
  const channel_id = payload.channel_id;
  const team_id = payload.team_id;
  const response_url = payload.response_url;

  // Respond within 3 seconds or Slack shows "operation_timeout"
  res.status(200).json({
    response_type: "ephemeral",
    text: "Generating deal summary... (this may take a moment)"
  });

  // Await work so the serverless function stays alive; then post result via response_url
  try {
    const channelName = await getSlackChannelName(channel_id);
    const dealQuery = channelNameToDealQuery(channelName);

    const accessToken = await getHubSpotAccessToken();
    const hs = hubspotClient(accessToken);

    const deal = await findBestDeal(hs, dealQuery);
    if (!deal) {
      await postToResponseUrl(response_url, `No HubSpot deal found matching "${dealQuery}".`);
      return;
    }

    const dealId = deal.id;
    const dealName = deal.properties?.dealname || dealQuery;
    const created = deal.properties?.createdate || null;
    const closed = deal.properties?.closedate || null;
    const cycleDays = daysBetweenISO(created, closed);

    const ownerId = deal.properties?.hubspot_owner_id || null;
    const ownerName = await resolveOwnerName(hs, ownerId);
    const ownerLine = ownerName ? `${ownerName} (Sales)` : (ownerId ? `${ownerId} (name not found in HubSpot)` : "Not observed in HubSpot history");

    const { contactIds, companyIds } = await getDealAssociations(hs, dealId);

    const contacts = await batchRead(hs, "contacts", contactIds, ["firstname", "lastname", "jobtitle", "email"]);
    const companies = await batchRead(hs, "companies", companyIds, ["name", "domain"]);

    const contactsLine = contacts.length
      ? contacts
          .slice(0, 6)
          .map((c) => {
            const p = c.properties || {};
            const nm = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || "Name not observed";
            const role = p.jobtitle ? `, ${p.jobtitle}` : "";
            const email = p.email ? ` (${p.email})` : "";
            return `${nm}${role}${email}`;
          })
          .join("; ")
      : "Not observed in HubSpot history";

    const companyLine = companies.length
      ? companies
          .slice(0, 2)
          .map((c) => c.properties?.name)
          .filter(Boolean)
          .join("; ")
      : "Not observed in HubSpot history";

    let notesSummary = "Not observed in HubSpot history";
    try {
      const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/notes`);
      const noteIds = (assoc.data?.results || []).map((r) => r.toObjectId).filter(Boolean).slice(0, 10);

      if (noteIds.length) {
        const notes = await batchRead(hs, "notes", noteIds, ["hs_note_body", "hs_createdate"]);
        const snippets = notes
          .sort((a, b) => Number(new Date(b.properties?.hs_createdate || 0)) - Number(new Date(a.properties?.hs_createdate || 0)))
          .slice(0, 10)
          .map((n) => (n.properties?.hs_note_body || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 6);

        if (snippets.length) notesSummary = snippets.join(" | ").slice(0, 1200);
      }
    } catch (e) {
      // leave default
    }

    const hubspotDealUrl = `https://app.hubspot.com/contacts/${team_id}/deal/${dealId}`;
    const prompt = buildPromptFromHubSpotData({
      dealName,
      hubspotDealUrl,
      ownerLine,
      created,
      closed,
      cycleDays,
      contactsLine,
      notesSummary: `${notesSummary}${companyLine !== "Not observed in HubSpot history" ? ` (Company: ${companyLine})` : ""}`
    });

    const summaryText = await callOpenAI(prompt);
    // Post summary in channel and update ephemeral via response_url
    await slackPost(channel_id, summaryText);
    await postToResponseUrl(response_url, `Posted deal summary to #${channelName}.`, true);
  } catch (err) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || "unknown_error");
    try {
      if (response_url) {
        await postToResponseUrl(response_url, `Summary failed: ${msg}`, true);
      } else {
        await slackPost(channel_id, `Summary failed: ${msg}`);
      }
    } catch (e) {
      console.error("Post error after summary failure:", e);
    }
  }
}

