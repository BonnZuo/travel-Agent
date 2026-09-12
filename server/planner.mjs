import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "itinerary-generation.schema.json");
const itinerarySchema = JSON.parse(await readFile(schemaPath, "utf8"));
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";

function outputText(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  return response.output?.flatMap((item) => item.content ?? []).find((content) => content.type === "output_text")?.text;
}

function generationError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validatePlan(plan, durationDays) {
  if (!plan || typeof plan.title !== "string" || !Array.isArray(plan.itinerary)) throw generationError("模型返回的行程格式无效");
  if (plan.itinerary.length !== durationDays) throw generationError(`模型返回 ${plan.itinerary.length} 天行程，与请求的 ${durationDays} 天不一致`);
  const dayNumbers = plan.itinerary.map((day) => day.dayNumber).sort((a, b) => a - b);
  if (!dayNumbers.every((dayNumber, index) => dayNumber === index + 1)) throw generationError("模型返回的日期编号不连续");
  return plan;
}

export async function generateItinerary(trip) {
  if (!process.env.OPENAI_API_KEY) throw generationError("未配置 OPENAI_API_KEY，无法生成 AI 行程", 503);
  const input = {
    origin: trip.origin, destinations: trip.destinations, startDate: trip.startDate,
    endDate: trip.endDate, durationDays: trip.durationDays, travelers: trip.travelers,
    budget: trip.budget, preferences: trip.preferences, originalPrompt: trip.originalPrompt
  };
  const apiResponse = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: { "authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5",
      store: false,
      instructions: "你是旅行规划助手。仅根据用户提供的约束生成一份可执行、节奏合理的旅行计划。每天按地理邻近性安排 2 到 4 个主要活动；城市间移动日降低活动强度；保留用户限制条件。不要编造实时价格、营业时间、签证或天气事实；在不确定时用通用提醒写入 notes 或 tip。所有预算均为估算区间。输出必须符合指定 JSON Schema，且不添加解释文字。",
      input: `请为以下旅行生成行程：\n${JSON.stringify(input)}`,
      text: { format: { type: "json_schema", name: "travel_itinerary", strict: true, schema: itinerarySchema } }
    })
  });
  const response = await apiResponse.json();
  if (!apiResponse.ok) throw generationError(response.error?.message || "OpenAI API 请求失败", apiResponse.status);
  const text = outputText(response);
  if (!text) throw generationError("OpenAI API 未返回行程内容");
  let plan;
  try { plan = JSON.parse(text); } catch { throw generationError("OpenAI API 返回的内容不是 JSON"); }
  validatePlan(plan, trip.durationDays);
  return {
    title: plan.title,
    itinerary: plan.itinerary.map((day) => ({
      ...day,
      id: randomUUID(),
      date: trip.startDate || `第 ${day.dayNumber} 天`,
      activities: day.activities.map((activity) => ({ ...activity, id: randomUUID(), locked: false })),
      locked: false
    }))
  };
}
