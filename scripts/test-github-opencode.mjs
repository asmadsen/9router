#!/usr/bin/env node

const baseUrl = (process.env.BASE_URL || "http://localhost:20127/v1").replace(/\/$/, "");
const model = process.env.MODEL || "gh/gpt-5.6-terra";
const apiKey = process.env.API_KEY;
const timeoutMs = Number.parseInt(process.env.TIMEOUT_MS || "60000", 10);
const casePattern = process.env.CASE ? new RegExp(process.env.CASE, "i") : null;

const headers = { "Content-Type": "application/json" };
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

const longInstructions = [
  "You are a pragmatic software engineer. Inspect the repository before answering.",
  "Use tools when needed. Keep responses concise and factual.",
  "Never expose secrets. Preserve unrelated worktree changes.",
].join("\n\n").repeat(100);

const tools = Array.from({ length: 15 }, (_, index) => ({
  type: "function",
  function: {
    name: `test_tool_${index + 1}`,
    description: `Diagnostic tool ${index + 1} for reading repository information.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative path" },
        query: { type: "string", description: "Optional search query" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
}));

const enumOneOfTool = {
  type: "function",
  function: {
    name: "enum_oneof_tool",
    description: "Exercises OpenCode's enum annotations.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write"],
          oneOf: [
            { const: "read", description: "Read data" },
            { const: "write", description: "Write data" },
          ],
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    strict: true,
  },
};

function schemaVariant(name, actionSchema) {
  return {
    type: "function",
    function: {
      name,
      description: "Exercises described enum alternatives.",
      parameters: {
        type: "object",
        properties: { action: actionSchema },
        required: ["action"],
        additionalProperties: false,
      },
      strict: true,
    },
  };
}

const describedChoices = [
  { const: "read", description: "Read data" },
  { const: "write", description: "Write data" },
];

const cases = [
  { name: "minimal", instructions: "Reply with exactly OK.", tools: [] },
  { name: "large-instructions", instructions: longInstructions, tools: [] },
  { name: "one-tool", instructions: "Reply with exactly OK without calling tools.", tools: tools.slice(0, 1) },
  { name: "one-tool-no-strict", instructions: "Reply with exactly OK without calling tools.", tools: tools.slice(0, 1).map(({ function: fn, ...tool }) => ({ ...tool, function: { ...fn, strict: undefined } })) },
  { name: "five-tools", instructions: "Reply with exactly OK without calling tools.", tools: tools.slice(0, 5) },
  { name: "fifteen-tools", instructions: "Reply with exactly OK without calling tools.", tools },
  { name: "enum-oneof-tool", instructions: "Reply with exactly OK without calling tools.", tools: [enumOneOfTool] },
  { name: "opencode-like", instructions: longInstructions, tools },
].filter((testCase) => !casePattern || casePattern.test(testCase.name));

function inspectSse(text) {
  const events = [];
  let output = "";
  let incompleteReason = null;
  let error = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type) events.push(parsed.type);
      output += parsed.choices?.[0]?.delta?.content || "";
      output += parsed.delta && parsed.type === "response.output_text.delta" ? parsed.delta : "";
      incompleteReason ||= parsed.response?.incomplete_details?.reason || parsed.incomplete_details?.reason || null;
      error ||= parsed.error?.message || parsed.response?.error?.message || null;
    } catch {
      error ||= "Invalid SSE JSON";
    }
  }

  return { events, output, incompleteReason, error };
}

async function run(testCase) {
  const body = {
    model,
    stream: true,
    max_tokens: 1024,
    reasoning_effort: "medium",
    messages: [
      { role: "system", content: testCase.instructions },
      { role: "user", content: "Reply with exactly OK. Do not call tools." },
    ],
    ...(testCase.tools.length ? { tools: testCase.tools, tool_choice: "auto" } : {}),
  };

  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const result = inspectSse(text);
    let jsonError = null;
    if (!response.ok) {
      try {
        const parsed = JSON.parse(text);
        jsonError = parsed?.error?.message || parsed?.error || parsed?.message || null;
      } catch { /* SSE or non-JSON response */ }
    }
    const ok = response.ok && result.output.trim().length > 0 && !result.incompleteReason && !result.error;
    console.log(JSON.stringify({
      case: testCase.name,
      ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      request: {
        instructionChars: testCase.instructions.length,
        tools: testCase.tools.length,
      },
      response: {
        output: result.output.slice(0, 200),
        incompleteReason: result.incompleteReason,
        error: jsonError || result.error,
        eventTypes: [...new Set(result.events)],
      },
    }));
    return ok;
  } catch (error) {
    console.log(JSON.stringify({
      case: testCase.name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error.message,
    }));
    return false;
  }
}

console.log(`Testing ${model} via ${baseUrl}`);
const results = [];
for (const testCase of cases) results.push(await run(testCase));
const passed = results.filter(Boolean).length;
console.log(`Summary: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
