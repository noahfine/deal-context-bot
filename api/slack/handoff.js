import crypto from "crypto";
import axios from "axios";

function verifySlackRequest(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const fiveMinutes = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > fiveMinutes) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const mySig =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(sigBase, "utf8")
      .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(signature));
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
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await readRawBody(req);
  if (!verifySlackRequest(req, rawBody)) {
    return res.status(401).send("Invalid signature");
  }

  const payload = Object.fromEntries(new URLSearchParams(rawBody));
  const channel_id = payload.channel_id;
  const response_url = payload.response_url;

  // Slack requires an immediate response
  res.status(200).json({
    response_type: "ephemeral",
    text: "Working on it. I’ll post the deal handoff summary here in a moment."
  });

  try {
    const infoResp = await axios.get("https://slack.com/api/conversations.info", {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      params: { channel: channel_id }
    });

    const channelName = infoResp.data.channel.name;

    await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel: channel_id, text: `• Detected channel #${channelName}. HubSpot wiring next.` },
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
  } catch (err) {
    await axios.post(response_url, {
      response_type: "ephemeral",
      text: `Error: ${err.message}`
    });
  }
}
