import axios from "axios";
import { getRedis, withTimeout } from "../../slack/utils.js";

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
    const redis = getRedis();
    await withTimeout(
      Promise.all([
        redis.set("hubspot:access_token", access_token),
        redis.set("hubspot:refresh_token", refresh_token),
        redis.set("hubspot:expires_at_ms", String(expiresAtMs)),
      ]),
      5000,
      "Redis write timeout — could not store HubSpot tokens. Check Redis connectivity."
    );
    console.log("Redis write success");

    return res.status(200).send("✅ HubSpot connected. You can close this tab and run /summary in Slack.");
  } catch (err) {
    console.error("Callback crashed", err?.response?.data || err?.message || err);
    return res.status(500).send(`Callback crashed: ${err?.message || "unknown_error"}`);
  }
}
