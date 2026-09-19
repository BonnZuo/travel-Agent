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
| `POST` | `/api/trips/parse` | 通过 AI 提取自然语言旅行需求 |
| `POST` | `/api/trips` | 创建旅行草稿 |
| `GET` | `/api/trips/:tripId` | 获取一段旅行 |
| `PATCH` | `/api/trips/:tripId` | 保存或更新旅行 |
| `POST` | `/api/trips/:tripId/generate` | 通过 AI 生成并保存结构化行程 |
| `GET` | `/api/trips/:tripId/revisions` | 获取行程修改历史 |
| `POST` | `/api/trips/:tripId/revisions` | AI 局部或整段重规划 |
| `PATCH` | `/api/trips/:tripId/locks` | 锁定或解锁日期、活动 |
| `GET` | `/api/trips/:tripId/export` | 下载 Markdown 行程文档 |
| `GET` | `/api/trips/:tripId/photos` | 获取旅行相册 |
| `POST` | `/api/trips/:tripId/photos` | 上传旅行照片 |
| `DELETE` | `/api/trips/:tripId/photos/:photoId` | 删除旅行照片 |

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

## AI 识别旅行需求

`POST /api/trips/parse` 会把原始自然语言交给 DeepSeek，并返回确认页使用的临时需求状态。前端不会用正则或默认人数猜测字段；例如“十月份从济南去新疆旅游，两个人，人均5000，大概7天行程”会被识别为 `travelers.count: 2`、`durationDays: 7` 和 `budget.perPerson: 5000`。

```bash
curl -X POST http://localhost:3000/api/trips/parse \
  -H 'content-type: application/json' \
  -d '{"prompt":"十月份从济南去新疆旅游，两个人，人均5000，大概7天行程"}'
```

响应格式：

```json
{
  "intent": { "destinations": ["新疆"], "durationDays": 7, "travelers": { "count": 2 } },
  "isReady": true,
  "missingFields": [],
  "followUpQuestions": [],
  "changedFields": []
}
```

当目的地、旅行天数或出行人数缺失时，`isReady` 为 `false`，`followUpQuestions` 最多返回两条 AI 追问。此时客户端仅在浏览器内保留确认状态，不会创建数据库旅行。

补充需求时，传入当前确认的 `currentIntent`。AI 只覆盖本次文本中明确修改的字段，未提及字段保持不变：

```json
{
  "prompt": "改成 3 个人，不要太赶",
  "currentIntent": { "destinations": ["新疆"], "durationDays": 7, "travelers": { "count": 2 } }
}
```

只有 `isReady` 为 `true` 且用户点击生成后，客户端才会将 `intent` 连同 `originalPrompt` 提交到 `POST /api/trips` 创建旅行草稿。

## 保存修改

`PATCH /api/trips/:tripId` 接受旅行对象的部分字段。服务端会合并嵌套的 `travelers` 与 `preferences`，递增 `version`，并更新 `updatedAt`。

前端“我的行程”使用 `GET /api/trips` 加载全部旅行，并通过更新 `status` 在 `draft`、`ready` 与 `archived` 之间切换。归档不会删除行程或照片。

```bash
curl -X PATCH http://localhost:3000/api/trips/TRIP_ID \
  -H 'content-type: application/json' \
  -d '{"status":"ready","title":"东京京都红叶之旅"}'
```

## AI 生成行程

先复制 `.env.example` 为 `.env`，或在本机创建 `.env.local` 并在其中设置 `DEEPSEEK_API_KEY`。`.env.local` 优先用于本机覆盖配置；密钥只在服务端读取，浏览器与数据库均不会收到该值。

```bash
cp .env.example .env
npm start
```

`POST /api/trips/:tripId/generate` 会调用 DeepSeek Responses API，以 `schemas/itinerary-generation.schema.json` 约束模型输出，再为每个日期与活动补充本地 ID 并保存。模型同时返回人均总预算与大交通、住宿、餐饮、景点活动、预留金五类估算区间。需求识别使用 `schemas/trip-intent.schema.json`。若缺少 API Key，接口返回 `503`，不会伪造行程。

服务端根据用户人均预算计算 `budgetEstimate.status`：

- `sufficient`：估算上限低于预算的 85%。
- `near_limit`：估算上限达到预算的 85%，但未超过预算。
- `over_budget`：估算上限超过用户预算。
- `unbudgeted`：用户未设置预算。

## 局部重规划与锁定

锁定某一天：

```bash
curl -X PATCH http://localhost:3000/api/trips/TRIP_ID/locks \
  -H 'content-type: application/json' \
  -d '{"dayNumber":3,"locked":true}'
```

锁定某个活动时额外传入 `activityId`。服务端会在重规划后强制恢复所有锁定内容，不依赖模型自行遵守。

局部调整：

```bash
curl -X POST http://localhost:3000/api/trips/TRIP_ID/revisions \
  -H 'content-type: application/json' \
  -d '{
    "instruction":"第三天减少一个景点，安排更多休息时间",
    "scope":"days",
    "affectedDayNumbers":[3],
    "preserveLockedItems":true
  }'
```

`scope: "days"` 只允许修改指定日期；`scope: "trip"` 可调整整个行程。响应包含保存后的 `trip`，以及受影响日期、修改摘要、预算变化和版本号组成的 `revision`。

测试或部署时可用 `DATABASE_PATH` 覆盖默认的 `data/travel-agent.db`。

## 分享与导出

行程页的“分享”按钮会复制形如 `/?trip=TRIP_ID` 的链接。访问该链接时，前端从当前服务实例的数据库读取行程并直接打开详情。因此，本地链接只对能访问同一服务与数据库的人有效；现阶段尚未加入公开分享令牌、账号权限或隐私脱敏。

`GET /api/trips/:tripId/export` 会下载 UTF-8 Markdown 文档，包含旅行概览、预算、逐日活动与出行提示：

```bash
curl -OJ http://localhost:3000/api/trips/TRIP_ID/export
```

## 旅行相册

MVP 使用 JSON data URL 上传 JPEG、PNG 或 WebP，每张图片最大 8 MB。图片文件保存在 `data/uploads/`，SQLite 仅保存 URL、标题、关联日期与封面等元数据。

```bash
curl -X POST http://localhost:3000/api/trips/TRIP_ID/photos \
  -H 'content-type: application/json' \
  -d '{
    "dataUrl":"data:image/png;base64,...",
    "caption":"西湖日落",
    "dayNumber":2
  }'
```

第一张上传成功的照片自动成为封面；删除封面后会自动选择下一张照片。可通过 `UPLOADS_PATH` 覆盖默认图片目录。`data/uploads/` 已被 Git 忽略。
