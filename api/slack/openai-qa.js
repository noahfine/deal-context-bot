import axios from "axios";

const OPENAI_TIMEOUT_MS = 20000;

export async function callOpenAIForQA(promptText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Using Responses API (same as existing implementation)
  const resp = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-4.1-mini",
      input: promptText
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: OPENAI_TIMEOUT_MS
    }
  );

  // Extract text
  const output = resp.data?.output || [];
  const text = output
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text;
}

export function buildQAPrompt({ question, dealData, threadContext, hubspotData, channelHistory }) {
  const {
    dealName,
    hubspotDealUrl,
    ownerLine,
    created,
    closed,
    cycleDays,
    contactsLine,
    companyLine,
    engagements,
    activities,
    notes
  } = hubspotData;

  // Format channel history
  let channelHistoryText = "No channel history available.";
  if (channelHistory && channelHistory.length > 0) {
    channelHistoryText = channelHistory
      .slice(0, 50)
      .map((msg) => {
        const user = msg.user ? `<@${msg.user}>` : "Unknown";
        const text = msg.text || "";
        const ts = msg.ts ? new Date(Number(msg.ts) * 1000).toISOString().split("T")[0] : "";
        return `[${ts}] ${user}: ${text}`;
      })
      .join("\n");
  }

  // Format thread context
  let threadContextText = "";
  if (threadContext && threadContext.messages && threadContext.messages.length > 0) {
    threadContextText = "\n\nThread conversation history:\n" +
      threadContext.messages
        .map((msg) => {
          const user = msg.user ? `<@${msg.user}>` : (msg.bot_id ? "Bot" : "Unknown");
          const text = msg.text || "";
          return `${user}: ${text}`;
        })
        .join("\n");
  }

  const prompt = `You are a helpful assistant answering questions about a HubSpot deal. You have access to both HubSpot CRM data and Slack channel conversation history.

User's question: ${question}

HubSpot Deal Information:
- Deal name: ${dealName}
- Deal link: ${hubspotDealUrl}
- Sales owner: ${ownerLine}
- Created: ${created || "Not observed in HubSpot history"}
- Closed: ${closed || "Not observed in HubSpot history"}${cycleDays != null ? ` (${cycleDays} days cycle)` : ""}
- Contacts: ${contactsLine || "Not observed in HubSpot history"}
- Companies: ${companyLine || "Not observed in HubSpot history"}
${engagements ? `\nEngagements:\n${engagements}` : ""}
${activities ? `\nActivities:\n${activities}` : ""}
${notes ? `\nNotes:\n${notes}` : ""}

Slack Channel History (recent messages from this channel):
${channelHistoryText}
${threadContextText}

Rules:
- Answer directly and concisely (1-3 sentences typically, more if needed for clarity)
- Intelligently synthesize information from both Slack channel history and HubSpot data
- If information exists in Slack channel, you may prefer that as it's more recent/contextual
- Use specific data from HubSpot when Slack doesn't have the answer
- If data is missing from both sources, say "Not found in HubSpot records or channel history"
- Maintain conversational tone
- Reference previous messages in thread or channel if relevant
- Indicate your source when helpful (e.g., "Based on the channel discussion..." or "According to HubSpot...")
- Do not make up facts - only use information provided above

Answer the question:`;

  return prompt;
}
