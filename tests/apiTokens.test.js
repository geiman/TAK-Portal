const assert = require("assert");
const http = require("http");
const express = require("express");

const db = require("../services/db");
const agenciesStore = require("../services/agencies.service");
const usersSvc = require("../services/users.service");
const mutualAid = require("../services/mutualAid.service");
const auditSvc = require("../services/auditLog.service");
const apiTokens = require("../services/apiTokens.service");

const AGENCIES = [
  { name: "Riverbend County Sheriff's Office", suffix: "rcso", groupPrefix: "RCSO", countyAbbrev: "RBD", state: "TN" },
  { name: "Metro Valley Emergency Management", suffix: "mvem", groupPrefix: "MVEM", countyAbbrev: "MVL", state: "TN" },
];

const TEMPLATES = {
  rcso: [
    { name: "Patrol", role: "Team Member", groups: ["RCSO - Patrol"], isDefault: true, agencySuffix: "rcso" },
    { name: "Command", role: "HQ", groups: ["RCSO - Command"], isDefault: false, agencySuffix: "rcso" },
  ],
  mvem: [
    { name: "EM", role: "Team Member", groups: ["MVEM"], isDefault: false, agencySuffix: "mvem" },
    { name: "EOC", role: "HQ", groups: ["MVEM - EOC"], isDefault: false, agencySuffix: "mvem" },
  ],
};

function row(overrides = {}) {
  return {
    id: "abcdef123456",
    name: "Test token",
    token_prefix: "tpk_abcdef123456_xxxx",
    all_agencies: false,
    agency_suffixes: ["rcso"],
    can_create_agencies: false,
    can_create_mutual_aid: false,
    created_by: "matt",
    created_at: new Date().toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

async function request(server, method, path, { token, body } = {}) {
  const { port } = server.address();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // A forged identity header must be ignored on /api/v1.
  headers["X-Authentik-Username"] = "akadmin";
  headers["X-Authentik-Groups"] = "authentik Admins";
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  agenciesStore.load = () => AGENCIES.map((a) => ({ ...a }));
  usersSvc.getTemplatesForAgency = (sfx) => TEMPLATES[String(sfx).toLowerCase()] || [];
  db.query = async () => ({ rows: [], rowCount: 0 });
  const audits = [];
  auditSvc.logEvent = (e) => audits.push(e);

  // --- createUser validate-only mode runs the real checks and writes nothing ---
  {
    const directoryRepo = require("../services/directoryRepo.service");
    const templatesStore = require("../services/templates.service");
    const saved = {
      userExists: directoryRepo.userExists,
      findUsernameByEmail: directoryRepo.findUsernameByEmail,
      getGroupsByNames: directoryRepo.getGroupsByNames,
      getGroupsByPks: directoryRepo.getGroupsByPks,
      tplLoad: templatesStore.load,
      withTransaction: db.withTransaction,
    };
    templatesStore.load = () => TEMPLATES.rcso;
    directoryRepo.userExists = async (u) => u === "taken.rcso" || u === "takenrcso";
    directoryRepo.findUsernameByEmail = async (e) => (String(e).toLowerCase() === "used@x.org" ? "someone" : null);
    directoryRepo.getGroupsByNames = async (names) =>
      names.filter((n) => n === "RCSO - Patrol").map((n) => ({ pk: "g1", name: n }));
    directoryRepo.getGroupsByPks = async () => [];
    let wrote = false;
    db.withTransaction = async () => {
      wrote = true;
      throw new Error("should not write");
    };

    const base = { badge: "1001", agencySuffix: "rcso", firstName: "John", lastName: "Doe", templateIndex: "Patrol" };
    const dry = await usersSvc.createUser({ ...base, email: "john@x.org" }, { dryRun: true });
    assert.strictEqual(dry.dryRun, true);
    assert.deepStrictEqual(dry.preview.groups, ["RCSO - Patrol"]);
    assert.strictEqual(dry.preview.template, "Patrol");
    assert.deepStrictEqual(dry.warnings, []);
    const noContact = await usersSvc.createUser(base, { dryRun: true });
    assert.match(noContact.warnings.join(" "), /No email and no password/);
    await assert.rejects(usersSvc.createUser({ ...base, email: "USED@x.org" }, { dryRun: true }), /already exists/);
    await assert.rejects(usersSvc.createUser({ ...base, firstName: "" }, { dryRun: true }), /First name required/);
    await assert.rejects(usersSvc.createUser({ ...base, templateIndex: "Nope" }, { dryRun: true }), /not found/);
    await assert.rejects(usersSvc.createUser({ ...base, agencySuffix: "zzz" }, { dryRun: true }), /Invalid agency/);
    assert.strictEqual(wrote, false);

    directoryRepo.userExists = saved.userExists;
    directoryRepo.findUsernameByEmail = saved.findUsernameByEmail;
    directoryRepo.getGroupsByNames = saved.getGroupsByNames;
    directoryRepo.getGroupsByPks = saved.getGroupsByPks;
    templatesStore.load = saved.tplLoad;
    db.withTransaction = saved.withTransaction;
  }

  // --- token format / hashing ---
  const gen = apiTokens.generateToken();
  assert.ok(gen.token.startsWith("tpk_" + gen.id + "_"));
  assert.ok(apiTokens.looksLikeToken(gen.token));
  assert.ok(!apiTokens.looksLikeToken("tpk_short"));
  assert.ok(!apiTokens.looksLikeToken("Bearer " + gen.token));
  assert.strictEqual(apiTokens.hashToken(gen.token).length, 64);
  assert.notStrictEqual(apiTokens.hashToken(gen.token), gen.token);
  assert.ok(gen.tokenPrefix.length < gen.token.length - 30);
  assert.strictEqual(apiTokens.extractToken({ headers: { authorization: `Bearer ${gen.token}` } }), gen.token);
  assert.strictEqual(apiTokens.extractToken({ headers: { "x-api-key": gen.token } }), gen.token);
  assert.strictEqual(apiTokens.extractToken({ headers: {} }), "");

  // --- create input validation ---
  assert.throws(() => apiTokens.normalizeCreateInput({}), /name is required/i);
  assert.throws(() => apiTokens.normalizeCreateInput({ name: "x" }), /at least one agency/i);
  assert.throws(() => apiTokens.normalizeCreateInput({ name: "x", agencySuffixes: ["nope"] }), /Unknown agency/);
  assert.throws(
    () => apiTokens.normalizeCreateInput({ name: "x", agencySuffixes: ["rcso"], canCreateAgencies: true }),
    /Only an All agencies token/
  );
  assert.throws(() => apiTokens.normalizeCreateInput({ name: "x", allAgencies: true, expiresInDays: 0 }), /Expiration/);
  const ok = apiTokens.normalizeCreateInput({ name: " Mac ", agencySuffixes: ["RCSO", "rcso"], expiresInDays: "90" });
  assert.strictEqual(ok.name, "Mac");
  assert.deepStrictEqual(ok.agencySuffixes, ["rcso"]);
  assert.ok(ok.expiresAt && new Date(ok.expiresAt) > new Date());
  assert.strictEqual(apiTokens.normalizeCreateInput({ name: "x", allAgencies: true, expiresInDays: "" }).expiresAt, null);

  // --- token identity: agency admin only for its scope, never global ---
  const scoped = apiTokens.buildAuthUserForToken(row());
  assert.strictEqual(scoped.isGlobalAdmin, false);
  assert.strictEqual(scoped.isAgencyAdmin, true);
  assert.deepStrictEqual(scoped.allowedAgencySuffixes, ["rcso"]);
  const all = apiTokens.buildAuthUserForToken(row({ all_agencies: true, agency_suffixes: [] }));
  assert.strictEqual(all.isGlobalAdmin, false);
  assert.deepStrictEqual(all.allowedAgencySuffixes.sort(), ["mvem", "rcso"]);

  // Findings only for well-formed tokens.
  let queried = 0;
  db.query = async () => {
    queried += 1;
    return { rows: [] };
  };
  assert.strictEqual(await apiTokens.findActiveToken("garbage"), null);
  assert.strictEqual(queried, 0);
  db.query = async () => ({ rows: [], rowCount: 0 });

  // --- HTTP: /api/v1 behind the token middleware ---
  let activeRow = row();
  apiTokens.findActiveToken = async (t) => (t === gen.token ? activeRow : null);
  apiTokens.touchToken = async () => {};

  const created = [];
  usersSvc.createUser = async (payload, opts) => {
    if (!payload.firstName) throw new Error("First name required");
    const username = `${String(payload.badge).toLowerCase()}${payload.agencySuffix}`;
    const preview = {
      username,
      name: `${payload.lastName}, ${payload.firstName}`,
      email: payload.email || null,
      agencySuffix: payload.agencySuffix,
      template: payload.templateIndex,
      groups: [],
    };
    if (opts.dryRun) return { dryRun: true, preview, warnings: [] };
    created.push({ payload, opts });
    return { user: { pk: "1", username, email: payload.email, name: preview.name }, groups: [] };
  };

  const app = express();
  app.use(express.json());
  app.use("/api/v1", require("../services/apiTokenAuth.middleware"), require("../routes/apiV1.routes"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    let r = await request(server, "GET", "/api/v1/me");
    assert.strictEqual(r.status, 401, "no token, forged headers ignored");
    r = await request(server, "GET", "/api/v1/me", { token: apiTokens.generateToken().token });
    assert.strictEqual(r.status, 401, "unknown token");

    r = await request(server, "GET", "/api/v1/me", { token: gen.token });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.agencies.map((a) => a.suffix), ["rcso"]);

    r = await request(server, "GET", "/api/v1/agencies", { token: gen.token });
    assert.deepStrictEqual(r.body.map((a) => a.suffix), ["rcso"]);
    assert.strictEqual(r.body[0].templates.length, 2);

    // Validate: default template, abbreviation lookup, scope, admin refusal, in-batch dupes.
    r = await request(server, "POST", "/api/v1/users/validate", {
      token: gen.token,
      body: {
        users: [
          { badge: "1001", agency: "RCSO", firstName: "John", lastName: "Doe", email: "j@x.org" },
          { badge: "1002", agency: "mvem", firstName: "Jane", lastName: "Smith" },
          { badge: "1003", agency: "rcso", firstName: "Al", lastName: "Admin", permissions: "agency_admin" },
          { badge: "1004", agency: "rcso", firstName: "Dup", lastName: "Email", email: "J@X.org" },
          { badge: "1001", agency: "rcso", firstName: "Dup", lastName: "User" },
          { badge: "1005", agency: "rcso", firstName: "Man", lastName: "Ual", template: "Manual Group Selection" },
        ],
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dryRun, true);
    const res = r.body.results;
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[0].preview.template, "Patrol");
    assert.match(res[1].error, /does not have access/);
    assert.match(res[2].error, /only creates regular users/);
    assert.match(res[3].error, /Same email as row 0/);
    assert.match(res[4].error, /Same username as row 0/);
    assert.match(res[5].error, /Manual group selection/);
    assert.strictEqual(created.length, 0, "validate writes nothing");

    // Create: forced to regular user, scoped assign list, audited as the token.
    r = await request(server, "POST", "/api/v1/users", {
      token: gen.token,
      body: { badge: "2001", agency: "rcso", firstName: "Kim", lastName: "Lee", template: "command" },
    });
    assert.strictEqual(r.body.ok, 1);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].payload.permissions, "user");
    assert.strictEqual(created[0].opts.allowAllAgencies, false);
    assert.deepStrictEqual(created[0].opts.allowedAgencySuffixesForAssign, ["rcso"]);
    assert.strictEqual(created[0].opts.creationMethod, "api");
    const audit = audits.find((a) => a.action === "CREATE_USER");
    assert.ok(audit && audit.actor.username === "api-token:abcdef123456");

    // Agencies need the flag.
    r = await request(server, "POST", "/api/v1/agencies/validate", { token: gen.token, body: { name: "X" } });
    assert.strictEqual(r.status, 403);

    // Mutual aid needs the flag, and passwords never come back.
    r = await request(server, "POST", "/api/v1/mutual-aid", { token: gen.token, body: { type: "EVENT", title: "Fair" } });
    assert.strictEqual(r.status, 403);
    activeRow = row({ can_create_mutual_aid: true });
    mutualAid.create = async (o) => ({ id: "m1", title: o.title, type: o.type, username: "ma-fair", password: "secret!" });
    r = await request(server, "POST", "/api/v1/mutual-aid", { token: gen.token, body: { type: "EVENT", title: "Fair" } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.item.username, "ma-fair");
    assert.ok(!("password" in r.body.item));

    r = await request(server, "GET", "/api/v1/nope", { token: gen.token });
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }

  console.log("apiTokens.test.js passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
