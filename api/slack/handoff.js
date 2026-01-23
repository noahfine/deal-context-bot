import crypto from "crypto";
import axios from "axios";

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

async function postEphemeral(response_url, text) {
  if (!response_url) return;
  await axios.post(response_url, { response_type: "ephemeral", text });
}

export default async function handler(req, res) {
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
  const response_url = payload.response_url;

  console.log("Slash command received", {
    command: payload.command,
    channel_id,
    user_id: payload.user_id,
    team_id: payload.team_id,
    has_response_url: Boolean(response_url)
  });

  // Ack immediately
  res.status(200).json({
    response_type: "ephemeral",
    text: "Working on it. I’ll post the deal handoff summary here in a moment."
  });

  try {
    console.log("Fetching channel info from Slack...");

    let infoResp;
    try {
      infoResp = await axios.get("https://slack.com/api/conversations.info", {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        params: { channel: channel_id }
      });
      console.log("conversations.info raw response:", infoResp.data);
    } catch (err) {
      console.error(
        "conversations.info request failed:",
        err?.response?.data || err?.message || err
      );
      await postEphemeral(
        response_url,
        `Slack API error calling conversations.info: ${
          (err?.response?.data && JSON.stringify(err.response.data)) ||
          err?.message ||
          "unknown_error"
        }`
      );
      return;
    }

    if (!infoResp.data?.ok) {
      console.error("conversations.info returned ok:false", infoResp.data);
      await postEphemeral(
        response_url,
        `Slack error calling conversations.info: ${infoResp.data?.error || "unknown_error"}`
      );
      return;
    }

    const channelName = infoResp.data.channel?.name || "name_not_found";
    console.log("Channel name resolved:", channelName);

    console.log("Posting message to Slack channel...");

    let postResp;
    try {
      postResp = await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: channel_id,
          text: `• Detected channel #${channelName}. HubSpot + OpenAI wiring next.`
        },
        { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
      );
      console.log("chat.postMessage raw response:", postResp.data);
    } catch (err) {
      console.error("chat.postMessage request failed:", err?.response?.data || err?.message || err);
      await postEphemeral(
        response_url,
        `Slack API error calling chat.postMessage: ${
          (err?.response?.data && JSON.stringify(err.response.data)) ||
          err?.message ||
          "unknown_error"
        }`
      );
      return;
    }

    if (!postResp.data?.ok) {
      console.error("chat.postMessage returned ok:false", postResp.data);
      await postEphemeral(
        response_url,
        `Slack error calling chat.postMessage: ${postResp.data?.error || "unknown_error"}`
      );
      return;
    }

    console.log("Posted message successfully", { ts: postResp.data.ts });
  } catch (err) {
    console.error("Handoff error:", err?.response?.data || err?.message || err);
    await postEphemeral(
      response_url,
      `Error generating summary: ${err?.message || "unknown_error"}`
    );
  }
}

