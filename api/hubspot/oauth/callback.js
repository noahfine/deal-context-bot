import axios from "axios";
import Redis from "ioredis";

/* Uses your existing env var (no value pasted here) */
const redisUrl = process.env.deal_summarizer_bot_REDIS_URL;

if (!redisUrl) {
  throw new Error("Missing deal_summarizer_bot_REDIS_URL environment variable");
}

const redis = new Redis(redisUrl, {
  // Helps avoid hanging during connection issues
  connectTimeout: 10000,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true
});

export default async function handler(req, res) {
  try {
    const { code, error, error_description } = req.query;

    console.log("HubSpot callback hit", { hasCode: Boolean(code), error: error || null });

    if (error) {
      return res
        .status(400)
        .send(`HubSpot OAuth error: ${error}${error_description ? ` — ${error_description}` : ""}`);
    }
    if (!code) return res.status(400).send("Missing ?code= in callback");

    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res
        .status(500)
        .send("Missing HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, or HUBSPOT_REDIRECT_URI");
    }

    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
    form.set("redirect_uri", redirectUri);
    form.set("code", code);

    console.log("Exchanging code for tokens...");

    const tokenResp = await axios.post("https://api.hubapi.com/oauth/v1/token", form, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000
    });

    const { access_token, refresh_token, expires_in } = tokenResp.data || {};
    if (!access_token || !refresh_token) {
      return res.status(500).send("Token exchange response missing access_token or refresh_token");
    }

    const expiresAtMs = Date.now() + Number(expires_in || 0) * 1000;

    console.log("Writing tokens to Redis...");
    await redis.set("hubspot:access_token", access_token);
    await redis.set("hubspot:refresh_token", refresh_token);
    await redis.set("hubspot:expires_at_ms", String(expiresAtMs));
    console.log("Redis write success");

    return res.status(200).send("✅ HubSpot connected. You can close this tab and run /summary in Slack.");
  } catch (err) {
    console.error("Callback crashed", err?.response?.data || err?.message || err);
    return res.status(500).send(`Callback crashed: ${err?.message || "unknown_error"}`);
  }
}
