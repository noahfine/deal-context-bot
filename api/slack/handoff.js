import crypto from "crypto";
import axios from "axios";
import { waitUntil } from "@vercel/functions";
import {
  getSlackChannelName,
  slackPost,
  channelNameToDealQuery,
  getHubSpotAccessToken,
  hubspotClient,
  findBestDeal,
  getDealAssociations,
  batchRead,
  resolveOwnerName,
  daysBetweenISO
} from "./utils.js";
import { callOpenAIForQA } from "./openai-qa.js";

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

// Vercel Hobby plan has a 10s function timeout
const VERCEL_TIMEOUT_WARNING_MS = 8000;

async function postToResponseUrl(responseUrl, text, replaceOriginal = false) {
  if (!responseUrl) return;
  try {
    await axios.post(
      responseUrl,
      { text, replace_original: replaceOriginal },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
  } catch (e) {
    console.error("postToResponseUrl failed:", e.message, e.response?.status);
  }
}

function buildPromptFromHubSpotData({ dealName, hubspotDealUrl, ownerLine, created, closed, cycleDays, contactsLine, notesSummary }) {
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
  const response_url = payload.response_url;

  // Respond within 3 seconds or Slack shows "operation_timeout"
  res.status(200).json({
    response_type: "ephemeral",
    text: "Generating deal summary... (this may take a moment)"
  });

  // Keep function alive until work completes (Vercel would otherwise stop after res.json)
  // Set a timer to warn via response_url if we're approaching the Vercel Hobby timeout
  let summaryFinished = false;
  const timeoutWarning = setTimeout(async () => {
    if (!summaryFinished && response_url) {
      console.warn("[/summary] approaching Vercel timeout, posting warning");
      await postToResponseUrl(
        response_url,
        "Still generating the summary, but it's taking longer than expected. " +
        "If you don't see a response shortly, the Vercel function may have timed out (10s limit on Hobby plan). " +
        "Try running /summary again.",
        false
      );
    }
  }, VERCEL_TIMEOUT_WARNING_MS);

  waitUntil(
    (async () => {
      try {
        const channelName = await getSlackChannelName(channel_id);
        const dealQuery = channelNameToDealQuery(channelName);

        const accessToken = await getHubSpotAccessToken();
        const hs = hubspotClient(accessToken);

        const deal = await findBestDeal(hs, dealQuery);
        if (!deal) {
          await postToResponseUrl(response_url, `No HubSpot deal found matching "${dealQuery}".`, true);
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

        const portalId = process.env.HUBSPOT_PORTAL_ID;
        const hubspotDealUrl = portalId
          ? `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`
          : `https://app.hubspot.com/deals/${dealId}`;
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

        const summaryText = await callOpenAIForQA(prompt);
        await slackPost(channel_id, summaryText);
        summaryFinished = true;
        clearTimeout(timeoutWarning);
        await postToResponseUrl(response_url, `Posted deal summary to #${channelName}.`, true);
      } catch (err) {
        summaryFinished = true;
        clearTimeout(timeoutWarning);
        console.error("/summary error:", err?.message || err, err?.code);
        let msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || "unknown_error");
        if (err?.code === "ETIMEDOUT" || msg.includes("ETIMEDOUT")) {
          msg = "Redis connection timed out. Check Vercel logs and Redis connectivity.";
        }
        if (response_url) {
          await postToResponseUrl(response_url, `Summary failed: ${msg}`, true);
        } else {
          try {
            await slackPost(channel_id, `Summary failed: ${msg}`);
          } catch (e) {
            console.error("slackPost error:", e.message);
          }
        }
      }
    })()
  );
}
