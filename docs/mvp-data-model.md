# MVP 数据模型与行程契约

## 目标

以同一份 `Trip` 对象贯通：用户输入、AI 需求提取、后端持久化、前端行程视图与后续局部重规划。

实现文件：

- `src/types/trip.ts`：前端与服务端共享的 TypeScript 类型。
- `schemas/trip.schema.json`：AI 输出、API 响应可使用的 JSON Schema。

## 核心对象关系

```text
Trip
├─ travelers             出行人群与无障碍需求
├─ budget                人均预算与分类预估
├─ preferences           兴趣、节奏、避雷项、限制条件
├─ travelTiming          模糊旅行时间描述（如“十月”“国庆”）
├─ album                 本次旅行的图片记录与封面
└─ itinerary[]
   └─ ItineraryDay
      ├─ activities[]    一日中的活动、住宿或交通
      ├─ estimatedBudget 当天预算
      └─ locked          是否禁止 AI 在重规划时改变
```

## 关键设计决策

### 预算使用区间

`MoneyRange` 统一使用 `min`、`max` 与 `currency`。旅行价格变化快，避免把预估费用错误表达为精确报价。

### 锁定粒度

- `ItineraryDay.locked`：锁定整个日期。
- `Activity.locked`：只锁定某个景点、餐厅或交通安排。
- 每次重规划请求默认设置 `preserveLockedItems: true`。

这样“第三天迪士尼不要变，重排其余两天”的要求可以直接实现。

### 时间字段

- 旅行日期使用 ISO `YYYY-MM-DD`。
- `travelTiming` 保留用户给出的模糊时间描述；`startDate` 是用户可选的精确出发日期。
- 设置 `startDate` 后，服务端依据 `durationDays` 自动计算 `endDate`。
- 活动的具体开始时间可选，格式为 `HH:mm`。
- 首期同时保留 `timeSlot`（上午、下午、晚上、全天），使没有准确营业时间时仍能生成合理行程。

### 旅行相册

- 一个 `Trip` 对应一个可选的 `TravelAlbum`，以 `tripId` 关联，支持历史行程暂未创建相册的情况。
- `TravelPhoto` 只保存图片 URL、缩略图 URL 与元数据；图片二进制文件应存放在对象存储，而非数据库字段中。
- 图片可关联 `dayNumber`、拍摄时间 `takenAt` 与 `place`，后续可以在每日行程中回看照片。
- `uploadStatus` 覆盖选择图片、上传中、成功和失败，前端据此展示上传进度及重试操作。
- `coverPhotoId` 仅保存照片 ID，而非复制图片地址；删除封面时由服务端推荐下一张已就绪照片或置空。

## AI 输出规则

模型生成的结果必须满足 `schemas/trip.schema.json`，并遵守：

1. 不得遗漏必填字段；未知值应省略可选字段，而不是编造。
2. `itinerary` 的天数应与 `durationDays` 一致。
3. 每日活动按真实执行顺序排列。
4. 预算均使用区间，价格、天气、营业时间等实时信息另附数据来源与查询时间。
5. 所有新的活动默认 `locked: false`；仅用户明确要求固定时才设为 `true`。

## API 载荷草案

### 创建旅行

`POST /api/trips`

```json
{
  "originalPrompt": "10 月从上海去东京和京都 7 天，2 人，预算每人 9000。",
  "origin": "上海",
  "destinations": ["东京", "京都"],
  "durationDays": 7,
  "travelers": { "count": 2, "tripType": "couple" },
  "preferences": {
    "interests": ["美食", "红叶"],
    "pace": "relaxed",
    "avoid": [],
    "constraints": ["减少换酒店"]
  }
}
```

### 需求确认（未持久化）

`POST /api/trips/parse` 返回 `TripIntentAssessment`，其中包含 `intent`、核心字段是否齐全的 `isReady`、`missingFields`、最多两条 `followUpQuestions` 和 `changedFields`。确认阶段只存在于当前浏览器会话；仅在核心字段齐全并点击生成时创建 `Trip`。

### 局部重规划

`POST /api/trips/:tripId/revisions`

```json
{
  "instruction": "京都多住一天，第三天迪士尼保持不变。",
  "scope": "days",
  "affectedDayNumbers": [4, 5, 6, 7],
  "preserveLockedItems": true
}
```

接口已实现并采用双重保护：提示模型保留锁定内容，同时服务端在写入前恢复未选择日期、锁定日期和锁定活动。每次成功修改会记录受影响日期、变更摘要、预算变化及前后版本号。

### 添加旅行照片

图片文件先通过上传接口写入对象存储，完成后再创建或更新照片元数据。`url` 应使用由服务端生成的受控访问地址。

`POST /api/trips/:tripId/photos`

```json
{
  "url": "https://cdn.example.com/trips/trip_001/photo_001.jpg",
  "thumbnailUrl": "https://cdn.example.com/trips/trip_001/photo_001-thumb.jpg",
  "caption": "傍晚的浅草寺",
  "dayNumber": 2,
  "uploadStatus": "ready"
}
```
