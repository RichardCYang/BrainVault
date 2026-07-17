export const aiProviderIds = ["chatgpt", "gemini", "claude", "deepseek", "grok"] as const;

export type AiProviderId = (typeof aiProviderIds)[number];

export type AiChatData = {
  provider: AiProviderId;
  model: string;
  answeredAt: string;
  question: string;
  answer: string;
};

const providerLabels: Record<AiProviderId, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  deepseek: "DeepSeek",
  grok: "Grok"
};

const limits = {
  questionLength: 8_000,
  answerLength: 12_000,
  modelLength: 120
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeText(value: unknown, maxLength: number) {
  return (value === null || value === undefined ? "" : String(value)).replace(/\u0000/g, "").slice(0, maxLength);
}

function normalizeProvider(value: unknown): AiProviderId {
  const candidate = typeof value === "string" ? value.toLowerCase() : "";
  return (aiProviderIds as readonly string[]).includes(candidate) ? (candidate as AiProviderId) : "chatgpt";
}

function normalizeAnsweredAt(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().slice(0, 16);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute)
  ) {
    return "";
  }
  return normalized;
}

export function getAiProviderLabel(provider: AiProviderId) {
  return providerLabels[provider];
}

export function getAiChatData(metadata: unknown): AiChatData {
  const root = asRecord(metadata);
  const source = asRecord(root.aiChat);
  return {
    provider: normalizeProvider(source.provider),
    model: normalizeText(source.model, limits.modelLength).trim(),
    answeredAt: normalizeAnsweredAt(source.answeredAt),
    question: normalizeText(source.question, limits.questionLength),
    answer: normalizeText(source.answer, limits.answerLength)
  };
}

export function normalizeAiChatMetadata(metadata: unknown): Record<string, unknown> & { aiChat: AiChatData } {
  const root = asRecord(metadata);
  return { ...root, aiChat: getAiChatData(root) };
}

export function summarizeAiChatData(data: AiChatData) {
  return [
    `${getAiProviderLabel(data.provider)}${data.model ? ` · ${data.model}` : ""}`,
    data.answeredAt,
    data.question,
    data.answer
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20_000);
}
