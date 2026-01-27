import crypto from "crypto";

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

export default async function handler(req, res) {
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

    // Handle event callbacks (will be implemented next)
    if (body.type === "event_callback") {
      // For now, just acknowledge receipt
      // Full event handling will be added in next step
      return res.status(200).send("OK");
    }

    // Unknown event type
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Events handler error:", err);
    return res.status(500).send(`Error: ${err.message || "unknown_error"}`);
  }
}
