# MVP API

启动服务：

```bash
npm start
```

服务默认监听 `http://localhost:3000`，同时托管原型网页与 API。数据库文件在 `data/travel-agent.db`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/trips` | 获取全部旅行，按最近更新排序 |
| `POST` | `/api/trips` | 创建旅行草稿 |
| `GET` | `/api/trips/:tripId` | 获取一段旅行 |
| `PATCH` | `/api/trips/:tripId` | 保存或更新旅行 |
| `POST` | `/api/trips/:tripId/generate` | 通过 AI 生成并保存结构化行程 |

## 创建旅行

```bash
curl -X POST http://localhost:3000/api/trips \
  -H 'content-type: application/json' \
  -d '{
    "originalPrompt":"10 月从上海去东京和京都 7 天，2 人，预算每人 9000。",
    "origin":"上海",
    "destinations":["东京","京都"],
    "durationDays":7,
    "travelers":{"count":2,"tripType":"couple"},
    "preferences":{"interests":["美食","红叶"],"pace":"relaxed","avoid":[],"constraints":["减少换酒店"]}
  }'
```

响应会以 `{ "trip": { ... } }` 返回创建后的完整旅行对象。

## 保存修改

`PATCH /api/trips/:tripId` 接受旅行对象的部分字段。服务端会合并嵌套的 `travelers` 与 `preferences`，递增 `version`，并更新 `updatedAt`。

```bash
curl -X PATCH http://localhost:3000/api/trips/TRIP_ID \
  -H 'content-type: application/json' \
  -d '{"status":"ready","title":"东京京都红叶之旅"}'
```

## AI 生成行程

先复制 `.env.example` 为 `.env`，在其中设置 `OPENAI_API_KEY`。密钥只在服务端读取，浏览器与数据库均不会收到该值。

```bash
cp .env.example .env
npm start
```

`POST /api/trips/:tripId/generate` 会调用 Responses API，以 `schemas/itinerary-generation.schema.json` 约束模型输出，再为每个日期与活动补充本地 ID 并保存。若缺少 API Key，接口返回 `503`，不会伪造行程。
