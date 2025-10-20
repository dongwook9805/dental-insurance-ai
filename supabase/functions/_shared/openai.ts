import { MODELS } from "./models.ts";
import { getEnv } from "./env.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

async function openaiFetch<T>(
  path: string,
  init: RequestInit & { body: Record<string, unknown> },
): Promise<T> {
  const apiKey = getEnv("OPENAI_API_KEY");
  const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(init.body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }
  return await response.json() as T;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const result = await openaiFetch<{
    data: Array<{ embedding: number[] }>;
  }>("/embeddings", {
    body: {
      input: text,
      model: MODELS.embed,
    },
  });
  return result.data[0].embedding;
}

export async function getGroundedSummary(
  context: string,
  question: string,
): Promise<string> {
  const systemPrompt = [
    "당신은 치과 보험 심사 담당자입니다.",
    "주어진 컨텍스트만 활용해 3문장 이내의 한국어 단락으로 핵심을 정리하세요.",
    "컨텍스트에 없는 정보는 쓰지 마세요.",
    "빈 문자열이나 공백만 반환하지 말고, 최소 30자 이상으로 작성하세요.",
    "답변이 길어져도 중간에 끝나지 않도록 충분히 작성하세요.",
  ].join("\n");
  const response = await openaiFetch<{
    choices: Array<{ message: { content: string } }>;
  }>("/chat/completions", {
    body: {
      model: MODELS.chat,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `컨텍스트:\n${context}\n\n질문: ${question}`,
        },
      ],
      temperature: 1,
      max_completion_tokens: 128000,
    },
  });
  const content = response.choices[0]?.message?.content?.trim() ?? "";
  if (!content) {
    console.error("[getGroundedSummary] empty response", JSON.stringify(response));
    throw new Error("Empty summary returned from OpenAI");
  }
  return content;
}
