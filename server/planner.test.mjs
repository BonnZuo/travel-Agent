import assert from "node:assert/strict";
import test from "node:test";
import { extractTripIntent } from "./planner.mjs";

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
