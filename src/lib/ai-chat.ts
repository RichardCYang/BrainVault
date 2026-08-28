export const aiProviderIds = ["chatgpt", "gemini", "claude", "deepseek", "grok"] as const;
export const aiChatLayouts = ["stacked", "paginated"] as const;

export type AiProviderId = (typeof aiProviderIds)[number];
export type AiChatLayout = (typeof aiChatLayouts)[number];

export type AiChatTurn = {
  answeredAt: string;
  question: string;
  answer: string;
};

export type AiChatData = {
  title: string;
  provider: AiProviderId;
  model: string;
  layout: AiChatLayout;
  hideAnswerBorder: boolean;
  turns: AiChatTurn[];
};

const providerLabels: Record<AiProviderId, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  deepseek: "DeepSeek",
  grok: "Grok"
};

const limits = {
  titleLength: 120,
  turns: 50,
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

function normalizeLayout(value: unknown): AiChatLayout {
  return value === "paginated" ? "paginated" : "stacked";
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

function normalizeTurn(value: unknown): AiChatTurn {
  const source = asRecord(value);
  return {
    answeredAt: normalizeAnsweredAt(source.answeredAt),
    question: normalizeText(source.question, limits.questionLength),
    answer: normalizeText(source.answer, limits.answerLength)
  };
}

export function getAiProviderLabel(provider: AiProviderId) {
  return providerLabels[provider];
}

export function getAiChatData(metadata: unknown): AiChatData {
  const root = asRecord(metadata);
  const source = asRecord(root.aiChat);
  const rawTurns = Array.isArray(source.turns)
    ? source.turns.slice(0, limits.turns)
    : [source];
  const turns = rawTurns.map(normalizeTurn);

  return {
    title: normalizeText(source.title, limits.titleLength).trim(),
    provider: normalizeProvider(source.provider),
    model: normalizeText(source.model, limits.modelLength).trim(),
    layout: normalizeLayout(source.layout),
    hideAnswerBorder: source.hideAnswerBorder === true,
    turns: turns.length ? turns : [normalizeTurn({})]
  };
}

export function normalizeAiChatMetadata(metadata: unknown): Record<string, unknown> & { aiChat: AiChatData } {
  const root = asRecord(metadata);
  return { ...root, aiChat: getAiChatData(root) };
}

export function summarizeAiChatData(data: AiChatData) {
  const sections = [
    data.title,
    `${getAiProviderLabel(data.provider)}${data.model ? ` · ${data.model}` : ""}`,
    ...data.turns.flatMap((turn, index) => [
      `Question ${index + 1}`,
      turn.answeredAt,
      turn.question,
      turn.answer
    ])
  ];

  return sections
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20_000);
}
