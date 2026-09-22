#!/usr/bin/env node

const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:20127").replace(/\/$/, "");
const apiKey = process.env.API_KEY;
const modelPrefix = process.env.MODEL_PREFIX ?? "";
const modelPattern = process.env.MODEL_PATTERN ? new RegExp(process.env.MODEL_PATTERN, "i") : null;
const concurrency = Math.max(1, Number.parseInt(process.env.CONCURRENCY || "1", 10));
const timeoutMs = Math.max(1_000, Number.parseInt(process.env.TIMEOUT_MS || "120000", 10));
const maxTokens = Math.max(64, Number.parseInt(process.env.MAX_TOKENS || "512", 10));
const reasoningEffort = process.env.REASONING_EFFORT || "medium";
const requireReasoning = process.env.REQUIRE_REASONING === "true";
const outputJson = process.argv.includes("--json");

if (!apiKey) {
  console.error("Missing API_KEY. Example: API_KEY=sk-... node scripts/test-all-models-reasoning.mjs");
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

async function readJsonResponse(response) {
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
  const { text, json } = await readJsonResponse(response);
  if (!response.ok) throw new Error(`GET /v1/models returned ${response.status}: ${text.slice(0, 500)}`);

  return (Array.isArray(json?.data) ? json.data : [])
    .filter((model) => typeof model?.id === "string")
    .filter((model) => !modelPrefix || model.id.startsWith(modelPrefix))
    .filter((model) => !modelPattern || modelPattern.test(model.id));
}

function consumeEvent(eventText, result) {
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      result.doneEvents += 1;
      continue;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      result.parseErrors += 1;
      continue;
    }

    if (event.type) result.eventTypes.add(event.type);
    const choice = event.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content;
    if (typeof delta.reasoning === "string") result.reasoning += delta.reasoning;
    if (typeof delta.content === "string") result.content += delta.content;
    if (Array.isArray(delta.tool_calls)) result.toolCallChunks += delta.tool_calls.length;
    if (event.usage) result.usage = event.usage;
    if (event.model) result.responseModel = event.model;
    if (choice?.finish_reason) result.finishReason = choice.finish_reason;
  }
}

async function testModel(model) {
  const startedAt = Date.now();
  const result = {
    model: model.id,
    reasoningAdvertised: model.capabilities?.reasoning === true,
    ok: false,
    status: null,
    durationMs: 0,
    responseModel: null,
    reasoning: "",
    content: "",
    toolCallChunks: 0,
    finishReason: null,
    usage: null,
    doneEvents: 0,
    parseErrors: 0,
    eventTypes: new Set(),
    leakedThinkTags: false,
    error: null,
  };

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: model.id,
        stream: true,
        max_tokens: maxTokens,
        reasoning_effort: reasoningEffort,
        messages: [{
          role: "user",
          content: "Reason step by step about 137 * 421, then give the final result in one short sentence.",
        }],
      }),
    });
    result.status = response.status;

    if (!response.ok || !response.body) {
      const { text, json } = await readJsonResponse(response);
      result.error = String(json?.error?.message || json?.error || text || `HTTP ${response.status}`).slice(0, 1000);
      return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : events.pop() || "";
      for (const event of events) consumeEvent(event, result);
      if (done) {
        if (buffer.trim()) consumeEvent(buffer, result);
        break;
      }
    }

    result.leakedThinkTags = /<\/?think>/i.test(result.content);
    const hasOutput = result.content.trim().length > 0 || result.toolCallChunks > 0;
    const reasoningMissing = result.reasoningAdvertised && result.reasoning.trim().length === 0;
    result.ok = hasOutput && !result.leakedThinkTags && (!requireReasoning || !reasoningMissing);
    if (!hasOutput) result.error = "No assistant content or tool calls";
    else if (result.leakedThinkTags) result.error = "Literal <think> tags leaked into content";
    else if (requireReasoning && reasoningMissing) result.error = "Reasoning advertised but no reasoning_content received";
    return result;
  } catch (error) {
    result.error = error?.name === "TimeoutError" ? `Timed out after ${timeoutMs}ms` : error.message;
    return result;
  } finally {
    result.durationMs = Date.now() - startedAt;
    result.eventTypes = [...result.eventTypes];
    result.reasoning = result.reasoning.slice(0, 1000);
    result.content = result.content.slice(0, 1000);
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
        const reasoning = result.reasoning.length > 0
          ? `reasoning=${result.reasoning.length}B`
          : result.reasoningAdvertised ? "reasoning=MISSING" : "reasoning=n/a";
        console.log(`${result.ok ? "PASS" : "FAIL"} ${result.model} ${result.status ?? "NETWORK"} ${result.durationMs}ms ${reasoning} content=${result.content.length}B${result.error ? ` - ${result.error}` : ""}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, runWorker));
  return results;
}

try {
  const models = await fetchModels();
  if (models.length === 0) throw new Error("No models matched");
  if (!outputJson) {
    console.log(`Testing reasoning for ${models.length} model(s) at effort=${reasoningEffort}`);
  }

  const results = await runPool(models, concurrency, testModel);
  const passed = results.filter((result) => result.ok).length;
  const advertised = results.filter((result) => result.reasoningAdvertised);
  const summaries = advertised.filter((result) => result.reasoning.length > 0);
  const leaked = results.filter((result) => result.leakedThinkTags);
  const summary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    reasoningAdvertised: advertised.length,
    reasoningSummariesReceived: summaries.length,
    leakedThinkTags: leaked.length,
    reasoningEffort,
    requireReasoning,
    results,
  };

  if (outputJson) console.log(JSON.stringify(summary, null, 2));
  else console.log(`\nSummary: ${passed}/${results.length} passed; reasoning summaries ${summaries.length}/${advertised.length} advertised; leaked tags ${leaked.length}`);
  if (passed !== results.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
