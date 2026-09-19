import assert from "node:assert/strict";
import test from "node:test";
import { extractTripIntent, reviseItinerary } from "./planner.mjs";

const baseIntent = (overrides = {}) => ({
  origin: "济南",
  destinations: ["新疆"],
  travelTiming: "十月",
  durationDays: 7,
  travelers: { count: 2, tripType: "friends" },
  budget: { perPerson: 5000, currency: "CNY", hasBudget: true },
  preferences: { interests: ["自然"], pace: "balanced", avoid: [], constraints: [] },
  followUpQuestions: [],
  ...overrides
});

async function withMockedDeepSeek(payload, run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ output_text: JSON.stringify(payload) })
  });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
}

test("完整需求由 AI 解析后可直接生成", { concurrency: false }, async () => {
  await withMockedDeepSeek(baseIntent(), async () => {
    const result = await extractTripIntent("十月份从济南去新疆旅游，两个人，人均5000，大概7天行程");
    assert.equal(result.isReady, true);
    assert.deepEqual(result.missingFields, []);
    assert.equal(result.intent.travelers.count, 2);
    assert.equal(result.intent.durationDays, 7);
    assert.equal(result.intent.budget.perPerson, 5000);
    assert.equal(result.intent.travelers.tripType, "friends");
  });
});

test("缺失核心字段时返回 AI 追问而不标记为可生成", { concurrency: false }, async () => {
  await withMockedDeepSeek(baseIntent({
    origin: "",
    destinations: [],
    durationDays: 0,
    travelers: { count: 0, tripType: "friends" },
    budget: { perPerson: 0, currency: "CNY", hasBudget: false },
    followUpQuestions: ["想去哪里？", "大概安排几天？"]
  }), async () => {
    const result = await extractTripIntent("帮我规划一次旅行");
    assert.equal(result.isReady, false);
    assert.deepEqual(result.missingFields, ["destinations", "durationDays", "travelers"]);
    assert.deepEqual(result.followUpQuestions, ["想去哪里？", "大概安排几天？"]);
  });
});

test("补充需求只更新用户明确修改的人数", { concurrency: false }, async () => {
  const currentIntent = {
    originalPrompt: "十月份从济南去新疆旅游，两个人，人均5000，大概7天行程",
    origin: "济南",
    destinations: ["新疆"],
    travelTiming: "十月",
    durationDays: 7,
    travelers: { count: 2, tripType: "friends" },
    budget: { perPerson: 5000, currency: "CNY", categories: {} },
    preferences: { interests: ["自然"], pace: "balanced", avoid: [], constraints: [] }
  };
  await withMockedDeepSeek(baseIntent({ travelers: { count: 3, tripType: "friends" } }), async () => {
    const result = await extractTripIntent("改成 3 个人", currentIntent);
    assert.equal(result.intent.travelers.count, 3);
    assert.deepEqual(result.intent.destinations, ["新疆"]);
    assert.equal(result.intent.durationDays, 7);
    assert.deepEqual(result.changedFields, ["travelers"]);
  });
});

test("局部重规划只修改指定日期并保留锁定活动", { concurrency: false }, async () => {
  const money = { min: 100, max: 200, currency: "CNY" };
  const activity = (id, title, locked = false) => ({ id, title, category: "attraction", timeSlot: "morning", durationMinutes: 120, reason: "测试", notes: [], reservationRequired: false, locked });
  const trip = {
    id: "trip-1",
    version: 2,
    title: "新疆之旅",
    destinations: ["新疆"],
    durationDays: 2,
    travelers: { count: 2, tripType: "friends" },
    budget: { perPerson: 1000, currency: "CNY", categories: {} },
    preferences: { interests: [], pace: "balanced", avoid: [], constraints: [] },
    itinerary: [
      { id: "day-1", dayNumber: 1, date: "第 1 天", city: "乌鲁木齐", theme: "旧主题一", activities: [activity("a-1", "旧活动一")], estimatedBudget: money, tip: "旧提示", locked: false },
      { id: "day-2", dayNumber: 2, date: "第 2 天", city: "乌鲁木齐", theme: "旧主题二", activities: [activity("a-2", "必须保留", true), activity("a-3", "可替换")], estimatedBudget: money, tip: "旧提示", locked: false }
    ]
  };
  const revisedByModel = {
    title: "新疆轻松之旅",
    changeSummary: ["第二天减少活动"],
    budgetSummary: {
      totalPerPerson: { min: 700, max: 900, currency: "CNY" },
      transport: { min: 250, max: 300, currency: "CNY" },
      accommodation: { min: 180, max: 240, currency: "CNY" },
      food: { min: 120, max: 160, currency: "CNY" },
      activities: { min: 50, max: 80, currency: "CNY" },
      contingency: { min: 100, max: 120, currency: "CNY" }
    },
    itinerary: [
      { dayNumber: 1, city: "吐鲁番", theme: "模型不应改动", activities: [{ title: "错误改动", category: "nature", timeSlot: "morning", durationMinutes: 60, reason: "测试", notes: [], reservationRequired: false }], estimatedBudget: money, tip: "模型改动" },
      { dayNumber: 2, city: "乌鲁木齐", theme: "轻松漫步", activities: [{ title: "新活动", category: "nature", timeSlot: "afternoon", durationMinutes: 90, reason: "更轻松", notes: [], reservationRequired: false }], estimatedBudget: { min: 80, max: 150, currency: "CNY" }, tip: "放慢节奏" }
    ]
  };
  await withMockedDeepSeek(revisedByModel, async () => {
    const result = await reviseItinerary(trip, { instruction: "第二天轻松一点", scope: "days", affectedDayNumbers: [2], preserveLockedItems: true });
    assert.deepEqual(result.itinerary[0], trip.itinerary[0]);
    assert.equal(result.itinerary[1].theme, "轻松漫步");
    assert.equal(result.itinerary[1].activities[0].id, "a-2");
    assert.equal(result.itinerary[1].activities[0].locked, true);
    assert.deepEqual(result.revision.affectedDayNumbers, [2]);
    assert.equal(result.revision.previousVersion, 2);
    assert.equal(result.revision.version, 3);
    assert.equal(result.budgetEstimate.totalPerPerson.max, 900);
    assert.equal(result.budgetEstimate.status, "near_limit");
  });
});
