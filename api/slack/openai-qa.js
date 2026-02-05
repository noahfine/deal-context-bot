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
    amount,
    dealType,
    dealStage,
    pipelineName,
    description,
    lineItems,
    timeline
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

  const prompt = `You are a deal context assistant for post-sales teams (Deployments, Customer Success, and Training). These teams take over after Sales closes a deal and need to understand deal history, customer context, and any risks.

You have access to HubSpot CRM data (emails, calls, meetings, notes) and Slack channel history for this deal.

User's question: ${question}

HubSpot Deal Information:
- Deal name: ${dealName}
- Deal link: ${hubspotDealUrl}
- Sales owner: ${ownerLine}
- Amount: ${amount || "Not found in HubSpot records"}
- Deal Type: ${dealType || "Not found in HubSpot records"}
- Deal Stage: ${dealStage || "Not found in HubSpot records"}
- Pipeline: ${pipelineName || "Not found in HubSpot records"}
- Created: ${created || "Not found in HubSpot records"}
- Closed: ${closed || "Not found in HubSpot records"}${cycleDays != null ? ` (${cycleDays}-day cycle)` : ""}
- Contacts: ${contactsLine || "Not found in HubSpot records"}
- Companies: ${companyLine || "Not found in HubSpot records"}
${description ? `- Description: ${description}` : ""}
${lineItems ? `- Products/Line Items:\n${lineItems}` : ""}
${timeline ? `\nDeal Activity Timeline (most recent first):\n${timeline}` : ""}

Slack Channel History (recent messages):
${channelHistoryText}
${threadContextText}

Rules:
- CRITICAL: Use the structured deal data (amount, deal type, products/line items, deal stage) as ground truth. Do NOT infer product names, deal type, financial details, or deal structure from email or meeting content — emails may discuss multiple products or options that were not part of the final deal.
- Answer directly and concisely. Use 1-3 sentences for simple questions, more for questions requiring detail.
- Synthesize information from both Slack and HubSpot. Prefer Slack for recent/contextual info, HubSpot for historical deal data.
- When asked about customer temperament, deal history, holdups, or risks, draw from the full activity timeline — not just the most recent entry.
- If data is missing from both sources, say "Not found in HubSpot records or channel history."
- Use conversational tone. Reference sources when helpful (e.g., "Based on an email from Jan 15..." or "In the channel discussion...").
- Do not invent facts. Only use information provided above.
- Reference previous thread messages if relevant to the question.

Answer the question:`;

  return prompt;
}
