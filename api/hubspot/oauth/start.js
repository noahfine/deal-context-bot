export default async function handler(req, res) {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;
  const scopes = process.env.HUBSPOT_SCOPES;

  if (!clientId || !redirectUri || !scopes) {
    return res
      .status(500)
      .send("Missing HUBSPOT_CLIENT_ID, HUBSPOT_REDIRECT_URI, or HUBSPOT_SCOPES");
  }

  const state = "deal-context-bot";

  const authUrl =
    "https://app.hubspot.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
}