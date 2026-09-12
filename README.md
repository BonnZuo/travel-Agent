# Wanderly Travel Agent

旅行助手智能体的前端原型。

直接在浏览器中打开 `index.html` 即可体验：欢迎页使用 `Photos/` 下的旅行图片，并每 3 秒自动切换；右上角按钮可手动切图。点击 `START` 后可体验需求输入、确认需求与逐日行程查看流程。

## 数据模型

旅行对象、AI 输出格式与局部重规划约定见 [docs/mvp-data-model.md](docs/mvp-data-model.md)。共享 TypeScript 类型位于 `src/types/trip.ts`，JSON Schema 位于 `schemas/trip.schema.json`。

## 本地服务与数据库

项目使用 Node.js 内置 HTTP 与 SQLite 能力，无需安装依赖。运行 `npm start` 后，在 `http://localhost:3000` 打开网页；API 与 SQLite 数据库会一同启动。接口说明见 [docs/api.md](docs/api.md)。

## AI 行程生成

将 `.env.example` 复制为 `.env`，设置 `OPENAI_API_KEY` 后，服务端会使用 OpenAI Responses API 生成结构化行程。密钥只在服务端环境变量中使用；具体接口与输出规则见 [docs/api.md](docs/api.md)。
