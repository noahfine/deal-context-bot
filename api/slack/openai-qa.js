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

const CLASSIFY_TIMEOUT_MS = 8000;

export async function classifyQuestion(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { scope: "single", keywords: [] };

  try {
    const prompt = `You classify questions about deals. Respond with JSON only, no markdown.
Given this question, determine:
1. Is this asking about a SINGLE deal (the current channel's deal) or about MULTIPLE deals / historical patterns / cross-deal trends / comparisons with other deployments?
2. If cross-deal, extract 2-5 search keywords that would help find relevant deals in HubSpot (company names, industries, locations, product types, etc.).

Examples of cross-deal questions:
- "have we run into any concerns deploying to alcohol companies?" → cross-deal, keywords: ["alcohol"]
- "any similar deployments in Texas?" → cross-deal, keywords: ["Texas"]
- "have we sold to hospitals before?" → cross-deal, keywords: ["hospital"]
- "what other Neptune deals have we done?" → cross-deal, keywords: ["Neptune"]

Examples of single-deal questions:
- "who is the sales owner?" → single
- "what was the most recent email?" → single
- "what product did we sell?" → single
- "did anyone drop the ball?" → single

Question: "${question}"

Respond: {"scope": "single" or "cross-deal", "keywords": ["keyword1", "keyword2"]}`;

    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      { model: "gpt-4.1-mini", input: prompt },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: CLASSIFY_TIMEOUT_MS
      }
    );

    const output = resp.data?.output || [];
    const text = output
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("")
      .trim();

    // Parse JSON from response (handle potential markdown wrapping)
    const jsonStr = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    return {
      scope: parsed.scope === "cross-deal" ? "cross-deal" : "single",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : []
    };
  } catch (err) {
    console.error("[classifyQuestion] error:", err.message);
    return { scope: "single", keywords: [] };
  }
}

export function buildQAPrompt({ question, dealData, threadContext, hubspotData, channelHistory, crossDealResults }) {
  const {
    dealName,
    hubspotDealUrl,
    ownerLine,
    csmLine,
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
- CSM: ${csmLine || "Not found in HubSpot records — check emails/Slack for CSM mentions"}
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
${crossDealResults ? `
Cross-Deal Search Results (deal metadata only — full activity histories are not available for these deals):
${crossDealResults}

NOTE: The above are summaries of other deals in your HubSpot portal that may be relevant to the question. Use them to identify patterns, prior experience, or historical context across deals.
` : ""}
Rules:
- CRITICAL: Use the structured deal data (amount, deal type, products/line items, deal stage) as ground truth. Do NOT infer product names, deal type, financial details, or deal structure from email or meeting content — emails may discuss multiple products or options that were not part of the final deal.
- Answer directly and concisely. Use 1-3 sentences for simple questions, more for questions requiring detail.
- HubSpot data (deal properties, activity timeline, emails, calls, meetings, notes) is the PRIMARY source for all deal-related questions — what was sold, how the deal progressed, who was involved, customer temperament, risks, holdups, etc.
- Slack channel history is SUPPLEMENTARY context. Use it for: what the team has discussed recently, post-close coordination updates, or when the user's question explicitly references a Slack conversation. Do NOT use Slack channel chatter as evidence for what happened during the sales process — that comes from HubSpot.
- When the question is about the sales process, deal history, customer behavior, or pre-close activity, answer primarily from the HubSpot activity timeline. Only reference Slack if it adds genuinely new information not in HubSpot.
- Thread conversation history is useful for understanding follow-up context within the current conversation with DeCo.
- When asked about customer temperament, deal history, holdups, or risks, draw from the full activity timeline — not just the most recent entry.
- If data is missing from both sources, say "Not found in HubSpot records or channel history."
- Use conversational tone. Reference sources when helpful (e.g., "Based on an email from Jan 15..." or "In the channel discussion...").
- Do not invent facts. Only use information provided above.
- Reference previous thread messages if relevant to the question.
- If the question is clearly unrelated to the deal, customer, or business context (e.g., sports, pop culture, personal questions), respond with a brief, witty one-liner that playfully redirects back to the deal. Keep it to one sentence. Have fun with it — you're talking to coworkers, not writing a legal brief.

Answer the question:`;

  return prompt;
}
