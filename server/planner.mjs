import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemasDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const [itinerarySchema, tripIntentSchema] = await Promise.all([
  readFile(join(schemasDirectory, "itinerary-generation.schema.json"), "utf8").then(JSON.parse),
  readFile(join(schemasDirectory, "trip-intent.schema.json"), "utf8").then(JSON.parse)
]);
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/responses";

function outputText(response) {
  if (typeof response.output_text === "string" && response.output_text) return response.output_text;
  return response.output?.flatMap((item) => item.content ?? []).find((content) => content.type === "output_text")?.text;
}

function generationError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const coreFields = ["destinations", "durationDays", "travelers"];
const fallbackQuestions = {
  destinations: "这次旅行想去哪里？可以填写一个或多个目的地。",
  durationDays: "计划安排几天行程？",
  travelers: "这次一共有几位出行人？"
};

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}

function validCount(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function canonicalPreferences(value = {}) {
  return {
    interests: cleanList(value.interests),
    pace: ["relaxed", "balanced", "packed"].includes(value.pace) ? value.pace : "balanced",
    avoid: cleanList(value.avoid),
    constraints: cleanList(value.constraints)
  };
}

function canonicalBudget(value = {}) {
  if (!value?.hasBudget || !Number.isFinite(value.perPerson) || value.perPerson <= 0) return undefined;
  return {
    perPerson: value.perPerson,
    currency: ["CNY", "JPY", "USD", "EUR", "GBP"].includes(value.currency) ? value.currency : "CNY",
    categories: {}
  };
}

function toAiIntent(intent = {}) {
  return {
    origin: cleanText(intent.origin),
    destinations: cleanList(intent.destinations),
    travelTiming: cleanText(intent.travelTiming),
    durationDays: validCount(intent.durationDays, 1, 30) ? intent.durationDays : 0,
    travelers: {
      count: validCount(intent.travelers?.count, 1, 20) ? intent.travelers.count : 0,
      tripType: intent.travelers?.tripType || "friends"
    },
    budget: intent.budget
      ? { perPerson: intent.budget.perPerson, currency: intent.budget.currency || "CNY", hasBudget: true }
      : { perPerson: 0, currency: "CNY", hasBudget: false },
    preferences: canonicalPreferences(intent.preferences)
  };
}

export function assessTripIntent(rawIntent, { currentIntent, prompt } = {}) {
  const raw = toAiIntent(rawIntent);
  const intent = {
    originalPrompt: currentIntent?.originalPrompt ? `${currentIntent.originalPrompt}\n补充：${prompt}` : prompt,
    origin: raw.origin || undefined,
    destinations: raw.destinations,
    travelTiming: raw.travelTiming || undefined,
    startDate: currentIntent?.startDate,
    endDate: currentIntent?.endDate,
    durationDays: raw.durationDays,
    travelers: raw.travelers,
    budget: canonicalBudget(raw.budget),
    preferences: canonicalPreferences(raw.preferences)
  };
  const missingFields = coreFields.filter((field) => {
    if (field === "destinations") return intent.destinations.length === 0;
    if (field === "durationDays") return !validCount(intent.durationDays, 1, 30);
    return !validCount(intent.travelers.count, 1, 20);
  });
  const previous = currentIntent ? toAiIntent(currentIntent) : undefined;
  const changedFields = previous
    ? ["origin", "destinations", "travelTiming", "durationDays", "travelers", "budget", "preferences"].filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(raw[field]))
    : [];
  const aiQuestions = cleanList(rawIntent.followUpQuestions).slice(0, 2);
  const followUpQuestions = missingFields.length
    ? [...aiQuestions, ...missingFields.map((field) => fallbackQuestions[field])].filter((question, index, list) => list.indexOf(question) === index).slice(0, 2)
    : [];
  return { intent, isReady: missingFields.length === 0, missingFields, followUpQuestions, changedFields };
}

function validatePlan(plan, durationDays) {
  if (!plan || typeof plan.title !== "string" || !Array.isArray(plan.itinerary)) throw generationError("模型返回的行程格式无效");
  if (plan.itinerary.length !== durationDays) throw generationError(`模型返回 ${plan.itinerary.length} 天行程，与请求的 ${durationDays} 天不一致`);
  const dayNumbers = plan.itinerary.map((day) => day.dayNumber).sort((a, b) => a - b);
  if (!dayNumbers.every((dayNumber, index) => dayNumber === index + 1)) throw generationError("模型返回的日期编号不连续");
  return plan;
}

async function deepSeekJson({ name, schema, instructions, input }) {
  if (!process.env.DEEPSEEK_API_KEY) throw generationError("未配置 DEEPSEEK_API_KEY，无法调用 AI", 503);
  let apiResponse;
  try {
    apiResponse = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { "authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        store: false,
        instructions,
        input,
        text: { format: { type: "json_schema", name, schema } }
      })
    });
  } catch (error) {
    throw generationError(`无法连接 DeepSeek API（${error.cause?.code || "network_error"}）。请检查网络或代理配置。`, 503);
  }
  const response = await apiResponse.json();
  if (!apiResponse.ok) throw generationError(response.error?.message || "DeepSeek API 请求失败", apiResponse.status);
  const text = outputText(response);
  if (!text) throw generationError("DeepSeek API 未返回内容");
  try { return JSON.parse(text); } catch { throw generationError("DeepSeek API 返回的内容不是 JSON"); }
}

export async function extractTripIntent(originalPrompt, currentIntent) {
  if (!originalPrompt?.trim()) throw generationError("旅行需求不能为空", 400);
  const parsedIntent = await deepSeekJson({
    name: "travel_intent",
    schema: tripIntentSchema,
    instructions: "你是旅行需求分析助手。将用户的中文自然语言旅行需求提取为 JSON。必须准确理解中文数字，例如‘两个人’的 travelers.count 是 2。若提供 currentIntent，用户消息只是补充或修改：仅在用户明确修改某项时覆盖 currentIntent，未提及字段必须原样保留。未知出发地填空字符串，未知预算填 hasBudget:false 且 perPerson:0，未知目的地填空数组，未知天数填 0，未知旅行时间描述填空字符串。中文语境中金额未标注币种时使用 CNY。tripType 仅在用户明确给出情侣、夫妻、亲子、家庭、商务、独自等关系时对应填写；未说明同行关系且人数大于 1 时填 friends，不能仅因两个人就推断为 couple。pace 映射：慢节奏、不赶行程、轻松对应 relaxed；特种兵、紧凑对应 packed；其他对应 balanced。若目的地、天数或人数仍未知，followUpQuestions 提供最多两个简短问题；信息齐全时返回空数组。不得生成行程，不得添加解释。",
    input: JSON.stringify({ userMessage: originalPrompt, currentIntent: currentIntent ? toAiIntent(currentIntent) : undefined })
  });
  return assessTripIntent(parsedIntent, { currentIntent, prompt: originalPrompt.trim() });
}

export async function generateItinerary(trip) {
  const input = {
    origin: trip.origin, destinations: trip.destinations, travelTiming: trip.travelTiming, startDate: trip.startDate,
    endDate: trip.endDate, durationDays: trip.durationDays, travelers: trip.travelers,
    budget: trip.budget, preferences: trip.preferences, originalPrompt: trip.originalPrompt
  };
  const plan = await deepSeekJson({
    name: "travel_itinerary",
    schema: itinerarySchema,
    instructions: "你是旅行规划助手。originalPrompt 是用户需求的最高优先级来源。仅根据用户提供的约束生成一份可执行、节奏合理的旅行计划。每天按地理邻近性安排 2 到 4 个主要活动；城市间移动日降低活动强度；保留用户限制条件。不要编造实时价格、营业时间、签证或天气事实；在不确定时用通用提醒写入 notes 或 tip。所有预算均为估算区间。输出必须符合指定 JSON Schema，且不添加解释文字。",
    input: `请为以下旅行生成行程：\n${JSON.stringify(input)}`
  });
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
