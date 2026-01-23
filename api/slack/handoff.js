import crypto from "crypto";
import axios from "axios";

const SLACK_TIMEOUT_MS = 2500; // keep it tight so we stay under Slack’s 3s window

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

export default async function handler(req, res) {
  const start = Date.now();
  console.log("Incoming request", { method: req.method, path: req.url });

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await readRawBody(req);

  const signingSecretPresent = Boolean(process.env.SLACK_SIGNING_SECRET);
  const botTokenPresent = Boolean(process.env.SLACK_BOT_TOKEN);
  console.log("Env present?", { signingSecretPresent, botTokenPresent });

  if (!signingSecretPresent || !botTokenPresent) {
    console.error("Missing required env vars");
    return res.status(500).send("Server misconfigured: missing env vars");
  }

  if (!verifySlackRequest(req, rawBody)) {
    console.error("Invalid Slack signature");
    return res.status(401).send("Invalid signature");
  }

  const payload = Object.fromEntries(new URLSearchParams(rawBody));
  const channel_id = payload.channel_id;

  console.log("Slash command received", {
    command: payload.command,
    channel_id,
    user_id: payload.user_id,
    team_id: payload.team_id
  });

  try {
    console.log("Fetching channel info from Slack...");

    const infoResp = await axios.get("https://slack.com/api/conversations.info", {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      params: { channel: channel_id },
      timeout: SLACK_TIMEOUT_MS
    });

    console.log("conversations.info response:", infoResp.data);

    if (!infoResp.data?.ok) {
      console.error("conversations.info ok:false", infoResp.data);
      return res.status(200).json({
        response_type: "ephemeral",
        text: `Slack error calling conversations.info: ${infoResp.data?.error || "unknown_error"}`
      });
    }

    const channelName = infoResp.data.channel?.name || "name_not_found";
    console.log("Channel name resolved:", channelName);

    console.log("Posting message to Slack channel...");

    const postResp = await axios.post(
      "https://slack.com/api/chat.postMessage",
      {
        channel: channel_id,
        text: `• Detected channel #${channelName}. HubSpot + OpenAI wiring next.`
      },
      {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        timeout: SLACK_TIMEOUT_MS
      }
    );

    console.log("chat.postMessage response:", postResp.data);

    if (!postResp.data?.ok) {
      console.error("chat.postMessage ok:false", postResp.data);
      return res.status(200).json({
        response_type: "ephemeral",
        text: `Slack error calling chat.postMessage: ${postResp.data?.error || "unknown_error"}`
      });
    }

    const elapsed = Date.now() - start;
    console.log("Done", { elapsed_ms: elapsed });

    // Respond to the slash command (ephemeral)
    return res.status(200).json({
      response_type: "ephemeral",
      text: `Posted summary to #${channelName}. (${elapsed}ms)`
    });
  } catch (err) {
    const data = err?.response?.data;
    console.error("Handler error:", data || err?.code || err?.message || err);

    return res.status(200).json({
      response_type: "ephemeral",
      text: `Error: ${(data && JSON.stringify(data)) || err?.code || err?.message || "unknown_error"}`
    });
  }
}

