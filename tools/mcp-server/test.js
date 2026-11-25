// Offline tests: node test.js
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.TAK_PORTAL_MCP_NO_MAIN = "1";
const { buildServer } = await import("./server.js");
const { createPortalClient } = await import("./client.js");
const { parseDelimited, readSpreadsheet } = await import("./sheets.js");

// --- client config checks and request shape ---
assert.throws(() => createPortalClient({ baseUrl: "", token: "tpk_x" }), /TAK_PORTAL_URL/);
assert.throws(() => createPortalClient({ baseUrl: "https://p", token: "nope" }), /TAK_PORTAL_TOKEN/);
const seen = [];
const fakeFetch = async (url, init) => {
  seen.push({ url, init });
  if (url.endsWith("/redirect")) return new Response("", { status: 302 });
  return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
};
const c = createPortalClient({ baseUrl: "https://portal.test/", token: "tpk_abc", fetchImpl: fakeFetch });
await c.validateUsers([{ badge: "1" }]);
assert.strictEqual(seen[0].url, "https://portal.test/api/v1/users/validate");
assert.strictEqual(seen[0].init.headers.Authorization, "Bearer tpk_abc");
assert.deepStrictEqual(JSON.parse(seen[0].init.body), { users: [{ badge: "1" }] });
const redirecting = createPortalClient({
  baseUrl: "https://portal.test",
  token: "tpk_abc",
  fetchImpl: async () => new Response("", { status: 302 }),
});
await assert.rejects(redirecting.me(), /redirected/);
const failing = createPortalClient({
  baseUrl: "https://portal.test",
  token: "tpk_abc",
  fetchImpl: async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 }),
});
await assert.rejects(failing.me(), /nope/);

// --- spreadsheets ---
assert.deepStrictEqual(parseDelimited('a,b\n"x, y","he said ""hi"""\r\n\n1,2'), [
  ["a", "b"],
  ["x, y", 'he said "hi"'],
  ["1", "2"],
]);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tpmcp-"));
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Roster");
ws.addRow(["Badge", "First", "Last", "Email"]);
ws.addRow([1001, "John", "Doe", { text: "john@example.org", hyperlink: "mailto:john@example.org" }]);
ws.addRow([1002, "Jane", "Smith", ""]);
const xlsx = path.join(dir, "roster.xlsx");
await wb.xlsx.writeFile(xlsx);
const sheet = await readSpreadsheet(xlsx);
assert.strictEqual(sheet.sheet, "Roster");
assert.deepStrictEqual(sheet.headers, ["Badge", "First", "Last", "Email"]);
assert.deepStrictEqual(sheet.rows[0], { Badge: "1001", First: "John", Last: "Doe", Email: "john@example.org" });
assert.strictEqual(sheet.rows.length, 2);
const csv = path.join(dir, "r.csv");
await fs.writeFile(csv, "﻿badge,email\n7,a@b.c\n");
assert.deepStrictEqual((await readSpreadsheet(csv)).rows, [{ badge: "7", email: "a@b.c" }]);
await fs.writeFile(path.join(dir, "old.xls"), "x");
await assert.rejects(readSpreadsheet(path.join(dir, "old.xls")), /save as \.xlsx/);

// --- MCP tool surface ---
const calls = [];
const portal = new Proxy(
  {},
  {
    get: (_, name) => async (arg) => {
      calls.push({ name, arg });
      if (name === "createUsers") throw new Error("portal said no");
      return { name };
    },
  }
);
const server = buildServer(portal);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "test", version: "1" });
await client.connect(b);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepStrictEqual(names, [
  "create_agency",
  "create_mutual_aid",
  "create_users",
  "list_agencies",
  "list_mutual_aid",
  "read_spreadsheet",
  "search_users",
  "validate_agency",
  "validate_users",
  "whoami",
]);
assert.ok(tools.find((t) => t.name === "validate_users").annotations.readOnlyHint);

const user = { badge: "1001", agency: "RCSO", firstName: "John", lastName: "Doe" };
let r = await client.callTool({ name: "validate_users", arguments: { users: [user] } });
assert.ok(!r.isError);
assert.deepStrictEqual(calls.at(-1), { name: "validateUsers", arg: [user] });
r = await client.callTool({ name: "create_users", arguments: { users: [user] } });
assert.ok(r.isError);
assert.match(r.content[0].text, /portal said no/);
r = await client.callTool({ name: "read_spreadsheet", arguments: { path: xlsx } });
assert.match(r.content[0].text, /john@example.org/);
r = await client.callTool({ name: "validate_users", arguments: { users: [{ badge: "1" }] } });
assert.ok(r.isError, "schema rejects incomplete rows");

await client.close();
await fs.rm(dir, { recursive: true, force: true });
console.log("tak-portal-mcp tests passed");
