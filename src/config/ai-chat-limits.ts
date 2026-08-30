import "dotenv/config";
import { z } from "zod";

export const AI_CHAT_ANSWER_MAX_LENGTH_DEFAULT = 50_000;
export const AI_CHAT_ANSWER_MAX_LENGTH_MIN = 1;
export const AI_CHAT_ANSWER_MAX_LENGTH_MAX = 500_000;

export const aiChatAnswerMaxLengthSchema = z.coerce
  .number()
  .int()
  .min(AI_CHAT_ANSWER_MAX_LENGTH_MIN)
  .max(AI_CHAT_ANSWER_MAX_LENGTH_MAX)
  .default(AI_CHAT_ANSWER_MAX_LENGTH_DEFAULT);

export function getAiChatAnswerMaxLength(value: unknown = process.env.AI_CHAT_ANSWER_MAX_LENGTH) {
  return aiChatAnswerMaxLengthSchema.parse(value);
}
