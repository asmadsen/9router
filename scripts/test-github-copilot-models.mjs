#!/usr/bin/env node

const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:20127").replace(/\/$/, "");
const apiKey = process.env.API_KEY;
const providerPrefix = process.env.PROVIDER_PREFIX ?? "gh/";
const modelPattern = process.env.MODEL_PATTERN ? new RegExp(process.env.MODEL_PATTERN, "i") : null;
const concurrency = Math.max(1, Number.parseInt(process.env.CONCURRENCY || "2", 10));
const timeoutMs = Math.max(1_000, Number.parseInt(process.env.TIMEOUT_MS || "60000", 10));
const maxTokens = Math.max(1, Number.parseInt(process.env.MAX_TOKENS || "16", 10));
const outputJson = process.argv.includes("--json");

if (!apiKey) {
  console.error("Missing API_KEY. Example: API_KEY=sk-... node scripts/test-github-copilot-models.mjs");
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function readResponse(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function fetchModels() {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { text, json } = await readResponse(response);
  if (!response.ok) {
    throw new Error(`GET /v1/models returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const models = Array.isArray(json?.data) ? json.data : [];
  return models
    .map((model) => model?.id)
    .filter((id) => typeof id === "string")
    .filter((id) => providerPrefix === "" ? !id.includes("/") : id.startsWith(providerPrefix))
    .filter((id) => !modelPattern || modelPattern.test(id));
}

async function testModel(model) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
    });
    const { text, json } = await readResponse(response);
    const content = json?.choices?.[0]?.message?.content;
    const error = json?.error?.message || json?.error || (!response.ok ? text : null);
    return {
      model,
      ok: response.ok && typeof content === "string",
      status: response.status,
      durationMs: Date.now() - startedAt,
      responseModel: json?.model || null,
      content: typeof content === "string" ? content.slice(0, 200) : null,
      error: error ? String(error).slice(0, 500) : null,
    };
  } catch (error) {
    return {
      model,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      responseModel: null,
      content: null,
      error: error?.name === "TimeoutError" ? `Timed out after ${timeoutMs}ms` : error.message,
    };
  }
}

async function runPool(items, workerCount, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
      if (!outputJson) {
        const result = results[index];
        const detail = result.ok ? result.content : result.error;
        console.log(`${result.ok ? "PASS" : "FAIL"} ${result.model} ${result.status ?? "NETWORK"} ${result.durationMs}ms${detail ? ` - ${detail}` : ""}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, runWorker));
  return results;
}

try {
  const models = await fetchModels();
  if (models.length === 0) {
    throw new Error(`No models matched prefix ${JSON.stringify(providerPrefix)}${modelPattern ? ` and pattern ${modelPattern}` : ""}`);
  }

  if (!outputJson) {
    console.log(`Testing ${models.length} model(s) from ${baseUrl} with concurrency ${concurrency}`);
  }
  const results = await runPool(models, concurrency, testModel);
  const passed = results.filter((result) => result.ok).length;
  const summary = { total: results.length, passed, failed: results.length - passed, results };

  if (outputJson) console.log(JSON.stringify(summary, null, 2));
  else console.log(`\nSummary: ${passed}/${results.length} passed`);

  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
