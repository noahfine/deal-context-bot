export default async function handler(req, res) {
  // Handle Slack OAuth callback
  // This endpoint is required for "Manage Distribution" even if you're using bot tokens
  
  if (req.method === "GET") {
    const { code, error, state } = req.query;

    if (error) {
      return res.status(400).send(`Slack OAuth error: ${error}`);
    }

    // If code is present, Slack is trying to complete OAuth
    // Since you're using bot tokens, you can just acknowledge
    if (code) {
      // You could exchange the code for tokens here if needed
      // But since you're using SLACK_BOT_TOKEN, you can just return success
      return res.status(200).send(`
        <html>
          <body>
            <h1>✅ Slack App Authorized</h1>
            <p>You can close this window. The app is now installed.</p>
            <p>Note: This app uses bot tokens, so OAuth tokens are not stored.</p>
          </body>
        </html>
      `);
    }

    // Health check - just return 200
    return res.status(200).json({ status: "ok", endpoint: "slack-oauth-callback" });
  }

  // Handle POST if needed
  return res.status(405).send("Method Not Allowed");
}
