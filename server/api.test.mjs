import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function startTestServer(directory) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: "0", DATABASE_PATH: join(directory, "test.db"), UPLOADS_PATH: join(directory, "uploads"), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("test server did not start")), 5000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
  });
  return { child, baseUrl: `http://localhost:${port}` };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json();
  assert.equal(response.ok, true, body.error);
  return body;
}

test("照片可上传、读取并删除，元数据与文件保持一致", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "travel-agent-api-"));
  const { child, baseUrl } = await startTestServer(directory);
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const { trip } = await jsonRequest(`${baseUrl}/api/trips`, {
    method: "POST",
    body: JSON.stringify({
      originalPrompt: "去杭州 2 天，1 个人",
      destinations: ["杭州"],
      durationDays: 2,
      travelers: { count: 1, tripType: "solo" },
      preferences: { interests: [], pace: "balanced", avoid: [], constraints: [] }
    })
  });
  const exportResponse = await fetch(`${baseUrl}/api/trips/${trip.id}/export`);
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-type"), /^text\/markdown/);
  const markdown = await exportResponse.text();
  assert.match(markdown, /# 杭州之旅/);
  assert.match(markdown, /目的地：杭州/);

  const updated = await jsonRequest(`${baseUrl}/api/trips/${trip.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "杭州慢游", expectedVersion: trip.version })
  });
  assert.equal(updated.trip.version, trip.version + 1);
  const staleResponse = await fetch(`${baseUrl}/api/trips/${trip.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "过期修改", expectedVersion: trip.version })
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "VERSION_CONFLICT");

  const uploaded = await jsonRequest(`${baseUrl}/api/trips/${trip.id}/photos`, {
    method: "POST",
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      caption: "测试照片",
      dayNumber: 1
    })
  });
  assert.equal(uploaded.trip.album.photos.length, 1);
  assert.equal(uploaded.trip.album.coverPhotoId, uploaded.photo.id);
  const imageResponse = await fetch(`${baseUrl}${uploaded.photo.url}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");

  const deleted = await jsonRequest(`${baseUrl}/api/trips/${trip.id}/photos/${uploaded.photo.id}`, { method: "DELETE" });
  assert.deepEqual(deleted.album.photos, []);
  assert.equal(deleted.album.coverPhotoId, undefined);
  assert.equal((await fetch(`${baseUrl}${uploaded.photo.url}`)).status, 404);
});
