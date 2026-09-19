// Every MCP tool declares an inputSchema (what an agent may send) and reads
// `args` in its handler (what the code expects). Nothing ties the two: a
// property the handler reads but the schema never lists is one an agent
// cannot know to send, so the call quietly does less than it should. This
// scans server.js as text — the tools live in one array literal with a fixed
// shape — and fails on that direction. The reverse (declared but never read
// by name) is only reported, because some handlers hand the whole args
// object to a filter builder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

// Walk a balanced { ... } body starting just after its opening brace.
function braceBody(text, from) {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    i += 1;
  }
  return text.slice(from, i - 1);
}

// Keys at depth 0 of an object-literal body: `  foo: ...` not inside a nested {}.
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 0) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (m) keys.push(m[1]);
    }
    for (const c of line) {
      if (c === "{" || c === "[") depth += 1;
      else if (c === "}" || c === "]") depth -= 1;
    }
  }
  return keys;
}

function parseTools() {
  const tools = [];
  const nameRe = /^ {4,6}name: "([a-z_]+)",\s*$/gm;
  const starts = [];
  let m;
  while ((m = nameRe.exec(source))) starts.push({ name: m[1], at: m.index });
  starts.forEach((tool, i) => {
    const block = source.slice(tool.at, i + 1 < starts.length ? starts[i + 1].at : source.length);
    const schemaAt = block.indexOf("inputSchema:");
    const handlerAt = block.search(/async handler\(/);
    if (schemaAt < 0 || handlerAt < 0) return;
    const propsAt = block.indexOf("properties: {", schemaAt);
    const declared = propsAt >= 0 && propsAt < handlerAt
      ? topLevelKeys(braceBody(block, propsAt + "properties: {".length))
      : [];
    const argName = /async handler\((\w*)/.exec(block)[1];
    // The parameter list may itself contain braces — `handler(args, { content })`
    // — so find its closing paren first, then the body's opening brace.
    let cursor = block.indexOf("async handler(") + "async handler(".length;
    for (let depth = 1; depth > 0; cursor += 1) {
      if (block[cursor] === "(") depth += 1;
      else if (block[cursor] === ")") depth -= 1;
    }
    const bodyStart = block.indexOf("{", cursor);
    const body = braceBody(block, bodyStart + 1);
    const reads = new Set();
    if (argName) {
      for (const r of body.matchAll(new RegExp(`\\b${argName}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) reads.add(r[1]);
      for (const d of body.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${argName}\\b`, "g"))) {
        for (const part of d[1].split(",")) {
          const key = part.split(/[:=]/)[0].trim();
          if (key) reads.add(key);
        }
      }
    }
    tools.push({ name: tool.name, declared: new Set(declared), reads, wholesale: /\b(?:args|input)\b(?![?.\w])/.test(body) });
  });
  return tools;
}

const tools = parseTools();

test("parsed every tool in the array", () => {
  assert.ok(tools.length >= 30, `parsed ${tools.length} tools`);
  for (const t of tools) assert.ok(t.declared.size + t.reads.size > 0 || t.name, t.name);
});

test("a handler never reads an argument its inputSchema does not declare", () => {
  const drift = [];
  for (const t of tools) {
    const undeclared = [...t.reads].filter((k) => !t.declared.has(k)).sort();
    if (undeclared.length) drift.push(`${t.name}: reads ${undeclared.join(", ")}`);
  }
  assert.deepEqual(drift, [], "the agent cannot know to send these");
});

test("declared properties are read by name, or the handler consumes args wholesale", () => {
  const unread = [];
  for (const t of tools) {
    if (t.wholesale) continue;
    const dead = [...t.declared].filter((k) => !t.reads.has(k)).sort();
    if (dead.length) unread.push(`${t.name}: declares ${dead.join(", ")}`);
  }
  assert.deepEqual(unread, [], "declared to the agent but never read");
});
