import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import axios from "axios";
import {
  getSlackChannelName,
  getSlackChannelInfo,
  isPublicChannel,
  getChannelHistory,
  getThreadHistory,
  slackPost,
  getBotUserId,
  extractQuestionFromMention,
  isBotMessage,
  channelNameToDealQuery,
  storeThreadContext,
  getThreadContext,
  getHubSpotAccessToken,
  hubspotClient,
  findBestDeal,
  getDealAssociations,
  batchRead,
  resolveOwnerName,
  daysBetweenISO,
  getCachedSlackBotToken
} from "./utils.js";
import {
  determineRequiredData,
  fetchDealEngagements,
  fetchDealActivities,
  fetchDealNotes,
  formatEngagementsForPrompt,
  formatActivitiesForPrompt,
  formatNotesForPrompt
} from "./hubspot-data.js";
import { buildQAPrompt, callOpenAIForQA } from "./openai-qa.js";

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

// Vercel Hobby plan has a 10s function timeout. We post a notification if the
// handler is still running after this threshold so the user knows it's working.
const VERCEL_TIMEOUT_WARNING_MS = 8000;

/** Post an error message to Slack using the cached token (no Redis round trip).
 *  Fails silently if no cached token is available. */
async function safeErrorPost(channel_id, text, thread_ts = null) {
  const token = getCachedSlackBotToken();
  if (!token) {
    console.error("[safeErrorPost] no cached token available, cannot post error to Slack");
    return;
  }
  try {
    const payload = { channel: channel_id, text };
    if (thread_ts) payload.thread_ts = thread_ts;
    await axios.post("https://slack.com/api/chat.postMessage", payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
  } catch (e) {
    console.error("[safeErrorPost] failed:", e?.message);
  }
}

/** Race the handler against a timeout. If the handler takes too long, post a
 *  warning to Slack so the user knows the function is working but hit the
 *  Vercel Hobby plan limit. The handler continues to run — `waitUntil` may
 *  keep it alive — but the user gets feedback either way. */
async function withTimeoutNotification(handlerPromise, channel_id, thread_ts) {
  let finished = false;

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(async () => {
      if (!finished) {
        console.warn("[timeout] handler exceeded %sms, posting warning", VERCEL_TIMEOUT_WARNING_MS);
        await safeErrorPost(
          channel_id,
          "Still working on your request, but it's taking longer than expected. " +
          "If you don't see a response shortly, the Vercel function may have timed out (10s limit on Hobby plan). " +
          "Try again or ask a simpler question.",
          thread_ts
        );
      }
      resolve();
    }, VERCEL_TIMEOUT_WARNING_MS);
  });

  try {
    const result = await Promise.race([
      handlerPromise.then((r) => { finished = true; return r; }),
      timeoutPromise
    ]);
    return result;
  } catch (err) {
    finished = true;
    throw err;
  }
}

async function handleAppMention(event) {
  const channel_id = event.channel;
  const user_id = event.user;
  const text = event.text || "";
  const ts = event.ts;
  const thread_ts = event.thread_ts || null;
  console.log("[handleAppMention] channel=%s thread_ts=%s text=%s", channel_id, thread_ts || "(none)", text?.slice(0, 80));

  try {
    // Get bot user ID
    const botUserId = await getBotUserId();
    console.log("[handleAppMention] got bot user id, fetching channel info and deal...");

    // Extract question from mention
    const question = extractQuestionFromMention(text, botUserId);
    if (!question) {
      await slackPost(channel_id, "I'm here! Ask me a question about this deal.", thread_ts);
      return;
    }

    // Get channel info and check if public
    console.log("[handleAppMention] fetching channel info...");
    const channelInfo = await getSlackChannelInfo(channel_id);
    const isPublic = isPublicChannel(channelInfo);
    const channelName = channelInfo?.name || await getSlackChannelName(channel_id);

    // Get deal from channel name
    const dealQuery = channelNameToDealQuery(channelName);
    const accessToken = await getHubSpotAccessToken();
    const hs = hubspotClient(accessToken);

    const deal = await findBestDeal(hs, dealQuery);
    if (!deal) {
      await slackPost(channel_id, `No HubSpot deal found matching "${dealQuery}".`);
      return;
    }

    const dealId = deal.id;
    const dealName = deal.properties?.dealname || dealQuery;
    const created = deal.properties?.createdate || null;
    const closed = deal.properties?.closedate || null;
    const cycleDays = daysBetweenISO(created, closed);

    const ownerId = deal.properties?.hubspot_owner_id || null;
    const ownerName = await resolveOwnerName(hs, ownerId);
    const ownerLine = ownerName
      ? `${ownerName} (Sales)`
      : ownerId
        ? `${ownerId} (name not found in HubSpot)`
        : "Not observed in HubSpot history";

    // Fetch channel history if public channel
    let channelHistory = null;
    if (isPublic) {
      try {
        channelHistory = await getChannelHistory(channel_id, 100);
        // Filter out bot messages and system messages
        channelHistory = channelHistory.filter(
          (msg) => !isBotMessage(msg) && !msg.subtype && msg.text
        );
      } catch (err) {
        console.error("Error fetching channel history:", err.message);
        // Continue without channel history
      }
    }

    // Determine what HubSpot data to fetch based on question
    const requiredData = determineRequiredData(question, deal);

    // Fetch basic deal data
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

    // Fetch additional data on-demand
    let engagements = null;
    let activities = null;
    let notes = null;

    if (requiredData.engagements) {
      engagements = await fetchDealEngagements(hs, dealId);
      engagements = formatEngagementsForPrompt(engagements);
    }

    if (requiredData.activities) {
      activities = await fetchDealActivities(hs, dealId);
      activities = formatActivitiesForPrompt(activities);
    }

    if (requiredData.notes) {
      notes = await fetchDealNotes(hs, dealId);
      notes = formatNotesForPrompt(notes);
    }

    const portalId = process.env.HUBSPOT_PORTAL_ID;
    const hubspotDealUrl = portalId
      ? `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`
      : `https://app.hubspot.com/deals/${dealId}`;

    // Load thread context if this @mention is inside an existing thread
    let threadContext = null;
    if (thread_ts) {
      threadContext = await getThreadContext(channel_id, thread_ts);
      if (!threadContext) {
        // No cached context — fetch thread history from Slack
        try {
          const threadMessages = await getThreadHistory(channel_id, thread_ts);
          if (threadMessages && threadMessages.length > 0) {
            threadContext = { messages: threadMessages };
          }
        } catch (err) {
          console.error("[handleAppMention] error fetching thread history:", err.message);
        }
      }
    }

    // Build Q&A prompt
    const prompt = buildQAPrompt({
      question,
      dealData: { dealId, dealName },
      threadContext,
      hubspotData: {
        dealName,
        hubspotDealUrl,
        ownerLine,
        created,
        closed,
        cycleDays,
        contactsLine,
        companyLine,
        engagements,
        activities,
        notes
      },
      channelHistory
    });

    // Get answer from OpenAI
    console.log("[handleAppMention] calling OpenAI...");
    const answer = await callOpenAIForQA(prompt);
    console.log("[handleAppMention] posting to Slack thread_ts=%s", thread_ts || "(channel)");
    // Post response in thread if mention was in a thread, otherwise in channel
    const response = await slackPost(channel_id, answer, thread_ts);

    // Store thread context if we have a thread (mention was in thread or we created one)
    const responseThreadTs = thread_ts || response.ts;
    if (responseThreadTs && response.ts) {
      await storeThreadContext(channel_id, responseThreadTs, [
        { user: user_id, text: question, ts },
        { bot_id: botUserId, text: answer, ts: response.ts }
      ], dealId);
    }
  } catch (err) {
    console.error("Error handling app mention:", err?.message || err, err?.stack);
    await safeErrorPost(channel_id, `Sorry, I encountered an error: ${err.message || "unknown_error"}`, thread_ts);
  }
}

export default async function handler(req, res) {
  // Allow GET for health checks and Slack verification during installation
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", endpoint: "slack-events" });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const rawBody = await readRawBody(req);

  if (!process.env.SLACK_SIGNING_SECRET) {
    return res.status(500).send("Missing SLACK_SIGNING_SECRET");
  }

  if (!verifySlackRequest(req, rawBody)) {
    return res.status(401).send("Invalid signature");
  }

  try {
    const body = JSON.parse(rawBody);

    // Handle URL verification challenge from Slack
    if (body.type === "url_verification") {
      return res.status(200).json({ challenge: body.challenge });
    }

    // Handle event callbacks
    if (body.type === "event_callback") {
      const event = body.event;
      console.log("[events] received event type=%s channel=%s thread_ts=%s", event?.type, event?.channel, event?.thread_ts ?? "(none)");

      // Handle app_mention events
      if (event.type === "app_mention") {
        // Acknowledge immediately (Slack requires response within 3 seconds)
        res.status(200).send("OK");
        // Process asynchronously — waitUntil keeps the function alive on Vercel
        waitUntil(
          withTimeoutNotification(
            handleAppMention(event),
            event.channel,
            event.thread_ts || null
          ).catch((err) => {
            console.error("Error in async app_mention handler:", err);
          })
        );
        return;
      }

      // Thread replies without @mention are ignored — bot only responds to @mentions.
      // When a user @mentions the bot in a thread, Slack sends both a "message" event
      // and an "app_mention" event. We handle it via app_mention above.
      if (event.type === "message") {
        return res.status(200).send("OK");
      }

      // Unknown event type, just acknowledge
      return res.status(200).send("OK");
    }

    // Unknown body type
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Events handler error:", err);
    return res.status(500).send(`Error: ${err.message || "unknown_error"}`);
  }
}
