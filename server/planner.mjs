import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemasDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const [itinerarySchema, tripIntentSchema, itineraryRevisionSchema, checklistSchema] = await Promise.all([
  readFile(join(schemasDirectory, "itinerary-generation.schema.json"), "utf8").then(JSON.parse),
  readFile(join(schemasDirectory, "trip-intent.schema.json"), "utf8").then(JSON.parse),
  readFile(join(schemasDirectory, "itinerary-revision.schema.json"), "utf8").then(JSON.parse),
  readFile(join(schemasDirectory, "checklist-generation.schema.json"), "utf8").then(JSON.parse)
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

function dateForDay(startDate, dayNumber) {
  if (!startDate) return `第 ${dayNumber} 天`;
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayNumber - 1);
  return date.toISOString().slice(0, 10);
}

function materializeDay(day, trip, existingDay) {
  return {
    ...day,
    id: existingDay?.id || randomUUID(),
    date: existingDay?.date || dateForDay(trip.startDate, day.dayNumber),
    activities: day.activities.map((activity) => ({ ...activity, id: randomUUID(), locked: false })),
    locked: false
  };
}

function contentSignature(day) {
  return JSON.stringify({
    city: day.city,
    theme: day.theme,
    activities: day.activities.map(({ id, locked, ...activity }) => activity),
    estimatedBudget: day.estimatedBudget,
    tip: day.tip
  });
}

function preserveLockedActivities(existingDay, generatedDay) {
  const activities = [...generatedDay.activities];
  for (const lockedActivity of existingDay.activities.filter((activity) => activity.locked)) {
    const sameTitleIndex = activities.findIndex((activity) => activity.title.trim().toLowerCase() === lockedActivity.title.trim().toLowerCase());
    if (sameTitleIndex >= 0) activities.splice(sameTitleIndex, 1, lockedActivity);
    else activities.unshift(lockedActivity);
  }
  return { ...generatedDay, activities };
}

function normalizeMoneyRange(value, currency = "CNY") {
  const min = Math.max(0, Number(value?.min) || 0);
  const max = Math.max(min, Number(value?.max) || min);
  return { min, max, currency: value?.currency || currency };
}

function buildBudgetEstimate(plan, trip, itinerary) {
  const fallbackCurrency = trip.budget?.currency || itinerary[0]?.estimatedBudget?.currency || "CNY";
  const fallbackTotal = itinerary.reduce((total, day) => ({ min: total.min + Number(day.estimatedBudget?.min || 0), max: total.max + Number(day.estimatedBudget?.max || 0) }), { min: 0, max: 0 });
  const summary = plan.budgetSummary || {};
  const totalPerPerson = summary.totalPerPerson
    ? normalizeMoneyRange(summary.totalPerPerson, fallbackCurrency)
    : { ...fallbackTotal, currency: fallbackCurrency };
  const emptyRange = { min: 0, max: 0, currency: totalPerPerson.currency };
  const categories = {
    transport: summary.transport ? normalizeMoneyRange(summary.transport, totalPerPerson.currency) : emptyRange,
    accommodation: summary.accommodation ? normalizeMoneyRange(summary.accommodation, totalPerPerson.currency) : emptyRange,
    food: summary.food ? normalizeMoneyRange(summary.food, totalPerPerson.currency) : emptyRange,
    activities: summary.activities ? normalizeMoneyRange(summary.activities, totalPerPerson.currency) : emptyRange,
    contingency: summary.contingency ? normalizeMoneyRange(summary.contingency, totalPerPerson.currency) : emptyRange
  };
  let status = "unbudgeted";
  if (trip.budget?.perPerson > 0) {
    if (totalPerPerson.max > trip.budget.perPerson) status = "over_budget";
    else if (totalPerPerson.max >= trip.budget.perPerson * 0.85) status = "near_limit";
    else status = "sufficient";
  }
  return { totalPerPerson, categories, status };
}

function buildRecommendations(value, currency = "CNY") {
  return {
    accommodationAreas: (value?.accommodationAreas || []).slice(0, 8).map((item) => ({
      city: cleanText(item.city),
      area: cleanText(item.area),
      suitableFor: cleanText(item.suitableFor),
      advantages: cleanList(item.advantages).slice(0, 5),
      cautions: cleanList(item.cautions).slice(0, 5),
      nightlyBudget: normalizeMoneyRange(item.nightlyBudget, currency),
      recommendedNights: Math.max(0, Number.isInteger(item.recommendedNights) ? item.recommendedNights : 0)
    })).filter((item) => item.city && item.area),
    transportation: (value?.transportation || []).slice(0, 10).map((item) => ({
      segment: cleanText(item.segment),
      mode: cleanText(item.mode),
      recommendation: cleanText(item.recommendation),
      notes: cleanList(item.notes).slice(0, 5)
    })).filter((item) => item.segment && item.recommendation)
  };
}

async function deepSeekJson({ name, schema, instructions, input }) {
  if (!process.env.DEEPSEEK_API_KEY) throw generationError("未配置 DEEPSEEK_API_KEY，无法调用 AI", 503);
  const configuredTimeout = Number(process.env.DEEPSEEK_TIMEOUT_MS || 45_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000 ? Math.min(configuredTimeout, 180_000) : 45_000;
  let apiResponse;
  try {
    apiResponse = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { "authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        store: false,
        instructions,
        input,
        text: { format: { type: "json_schema", name, schema } }
      })
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw generationError(`DeepSeek API 在 ${Math.round(timeoutMs / 1000)} 秒内未响应，请稍后重试。`, 504);
    }
    throw generationError(`无法连接 DeepSeek API（${error.cause?.code || "network_error"}）。请检查网络或代理配置。`, 503);
  }
  let response;
  try {
    response = await apiResponse.json();
  } catch {
    throw generationError("DeepSeek API 返回了无法解析的响应", 502);
  }
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
    instructions: "你是旅行规划助手。originalPrompt 是用户需求的最高优先级来源。仅根据用户提供的约束生成一份可执行、节奏合理的旅行计划。每天按地理邻近性安排 2 到 4 个主要活动；城市间移动日降低活动强度；保留用户限制条件。不要编造实时价格、营业时间、签证或天气事实；在不确定时用通用提醒写入 notes 或 tip。budgetSummary 必须给出人均总预算，并分别估算大交通、住宿、餐饮、景点活动和预留金；所有预算均为同一货币的估算区间，不得伪装成实时报价。recommendations 必须给出与路线匹配的住宿区域和交通方式建议；住宿只推荐区域而非虚构酒店库存，价格使用区间；交通不虚构实时班次或票价。输出必须符合指定 JSON Schema，且不添加解释文字。",
    input: `请为以下旅行生成行程：\n${JSON.stringify(input)}`
  });
  validatePlan(plan, trip.durationDays);
  const itinerary = plan.itinerary.map((day) => materializeDay(day, trip));
  return {
    title: plan.title,
    itinerary,
    budgetEstimate: buildBudgetEstimate(plan, trip, itinerary),
    recommendations: buildRecommendations(plan.recommendations, trip.budget?.currency || "CNY")
  };
}

export async function generateChecklist(trip) {
  const result = await deepSeekJson({
    name: "travel_checklist",
    schema: checklistSchema,
    instructions: "你是旅行行前准备助手。根据旅行目的地、时间、同行人、偏好与已生成行程，生成 6 至 20 条简洁、可操作的中文准备事项。只给与这次旅行相关的事项，避免泛泛重复；对于证件、签证、保险、健康要求等可能变化的信息，使用‘核对’或‘确认’措辞，不得断言实时政策。category 必须从 documents、booking、packing、health、money、other 中选择。输出严格符合 JSON Schema，不添加解释。",
    input: JSON.stringify({
      origin: trip.origin,
      destinations: trip.destinations,
      travelTiming: trip.travelTiming,
      startDate: trip.startDate,
      durationDays: trip.durationDays,
      travelers: trip.travelers,
      preferences: trip.preferences,
      itinerary: trip.itinerary?.map((day) => ({ dayNumber: day.dayNumber, city: day.city, activities: day.activities.map((activity) => activity.title) })) || []
    })
  });
  const existingItems = trip.checklist?.items || [];
  const existingByTitle = new Map(existingItems.map((item) => [item.title.trim().toLowerCase(), item]));
  const generatedTitles = new Set();
  const generatedItems = result.items.map((item) => {
    const title = cleanText(item.title).slice(0, 160);
    const existing = existingByTitle.get(title.toLowerCase());
    generatedTitles.add(title.toLowerCase());
    return {
      id: existing?.id || randomUUID(),
      title,
      category: ["documents", "booking", "packing", "health", "money", "other"].includes(item.category) ? item.category : "other",
      reason: cleanText(item.reason).slice(0, 280),
      completed: existing?.completed || false,
      source: "ai",
      createdAt: existing?.createdAt || new Date().toISOString()
    };
  }).filter((item) => item.title);
  const manualItems = existingItems.filter((item) => item.source === "manual" && !generatedTitles.has(item.title.trim().toLowerCase()));
  const now = new Date().toISOString();
  return { id: trip.checklist?.id || randomUUID(), tripId: trip.id, items: [...generatedItems, ...manualItems], updatedAt: now };
}

export async function reviseItinerary(trip, request) {
  const instruction = cleanText(request?.instruction);
  if (!instruction) throw generationError("修改要求不能为空", 400);
  if (instruction.length > 1000) throw generationError("修改要求不能超过 1000 个字符", 400);
  const scope = request?.scope === "trip" ? "trip" : request?.scope === "days" ? "days" : undefined;
  if (!scope) throw generationError("scope 必须是 trip 或 days", 400);
  if (!Array.isArray(trip.itinerary) || trip.itinerary.length === 0) throw generationError("当前旅行尚未生成行程", 409);
  const allDayNumbers = trip.itinerary.map((day) => day.dayNumber);
  const requestedDays = scope === "trip"
    ? allDayNumbers
    : [...new Set((request.affectedDayNumbers || []).filter((dayNumber) => Number.isInteger(dayNumber) && allDayNumbers.includes(dayNumber)))].sort((a, b) => a - b);
  if (scope === "days" && requestedDays.length === 0) throw generationError("局部调整至少需要选择一天", 400);
  const editableDays = requestedDays.filter((dayNumber) => !trip.itinerary.find((day) => day.dayNumber === dayNumber)?.locked);
  if (editableDays.length === 0) throw generationError("选择的日期均已锁定，请先解锁后再调整", 409);

  const plan = await deepSeekJson({
    name: "travel_itinerary_revision",
    schema: itineraryRevisionSchema,
    instructions: "你是旅行行程修改助手。根据 instruction 修改已有完整行程，并返回修改后的完整行程。所有未列入 editableDayNumbers 的日期必须原样保留；locked:true 的日期或活动绝对不能更改、删除或移动。只处理用户明确要求的修改，不擅自改变人数、预算、目的地或旅行偏好。每天保持合理地理顺序和 2 至 4 个主要活动，不编造实时价格、营业时间、天气或签证事实。重新汇总 budgetSummary 中的人均总预算及大交通、住宿、餐饮、景点活动、预留金区间，并同步返回与新路线一致的住宿区域和交通建议；不得虚构酒店库存、实时班次或实时报价。changeSummary 用 1 至 6 条中文短句说明实际修改。输出必须严格符合 JSON Schema。",
    input: JSON.stringify({
      instruction,
      scope,
      editableDayNumbers: editableDays,
      trip: {
        title: trip.title,
        destinations: trip.destinations,
        durationDays: trip.durationDays,
        travelers: trip.travelers,
        budget: trip.budget,
        preferences: trip.preferences,
        budgetEstimate: trip.budgetEstimate,
        recommendations: trip.recommendations,
        itinerary: trip.itinerary
      }
    })
  });
  validatePlan(plan, trip.durationDays);
  const generatedByDay = new Map(plan.itinerary.map((day) => [day.dayNumber, day]));
  const itinerary = trip.itinerary.map((existingDay) => {
    if (!editableDays.includes(existingDay.dayNumber) || existingDay.locked) return existingDay;
    const generated = generatedByDay.get(existingDay.dayNumber);
    const materialized = materializeDay(generated, trip, existingDay);
    return preserveLockedActivities(existingDay, materialized);
  });
  const affectedDayNumbers = itinerary
    .filter((day, index) => contentSignature(day) !== contentSignature(trip.itinerary[index]))
    .map((day) => day.dayNumber);
  const budgetEstimate = buildBudgetEstimate(plan, trip, itinerary);
  const previousBudget = Number(trip.budgetEstimate?.totalPerPerson?.max || trip.itinerary.reduce((sum, day) => sum + Number(day.estimatedBudget?.max || 0), 0));
  const revisedBudget = budgetEstimate.totalPerPerson.max;
  return {
    title: plan.title || trip.title,
    itinerary,
    budgetEstimate,
    recommendations: buildRecommendations(plan.recommendations, trip.budget?.currency || "CNY"),
    revision: {
      id: randomUUID(),
      tripId: trip.id,
      instruction,
      scope,
      affectedDayNumbers,
      changeSummary: cleanList(plan.changeSummary),
      budgetDelta: revisedBudget - previousBudget,
      previousVersion: trip.version,
      version: trip.version + 1,
      createdAt: new Date().toISOString()
    }
  };
}
