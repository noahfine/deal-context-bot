import axios from "axios";
import Redis from "ioredis";

const SLACK_TIMEOUT_MS = 8000;
const HUBSPOT_TIMEOUT_MS = 10000;

const redisUrl = process.env.deal_summarizer_bot_REDIS_URL;

// Lazy initialization to avoid module load errors at build time
let redisInstance = null;
export function getRedis() {
  if (!redisUrl) {
    throw new Error("Missing deal_summarizer_bot_REDIS_URL environment variable");
  }
  if (!redisInstance) {
    redisInstance = new Redis(redisUrl, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      retryStrategy(times) {
        if (times > 1) return null;
        return 1000;
      },
    });
    redisInstance.on("error", (err) => {
      console.error("[utils Redis] connection error:", err.message);
    });
  }
  return redisInstance;
}

// Export redis as a Proxy to forward all method calls (maintains full compatibility)
export const redis = new Proxy({}, {
  get(target, prop) {
    const redis = getRedis();
    const value = redis[prop];
    if (typeof value === 'function') {
      return value.bind(redis);
    }
    return value;
  }
});

// ===== Slack Bot Token (OAuth / token rotation) =====

const SLACK_REFRESH_BUFFER_MS = 60 * 60 * 1000; // refresh 1 hour before expiry
const REDIS_READ_TIMEOUT_MS = 4000; // fail fast from serverless if Redis is unreachable

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}

export async function getSlackBotToken() {
  const envToken = process.env.SLACK_BOT_TOKEN || null;
  // When env token is set, use it directly so we never block on Redis (Redis can hang from Vercel)
  if (envToken) {
    console.log("[getSlackBotToken] returning env token");
    return envToken;
  }

  try {
    const redis = getRedis();
    const access = await withTimeout(
      redis.get("slack:access_token"),
      REDIS_READ_TIMEOUT_MS,
      "Redis read timeout (Slack token). Redis may be unreachable from Vercel—try Upstash or check network."
    );
    const refresh = await withTimeout(
      redis.get("slack:refresh_token"),
      REDIS_READ_TIMEOUT_MS,
      "Redis read timeout (Slack token). Redis may be unreachable from Vercel—try Upstash or check network."
    );
    const expiresAtMsStr = await withTimeout(
      redis.get("slack:expires_at_ms"),
      REDIS_READ_TIMEOUT_MS,
      "Redis read timeout (Slack token). Redis may be unreachable from Vercel—try Upstash or check network."
    );
    const expiresAtMs = expiresAtMsStr ? Number(expiresAtMsStr) : 0;

    const now = Date.now();
    if (access && expiresAtMs && now < expiresAtMs - SLACK_REFRESH_BUFFER_MS) {
      return access;
    }

    if (refresh) {
      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (clientId && clientSecret) {
        try {
          const resp = await axios.post(
            "https://slack.com/api/oauth.v2.access",
            new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              grant_type: "refresh_token",
              refresh_token: refresh,
            }),
            {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              timeout: SLACK_TIMEOUT_MS,
            }
          );
          if (resp.data?.ok) {
            const newAccess = resp.data.access_token;
            const newRefresh = resp.data.refresh_token;
            const expiresIn = Number(resp.data.expires_in ?? 43200);
            const newExpiresAt = Date.now() + expiresIn * 1000;
            await redis.set("slack:access_token", newAccess);
            await redis.set("slack:expires_at_ms", String(newExpiresAt));
            if (newRefresh) await redis.set("slack:refresh_token", newRefresh);
            return newAccess;
          }
        } catch (err) {
          console.error("Slack token refresh error:", err.message);
        }
      }
    }

    const isExpired = expiresAtMs && now >= expiresAtMs - SLACK_REFRESH_BUFFER_MS;
    if (!access) {
      throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
    }
    if (isExpired) {
      throw new Error(
        "Slack token expired and refresh failed; reinstall the app from Slack app settings (Install App)."
      );
    }
    return access;
  } catch (err) {
    console.warn("Redis unavailable for Slack token:", err.message);
    throw err;
  }
}

// ===== Slack API Helpers =====

export async function getSlackChannelName(channel_id) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.info", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.info error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.channel?.name || "name_not_found";
}

export async function getSlackChannelInfo(channel_id) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.info", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.info error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.channel;
}

export function isPublicChannel(channelInfo) {
  return channelInfo?.is_channel === true && channelInfo?.is_private === false;
}

export async function getChannelHistory(channel_id, limit = 100) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.history", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id, limit },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.history error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.messages || [];
}

export async function getThreadHistory(channel_id, thread_ts) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.replies", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id, ts: thread_ts },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.replies error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.messages || [];
}

export async function slackPost(channel_id, text, thread_ts = null) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const payload = { channel: channel_id, text };
  if (thread_ts) {
    payload.thread_ts = thread_ts;
  }
  const resp = await axios.post("https://slack.com/api/chat.postMessage", payload, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack chat.postMessage error: ${resp.data?.error || "unknown_error"}`);
  return resp.data;
}

export async function getBotUserId() {
  console.log("[getBotUserId] start");
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  console.log("[getBotUserId] calling auth.test");
  let resp;
  try {
    resp = await axios.get("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.code || err.message;
    console.error("[getBotUserId] auth.test request failed:", msg);
    throw err;
  }
  if (!resp.data?.ok) {
    const errMsg = resp.data?.error || "unknown_error";
    console.error("[getBotUserId] auth.test failed:", errMsg);
    throw new Error(`Slack auth.test error: ${errMsg}`);
  }
  console.log("[getBotUserId] ok, user_id=", resp.data.user_id);
  return resp.data.user_id;
}

export function extractQuestionFromMention(text, botUserId) {
  // Remove @mention and clean up the text
  const mentionPattern = new RegExp(`<@${botUserId}>`, "g");
  let question = text.replace(mentionPattern, "").trim();
  // Remove quotes if present
  question = question.replace(/^["']|["']$/g, "").trim();
  return question;
}

export function isBotMessage(message) {
  return (
    message?.subtype === "bot" ||
    message?.subtype === "bot_message" ||
    message?.bot_id !== undefined
  );
}

// ===== Channel Name to Deal Query =====

export function channelNameToDealQuery(channelName) {
  // reverse the slug: dashes to spaces
  // "conception-case-hillsman-et-al" -> "conception case hillsman et al"
  return (channelName || "").replace(/-/g, " ").trim();
}

// ===== Thread Context Management (Redis) =====

export async function storeThreadContext(channel_id, thread_ts, messages, dealId) {
  const key = `slack:thread:${channel_id}:${thread_ts}`;
  const data = {
    messages,
    dealId,
    lastUpdated: Date.now()
  };
  await redis.set(key, JSON.stringify(data), "EX", 86400); // 24 hour TTL
}

export async function getThreadContext(channel_id, thread_ts) {
  const key = `slack:thread:${channel_id}:${thread_ts}`;
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data);
}

export async function addMessageToThread(channel_id, thread_ts, message) {
  const context = await getThreadContext(channel_id, thread_ts);
  if (!context) return null;
  context.messages.push(message);
  context.lastUpdated = Date.now();
  const key = `slack:thread:${channel_id}:${thread_ts}`;
  await redis.set(key, JSON.stringify(context), "EX", 86400);
  return context;
}

// ===== HubSpot Helpers =====

export async function hubspotTokenExchange(form) {
  const resp = await axios.post("https://api.hubapi.com/oauth/v1/token", form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: HUBSPOT_TIMEOUT_MS
  });
  return resp.data;
}

export async function getHubSpotAccessToken() {
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

export function hubspotClient(accessToken) {
  return axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: HUBSPOT_TIMEOUT_MS
  });
}

export async function findBestDeal(hs, dealQuery) {
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

  results.sort((a, b) => {
    const ac = a.properties?.closedate ? Number(new Date(a.properties.closedate)) : 0;
    const bc = b.properties?.closedate ? Number(new Date(b.properties.closedate)) : 0;
    return bc - ac;
  });

  return results[0];
}

export async function getDealAssociations(hs, dealId) {
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

export async function batchRead(hs, objectType, ids, properties) {
  if (!ids.length) return [];
  const resp = await hs.post(`/crm/v3/objects/${objectType}/batch/read`, {
    inputs: ids.slice(0, 50).map((id) => ({ id })),
    properties
  });
  return resp.data?.results || [];
}

export async function resolveOwnerName(hs, ownerId) {
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

export function daysBetweenISO(a, b) {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (!da || !db) return null;
  const diff = Math.round((db - da) / (1000 * 60 * 60 * 24));
  return diff;
}
