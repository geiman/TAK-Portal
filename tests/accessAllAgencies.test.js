const assert = require("assert");
const agenciesStore = require("../services/agencies.service");
const accessSvc = require("../services/access.service");

const originalLoad = agenciesStore.load;
let agencies = [
  { name: "Pennsylvania State Police", suffix: "psp", groupPrefix: "PSP" },
  { name: "Pittsburgh Police", suffix: "ppd", groupPrefix: "PPD" },
];
agenciesStore.load = () => agencies;

try {
  const ALL = accessSvc.ALL_AGENCIES_ADMIN_GROUP_NAME;
  assert.ok(/-AgencyAdmin$/.test(ALL));

  // Per-agency admin only sees the agencies it is admin for.
  assert.deepStrictEqual(
    accessSvc.getAllowedAgencySuffixesForGroups(["authentik-PSP-AgencyAdmin"]),
    ["psp"]
  );

  // All-agencies admin manages every agency (case-insensitive group match).
  const allUser = {
    username: "mknockpsp",
    groups: ["authentik-PSP-AgencyAdmin", ALL.toUpperCase()],
  };
  assert.deepStrictEqual(
    accessSvc.getAllowedAgencySuffixesForGroups(allUser.groups).sort(),
    ["ppd", "psp"]
  );
  assert.strictEqual(accessSvc.userManagesAllAgencies(allUser), true);
  assert.strictEqual(accessSvc.userManagesAllAgencies({ groups: ["authentik-PSP-AgencyAdmin"] }), false);

  // Agencies created later are covered without changing the user's groups.
  agencies = agencies.concat([{ name: "Delaware County", suffix: "delco", groupPrefix: "DELCO" }]);
  const access = accessSvc.getAgencyAccess(allUser);
  assert.strictEqual(access.isGlobalAdmin, false);
  assert.strictEqual(access.isAgencyAdmin, true);
  assert.deepStrictEqual(access.allowedAgencySuffixes.sort(), ["delco", "ppd", "psp"]);
  assert.strictEqual(accessSvc.isSuffixAllowed(allUser, "delco"), true);
  assert.strictEqual(
    accessSvc.isUserInAllowedAgencies(allUser, { username: "1234delco", attributes: {} }),
    true
  );
  assert.strictEqual(accessSvc.getManagedAgenciesForUser(allUser).length, 3);
  assert.deepStrictEqual(
    accessSvc.getAgencyAndCountyPrefixesForUser(allUser).agencyPrefixes.sort(),
    ["DELCO", "PPD", "PSP"]
  );

  // Role delta: granting all agencies adds the all group; switching back removes it.
  const allGroups = [
    { pk: "1", name: "authentik-PSP-AgencyAdmin" },
    { pk: "2", name: "authentik-PPD-AgencyAdmin" },
    { pk: "9", name: ALL },
  ];
  const grant = accessSvc.computePortalRoleGroupDelta({
    role: "agency_admin",
    managedAgencySuffixes: ["psp"],
    allAgencies: true,
    currentGroupIds: ["1", "2"],
    allGroups,
  });
  assert.deepStrictEqual(grant.toAdd, ["9"]);
  assert.deepStrictEqual(grant.toRemove, ["2"]);
  assert.strictEqual(grant.allAgencies, true);

  const revoke = accessSvc.computePortalRoleGroupDelta({
    role: "agency_admin",
    managedAgencySuffixes: ["psp", "ppd"],
    currentGroupIds: ["1", "9"],
    allGroups,
  });
  assert.deepStrictEqual(revoke.toAdd, ["2"]);
  assert.deepStrictEqual(revoke.toRemove, ["9"]);

  const demote = accessSvc.computePortalRoleGroupDelta({
    role: "user",
    currentGroupIds: ["1", "9"],
    allGroups,
  });
  assert.deepStrictEqual(demote.toRemove.sort(), ["1", "9"]);

  // All agencies without a home agency is still valid.
  const noHome = accessSvc.computePortalRoleGroupDelta({
    role: "agency_admin",
    managedAgencySuffixes: [],
    allAgencies: true,
    currentGroupIds: [],
    allGroups,
  });
  assert.deepStrictEqual(noHome.toAdd, ["9"]);

  // Missing all group in Authentik is a clear error.
  assert.throws(
    () =>
      accessSvc.computePortalRoleGroupDelta({
        role: "agency_admin",
        managedAgencySuffixes: ["psp"],
        allAgencies: true,
        currentGroupIds: [],
        allGroups: allGroups.slice(0, 2),
      }),
    /was not found/
  );

  console.log("accessAllAgencies.test.js passed");
} finally {
  agenciesStore.load = originalLoad;
}
