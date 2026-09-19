# Wanderly Travel Agent

旅行助手智能体的前端原型。

直接在浏览器中打开 `index.html` 即可体验：欢迎页使用 `Photos/` 下的旅行图片，并每 3 秒自动切换；右上角按钮可手动切图。点击 `START` 后可体验需求输入、确认需求与逐日行程查看流程。

## 数据模型

旅行对象、AI 输出格式与局部重规划约定见 [docs/mvp-data-model.md](docs/mvp-data-model.md)。共享 TypeScript 类型位于 `src/types/trip.ts`，JSON Schema 位于 `schemas/trip.schema.json`。

## 本地服务与数据库

项目使用 Node.js 内置 HTTP 与 SQLite 能力，无需安装依赖。运行 `npm start` 后，在 `http://localhost:3000` 打开网页；API 与 SQLite 数据库会一同启动。接口说明见 [docs/api.md](docs/api.md)。

## AI 行程生成

将 `.env.example` 复制为 `.env`，设置 `DEEPSEEK_API_KEY` 后，服务端会使用 DeepSeek Responses API 先识别自然语言中的人数、天数、预算、目的地、模糊时间与偏好，再生成结构化行程。确认页支持直接编辑或继续补充需求；目的地、天数和人数补齐前不会创建数据库草稿。密钥只在服务端环境变量中使用；具体接口与输出规则见 [docs/api.md](docs/api.md)。

生成后的行程支持调整整段或指定日期，并可锁定某一天或某个活动。服务端会强制保护锁定内容，同时保存每次 AI 修改的摘要、预算变化和版本记录。

“我的行程”页面会读取 SQLite 中的旅行记录，支持按状态筛选、继续草稿、打开已生成行程以及归档和恢复旅行。
