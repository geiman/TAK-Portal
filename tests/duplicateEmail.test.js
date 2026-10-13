const assert = require("assert");
const db = require("../services/db");
const settingsSvc = require("../services/settings.service");
const directoryRepo = require("../services/directoryRepo.service");
const agenciesStore = require("../services/agencies.service");
const requestsStore = require("../services/userRequests.store");
const usersSvc = require("../services/users.service");
const userRequestsSvc = require("../services/userRequests.service");

const priorBlock = settingsSvc.get("USERS_BLOCK_DUPLICATE_EMAIL", undefined);

function restore() {
  settingsSvc.updateSettings({
    USERS_BLOCK_DUPLICATE_EMAIL: priorBlock === undefined ? "" : priorBlock,
  });
}

(async () => {
  // findUsernameByEmail: trimmed, case-insensitive, skips pending deletes.
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ username: "jdoe.efd" }] };
  };
  assert.strictEqual(await directoryRepo.findUsernameByEmail("  Jane@Example.gov "), "jdoe.efd");
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].sql, /lower\(email\) = lower\(\$1\)/);
  assert.match(calls[0].sql, /pending_delete = false/);
  assert.deepStrictEqual(calls[0].params, ["Jane@Example.gov"]);
  assert.strictEqual(await directoryRepo.findUsernameByEmail("   "), null);
  assert.strictEqual(calls.length, 1);
  db.query = originalQuery;

  // Setting defaults to on and can be turned off.
  settingsSvc.updateSettings({ USERS_BLOCK_DUPLICATE_EMAIL: "" });
  assert.strictEqual(usersSvc.isDuplicateEmailBlockEnabled(), true);
  settingsSvc.updateSettings({ USERS_BLOCK_DUPLICATE_EMAIL: "false" });
  assert.strictEqual(usersSvc.isDuplicateEmailBlockEnabled(), false);

  // Request Access refuses an email that already has an account.
  settingsSvc.updateSettings({ USERS_BLOCK_DUPLICATE_EMAIL: "true" });
  const originalFind = directoryRepo.findUsernameByEmail;
  const originalLoad = requestsStore.load;
  const originalAgencies = agenciesStore.load;
  directoryRepo.findUsernameByEmail = async (email) =>
    String(email).toLowerCase() === "jane.doe@example.gov" ? "jdoe.efd" : null;
  requestsStore.load = () => [];
  agenciesStore.load = () => [];

  await assert.rejects(
    () =>
      userRequestsSvc.createRequest({
        firstName: "Jane",
        lastName: "Doe",
        email: "Jane.Doe@example.gov",
        badgeNumber: "1234",
        agencySuffix: "__other__",
        otherAgency: "Example Fire Department",
        otherReason: "Mutual aid support",
        groupPrefix: "EFD",
        usernameTokenPlacement: "suffix",
        suffix: "efd",
        state: "OH",
        county: "Hamilton County",
        countyAbbrev: "HM",
        type: "Fire",
      }),
    (err) => err.code === "USER_ALREADY_EXISTS" && /email address already exists/.test(err.message)
  );

  directoryRepo.findUsernameByEmail = originalFind;
  requestsStore.load = originalLoad;
  agenciesStore.load = originalAgencies;
  restore();
  console.log("duplicateEmail.test.js OK");
})().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
