import crypto from "crypto";
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
  addMessageToThread,
  getHubSpotAccessToken,
  hubspotClient,
  findBestDeal,
  getDealAssociations,
  batchRead,
  resolveOwnerName,
  daysBetweenISO
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

const SLACK_TIMEOUT_MS = 2500;

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

    // Extract question from mention
    const question = extractQuestionFromMention(text, botUserId);
    if (!question) {
      await slackPost(channel_id, "I'm here! Ask me a question about this deal.");
      return;
    }

    // Get channel info and check if public
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

    const hubspotDealUrl = `https://app.hubspot.com/contacts/${event.team}/deal/${dealId}`;

    // Build Q&A prompt
    const prompt = buildQAPrompt({
      question,
      dealData: { dealId, dealName },
      threadContext: null, // No thread context for @mentions
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
    const answer = await callOpenAIForQA(prompt);

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
    console.error("Error handling app mention:", err);
    try {
      await slackPost(channel_id, `Sorry, I encountered an error: ${err.message || "unknown_error"}`, thread_ts);
    } catch (e) {
      console.error("Failed to post error to Slack:", e.message);
    }
  }
}

async function handleThreadReply(event) {
  const channel_id = event.channel;
  const thread_ts = event.thread_ts;
  const user_id = event.user;
  const text = event.text || "";
  const ts = event.ts;
  console.log("[handleThreadReply] channel=%s thread_ts=%s text=%s", channel_id, thread_ts, text?.slice(0, 80));

  if (!thread_ts) {
    return;
  }

  try {
    // Get bot user ID
    const botUserId = await getBotUserId();

    // Get thread context from Redis or fetch from Slack
    let threadContext = await getThreadContext(channel_id, thread_ts);
    let dealId = null;

    if (threadContext) {
      dealId = threadContext.dealId;
    } else {
      // Fetch thread history from Slack
      const threadMessages = await getThreadHistory(channel_id, thread_ts);
      // Check if bot posted in this thread (parent may be our /summary or @DeCo reply)
      const botMessage = threadMessages.find(
        (msg) =>
          isBotMessage(msg) ||
          msg.bot_id !== undefined ||
          (msg.ts === thread_ts && msg.user === botUserId)
      );
      if (!botMessage) {
        console.log("[handleThreadReply] no bot message in thread, ignoring. threadMessages count=%s", threadMessages?.length);
        return;
      }
      // Try to extract deal ID from context or fetch deal
      threadContext = { messages: threadMessages };
    }

    // Get channel info
    const channelInfo = await getSlackChannelInfo(channel_id);
    const isPublic = isPublicChannel(channelInfo);
    const channelName = channelInfo?.name || await getSlackChannelName(channel_id);

    // Get deal
    let dealId_final = dealId;
    let deal = null;
    
    const accessToken = await getHubSpotAccessToken();
    const hs = hubspotClient(accessToken);
    
    if (!dealId_final) {
      const dealQuery = channelNameToDealQuery(channelName);
      deal = await findBestDeal(hs, dealQuery);
      if (!deal) {
        await slackPost(channel_id, `No HubSpot deal found matching "${dealQuery}".`, thread_ts);
        return;
      }
      dealId_final = deal.id;
    } else {
      // Still need to fetch deal for properties
      const dealQuery = channelNameToDealQuery(channelName);
      deal = await findBestDeal(hs, dealQuery);
      if (!deal) {
        await slackPost(channel_id, `No HubSpot deal found matching "${dealQuery}".`, thread_ts);
        return;
      }
      dealId_final = deal.id;
    }
    const dealName = deal.properties?.dealname || channelNameToDealQuery(channelName);
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

    // Fetch channel history if public
    let channelHistory = null;
    if (isPublic) {
      try {
        channelHistory = await getChannelHistory(channel_id, 100);
        channelHistory = channelHistory.filter(
          (msg) => !isBotMessage(msg) && !msg.subtype && msg.text
        );
      } catch (err) {
        console.error("Error fetching channel history:", err.message);
      }
    }

    // Determine required data
    const requiredData = determineRequiredData(text, deal);

    // Fetch basic data
    const { contactIds, companyIds } = await getDealAssociations(hs, dealId_final);
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
      engagements = await fetchDealEngagements(hs, dealId_final);
      engagements = formatEngagementsForPrompt(engagements);
    }

    if (requiredData.activities) {
      activities = await fetchDealActivities(hs, dealId_final);
      activities = formatActivitiesForPrompt(activities);
    }

    if (requiredData.notes) {
      notes = await fetchDealNotes(hs, dealId_final);
      notes = formatNotesForPrompt(notes);
    }

    const hubspotDealUrl = `https://app.hubspot.com/contacts/${event.team}/deal/${dealId_final}`;

    // Build Q&A prompt with thread context
    const prompt = buildQAPrompt({
      question: text,
      dealData: { dealId: dealId_final, dealName },
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

    // Get answer
    const answer = await callOpenAIForQA(prompt);

    // Post reply in thread
    const response = await slackPost(channel_id, answer, thread_ts);

    // Update thread context
    await addMessageToThread(channel_id, thread_ts, { user: user_id, text, ts });
    await addMessageToThread(channel_id, thread_ts, { bot_id: botUserId, text: answer, ts: response.ts });
  } catch (err) {
    console.error("Error handling thread reply:", err);
    try {
      await slackPost(channel_id, `Sorry, I encountered an error: ${err.message || "unknown_error"}`, thread_ts);
    } catch (e) {
      console.error("Failed to post error to thread:", e.message);
    }
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
        // Process asynchronously
        handleAppMention(event).catch((err) => {
          console.error("Error in async app_mention handler:", err);
        });
        return;
      }

      // Handle message events (for thread replies)
      if (event.type === "message") {
        // Ignore bot messages and messages without thread_ts
        if (isBotMessage(event) || !event.thread_ts) {
          return res.status(200).send("OK");
        }

        // Acknowledge immediately
        res.status(200).send("OK");
        // Process asynchronously
        handleThreadReply(event).catch((err) => {
          console.error("Error in async thread reply handler:", err);
        });
        return;
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
