import axios from "axios";
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    return res
      .status(400)
      .send(
        `HubSpot OAuth error: ${error}${
          error_description ? ` — ${error_description}` : ""
        }`
      );
  }

  if (!code) {
    return res.status(400).send("Missing ?code= in callback");
  }

  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res
      .status(500)
      .send(
        "Missing HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, or HUBSPOT_REDIRECT_URI"
      );
  }

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("redirect_uri", redirectUri);
  form.set("code", code);

  const tokenResp = await axios.post(
    "https://api.hubapi.com/oauth/v1/token",
    form,
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000
    }
  );

  const { access_token, refresh_token, expires_in } = tokenResp.data;

  const expiresAtMs = Date.now() + Number(expires_in || 0) * 1000;

  await kv.set("hubspot:access_token", access_token);
  await kv.set("hubspot:refresh_token", refresh_token);
  await kv.set("hubspot:expires_at_ms", expiresAtMs);

  return res
    .status(200)
    .send(
      "✅ HubSpot connected. You can close this tab and run /summary in Slack."
    );
}
