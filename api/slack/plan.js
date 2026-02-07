import axios from "axios";
import { waitUntil } from "@vercel/functions";
import {
  verifySlackRequest,
  readRawBody,
  getSlackChannelName,
  slackPost,
  channelNameToDealQuery,
  getHubSpotAccessToken,
  hubspotClient,
  findBestDeal,
  getDealAssociations,
  batchRead,
  resolveOwnerName,
  daysBetweenISO,
  getExtendedChannelHistory,
  isBotMessage
} from "./utils.js";
import {
  fetchDealEmails,
  fetchDealCalls,
  fetchDealMeetings,
  fetchDealNotes,
  fetchDealLineItems,
  formatTimelineForPrompt,
  formatLineItemsForPrompt
} from "./hubspot-data.js";
import { callOpenAIForQA } from "./openai-qa.js";

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

function buildDeploymentPlanPrompt({ dealName, hubspotDealUrl, ownerLine, csmLine, created, closed, cycleDays, contactsLine, companyLine, amount, dealType, dealStage, pipelineName, description, lineItems, timeline, channelHistoryText }) {
  const instructions = `
You are generating a deployment plan summary for a post-sales team. Extract specific deployment details from the HubSpot deal data and Slack channel history below. This is for internal teams (Deployments, Customer Success, Training) to understand what needs to happen and when for this deal.

Deal: "${dealName}"
Deal link: ${hubspotDealUrl}

OUTPUT FORMAT:
Use Slack mrkdwn formatting. Only include sections where you found actual data — do NOT output sections with "TBD", "Not found", or "Unknown". Omit the section entirely if the data isn't available.

Available sections (include only those with data):

*Deployment Plan: ${dealName}*
${hubspotDealUrl}

*What Was Sold*
Products/line items, deal amount, deal type. Use line items as ground truth.

*Install Details*
- Install Date
- Location (facility name + address)
- Scanner Type/Model
- Compute Type (one of: Cloud, GovCloud, On Prem, Air Gapped On Prem)
- Installer / FSE (Field Service Engineer)

*Scoping & Preparation*
- CS/CSM (Customer Success Manager) Scoping Call status
- Site Readiness notes (IT requirements, power, networking, access)
- Rocketlane/Jira/Google Sheets project links mentioned in channel

*Training*
- Training Schedule (dates)
- Training Conductor (who is leading training)
- Training Format (on-site / remote)

*Key Contacts*
- Customer contacts (from HubSpot)
- Internal team (sales owner, CSM, FSE, trainer — from emails)

*Notable Context & Risks*
Any special requirements, concerns, access issues, IT coordination needs, shipping considerations, or other deployment context.

DATA EXTRACTION RULES:
- Extract specific dates, names, and details. Do not summarize vaguely.
- Scanner type should primarily come from line items (ground truth for what was sold).
- Compute types are one of: Cloud, GovCloud, On Prem, Air Gapped On Prem. Look for these exact terms.
- Internal employee names and roles are often found in email sender/recipient fields and email signatures. CSMs (Customer Success Managers) and FSEs (Field Service Engineers / the installers) are identified by these titles in emails.
- Rocketlane form submissions (Billing Info and Facility Info) appear in the Slack channel. For the install/shipping address: use the facility address from the Facility Info form, UNLESS the Billing form's shipping address is outside the US — in that case, the Billing form address takes precedence.
- Look for Rocketlane, Jira, or Google Sheets links shared in the Slack channel.
- Use BOTH Slack messages and HubSpot emails as primary sources — deployment logistics appear in both.
- CRITICAL: Use the structured deal data (amount, deal type, products/line items) as ground truth. Do NOT infer product names or deal type from email content.
- Do not invent information. Only use data provided below.

HubSpot Deal Data:
- Deal: ${dealName}
- Sales Owner: ${ownerLine}
- CSM: ${csmLine}
- Amount: ${amount || "Not available"}
- Deal Type: ${dealType || "Not available"}
- Deal Stage: ${dealStage || "Not available"}
- Pipeline: ${pipelineName || "Not available"}
- Created: ${created || "Not available"}
- Closed: ${closed || "Not available"}${cycleDays != null ? ` (${cycleDays}-day cycle)` : ""}
- Company: ${companyLine || "Not available"}
- Contacts: ${contactsLine}
${description ? `- Description: ${description}` : ""}
${lineItems ? `- Products/Line Items:\n${lineItems}` : ""}

HubSpot Activity Timeline (most recent first):
${timeline || "No activity found."}

Slack Channel History (most recent first):
${channelHistoryText || "No channel history available."}
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
    text: "Generating deployment plan... (this may take a moment)"
  });

  let planFinished = false;
  const timeoutWarning = setTimeout(async () => {
    if (!planFinished && response_url) {
      console.warn("[/plan] approaching Vercel timeout, posting warning");
      await postToResponseUrl(
        response_url,
        "Still generating the deployment plan, but it's taking longer than expected. " +
        "If you don't see a response shortly, the Vercel function may have timed out (10s limit on Hobby plan). " +
        "Try running /plan again.",
        false
      );
    }
  }, VERCEL_TIMEOUT_WARNING_MS);

  waitUntil(
    (async () => {
      try {
        // ── Phase 1: Channel name + HubSpot token + extended Slack history (parallel) ──
        const [channelName, accessToken, rawChannelHistory] = await Promise.all([
          getSlackChannelName(channel_id),
          getHubSpotAccessToken(),
          getExtendedChannelHistory(channel_id, 200).catch((err) => {
            console.error("[/plan] error fetching extended channel history:", err.message);
            return [];
          })
        ]);

        const dealQuery = channelNameToDealQuery(channelName);
        const hs = hubspotClient(accessToken);

        // Filter out bot messages from channel history
        const channelHistory = rawChannelHistory.filter(
          (msg) => !isBotMessage(msg) && !msg.subtype && msg.text
        );

        // Format channel history for prompt
        let channelHistoryText = "No channel history available.";
        if (channelHistory.length > 0) {
          channelHistoryText = channelHistory
            .map((msg) => {
              const user = msg.user ? `<@${msg.user}>` : "Unknown";
              const text = (msg.text || "").substring(0, 500);
              const ts = msg.ts ? new Date(Number(msg.ts) * 1000).toISOString().split("T")[0] : "";
              return `[${ts}] ${user}: ${text}`;
            })
            .join("\n");
        }

        // ── Phase 2: Find deal ──
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

        const portalId = process.env.HUBSPOT_PORTAL_ID;
        const hubspotDealUrl = portalId
          ? `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`
          : `https://app.hubspot.com/deals/${dealId}`;

        // ── Phase 3: All HubSpot data fetches in parallel ──
        const [ownerName, associations, emails, calls, meetings, notes, lineItemsRaw] = await Promise.all([
          resolveOwnerName(hs, ownerId),
          getDealAssociations(hs, dealId),
          fetchDealEmails(hs, dealId),
          fetchDealCalls(hs, dealId),
          fetchDealMeetings(hs, dealId),
          fetchDealNotes(hs, dealId),
          fetchDealLineItems(hs, dealId)
        ]);

        // Phase 3b: Contacts + companies (depends on associations)
        const { contactIds, companyIds } = associations;
        const [contacts, companies] = await Promise.all([
          batchRead(hs, "contacts", contactIds, ["firstname", "lastname", "jobtitle", "email"]),
          batchRead(hs, "companies", companyIds, ["name", "domain", "csm"])
        ]);

        // Resolve CSM from company record (owner ID → name)
        const csmOwnerId = companies.length ? companies[0]?.properties?.csm : null;
        const csmName = csmOwnerId ? await resolveOwnerName(hs, csmOwnerId) : null;
        const csmLine = csmName
          ? `${csmName} (from company record)`
          : "Not assigned in HubSpot";

        const ownerLine = ownerName
          ? `${ownerName} (Sales)`
          : ownerId
            ? `${ownerId} (name not found in HubSpot)`
            : "Not found in HubSpot records";

        const contactsLine = contacts.length
          ? contacts
              .slice(0, 6)
              .map((c) => {
                const p = c.properties || {};
                const nm = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || "Name not found";
                const role = p.jobtitle ? `, ${p.jobtitle}` : "";
                const email = p.email ? ` (${p.email})` : "";
                return `${nm}${role}${email}`;
              })
              .join("; ")
          : "Not found in HubSpot records";

        const companyLine = companies.length
          ? companies
              .slice(0, 2)
              .map((c) => c.properties?.name)
              .filter(Boolean)
              .join("; ")
          : "Not found in HubSpot records";

        // ── Phase 4: Build timeline + prompt + OpenAI ──
        const timeline = formatTimelineForPrompt(emails, calls, meetings, notes);
        const lineItems = formatLineItemsForPrompt(lineItemsRaw);

        const amount = deal.properties?.amount
          ? `${deal.properties.deal_currency_code || "$"}${Number(deal.properties.amount).toLocaleString()}`
          : null;
        const dealType = deal.properties?.dealtype || null;
        const dealStage = deal.properties?.dealstage || null;
        const pipelineName = deal.properties?.pipeline || null;
        const description = deal.properties?.description || null;

        const prompt = buildDeploymentPlanPrompt({
          dealName,
          hubspotDealUrl,
          ownerLine,
          csmLine,
          created,
          closed,
          cycleDays,
          contactsLine,
          companyLine,
          amount,
          dealType,
          dealStage,
          pipelineName,
          description,
          lineItems,
          timeline,
          channelHistoryText
        });

        const planText = await callOpenAIForQA(prompt);
        await slackPost(channel_id, planText);
        planFinished = true;
        clearTimeout(timeoutWarning);
        await postToResponseUrl(response_url, `Posted deployment plan to #${channelName}.`, true);
      } catch (err) {
        planFinished = true;
        clearTimeout(timeoutWarning);
        console.error("/plan error:", err?.message || err, err?.code);
        let msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || "unknown_error");
        if (err?.code === "ETIMEDOUT" || msg.includes("ETIMEDOUT")) {
          msg = "Redis connection timed out. Check Vercel logs and Redis connectivity.";
        }
        if (response_url) {
          await postToResponseUrl(response_url, `Deployment plan failed: ${msg}`, true);
        } else {
          try {
            await slackPost(channel_id, `Deployment plan failed: ${msg}`);
          } catch (e) {
            console.error("slackPost error:", e.message);
          }
        }
      }
    })()
  );
}
