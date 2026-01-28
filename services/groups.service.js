const { getString } = require("./env");
const api = require("./authentik");
const usersService = require("./users.service");
const templatesStore = require("./templates.service");
const accessSvc = require("./access.service");

// ---------------- Action-lock helpers ----------------
// If a group name starts with any prefix in GROUPS_ACTIONS_HIDDEN_PREFIXES,
// the UI hides action buttons AND the API will reject mutating operations.
function getGroupActionLockPrefixes() {
  return String(getString("GROUPS_ACTIONS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function isGroupActionLocked(groupName) {
  const n = String(groupName || "").trim().toLowerCase();
  if (!n) return false;
  const prefixes = getGroupActionLockPrefixes();
  if (!prefixes.length) return false;
  return prefixes.some(p => n.startsWith(p));
}

function getHiddenUserPrefixes() {
  return String(getString("USERS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

async function assertGroupNotActionLocked(groupId, { ignoreLocks } = {}) {
  const group = await getGroupById(groupId);
  if (!ignoreLocks && isGroupActionLocked(group?.name)) {
    throw new Error(`Actions are locked for group ${group?.name || groupId}`);
  }
  return group;
}

function normalizePath(p) {
  return String(p || "").replace(/^\/+|\/+$/g, "");
}

function normalizeId(x) {
  return String(x ?? "").trim();
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v).trim()).filter(Boolean);
}

function ensureTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

// Normalize the Authentik CN attribute:
// - attribute key must be "CN" (uppercase)
// - value must be exactly "CN: <nameWithoutTak>" (no surrounding quotes)
// - if caller provides a value, accept either "<nameWithoutTak>" or "CN: <nameWithoutTak>"
function normalizeCNValue(rawValue, nameWithoutTak) {
  const fallback = String(nameWithoutTak || "").trim();

  // We intentionally accept a wide range of inputs and normalize to a single canonical form:
  //   "CN: <nameWithoutTak>"
  // This must handle common bad inputs like:
  //   CN: "CN: test 5"   (your current bug)
  //   "CN: test 5"
  //   CN:test 5
  //   test 5
  let v = String(rawValue ?? "").trim();
  if (!v) v = fallback;

  // Unwrap up to 3 layers of quotes and CN prefixes.
  // (We use a small loop to avoid writing a brittle one-off regex.)
  for (let i = 0; i < 3; i += 1) {
    // strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).trim();
    }

    // strip leading CN:
    const m = v.match(/^cn\s*:\s*(.*)$/i);
    if (!m) break;
    v = String(m[1] || "").trim();
  }

  // One last quote unwrap in case we ended the loop after removing a prefix.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }

  const finalRest = String(v || fallback).trim();
  return `CN: ${finalRest}`;
}

function applyUserVisibilityFilters(users) {
  let out = Array.isArray(users) ? users : [];

  // Hide users by username prefix for group-related views (USERS_HIDDEN_PREFIXES)
  const hiddenPrefixes = getHiddenUserPrefixes();
  if (hiddenPrefixes.length) {
    out = out.filter(u => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some(p => username.startsWith(p));
    });
  }

  // Respect AUTHENTIK_USER_PATH if set
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (!folderRaw) return out;

  const target = normalizePath(folderRaw);
  return out.filter(u => {
    const up = normalizePath(u.path);
    return up === target || up.startsWith(target + "/");
  });
}

// ---------------- Authentik API helpers (groups) ----------------
async function getAllGroupsRaw(options = {}) {
  let groups = [];
  let url = "/core/groups/";

  while (url) {
    const res = await api.get(url);
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    groups = groups.concat(results);
    url = data.next
      ? data.next.replace(`${getString("AUTHENTIK_URL", "")}/api/v3`, "")
      : null;
  }

  // Hide internal Authentik groups from this portal UI unless explicitly requested.
  // We read GROUPS_HIDDEN_PREFIXES via getString so settings.json and env both work.
  // Example: GROUPS_HIDDEN_PREFIXES=authentik-,internal-
  const includeHidden = !!options.includeHidden;
  if (!includeHidden) {
    const prefixes = String(getString("GROUPS_HIDDEN_PREFIXES", ""))
      .split(",")
      .map(p => String(p || "").trim().toLowerCase())
      .filter(Boolean);

    groups = groups.filter(g => {
      const name = String(g?.name || "").trim().toLowerCase();
      return !prefixes.some(p => name.startsWith(p));
    });
  }

  return groups;
}

async function getGroupById(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");
  const res = await api.get(`/core/groups/${id}/`);
  return res.data;
}

// ---------------- Fetch all users (hybrid pagination) ----------------
// Supports BOTH:
// - data.pagination.next (like users.service.js)
// - data.next (DRF-style next URL)
// Also:
// - Hides USERS_HIDDEN_PREFIXES
// - Respects AUTHENTIK_USER_PATH
async function getAllUsersRaw() {
  let users = [];
  const pageSize = 200;
  let page = 1;
  let url = `/core/users/?page=${page}&page_size=${pageSize}`;

  while (url) {
    const res = await api.get(url);
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    users = users.concat(results);

    const pagination = data.pagination || {};
    if (pagination && pagination.next) {
      // Authentik-style pagination object (what users.service.js uses)
      page = pagination.next;
      url = `/core/users/?page=${page}&page_size=${pageSize}`;
    } else if (data.next) {
      // DRF-style "next" URL
      url = data.next.replace(`${getString("AUTHENTIK_URL", "")}/api/v3`, "");
    } else {
      url = null;
    }
  }

  return applyUserVisibilityFilters(users);
}

// Fetch all users who are members of a single group via Authentik filtering.
// This avoids downloading the full user list and filtering in Node.
async function getUsersByGroupIdRaw({ groupId, agencyAbbreviation } = {}) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Group id is required");

  let users = [];
  const pageSize = 200;
  let page = 1;

  // Use server-side filters:
  // - groups_by_pk=<uuid>
  // - optionally attributes__agency_abbreviation=<abbr>
  // Also reduce payload size (no embedded groups/roles).
  const abbr = String(agencyAbbreviation || "").trim();
  const abbrParam = abbr ? `&attributes__agency_abbreviation=${encodeURIComponent(abbr)}` : "";
  let url = `/core/users/?page=${page}&page_size=${pageSize}&groups_by_pk=${encodeURIComponent(gid)}&include_groups=false&include_roles=false${abbrParam}`;

  while (url) {
    const res = await api.get(url);
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    users = users.concat(results);

    const pagination = data.pagination || {};
    if (pagination && pagination.next) {
      page = pagination.next;
      url = `/core/users/?page=${page}&page_size=${pageSize}&groups_by_pk=${encodeURIComponent(gid)}&include_groups=false&include_roles=false${abbrParam}`;
    } else if (data.next) {
      url = data.next.replace(`${getString("AUTHENTIK_URL", "")}/api/v3`, "");
    } else {
      url = null;
    }
  }

  return applyUserVisibilityFilters(users);
}

// ---------------- Group CRUD ----------------
async function createGroup(name, opts = {}) {
  const n = ensureTakPrefix(String(name || "").trim());
  if (!n) throw new Error("Group name is required");

  const payload = { name: n };

  // Merge description (if provided) with any attributes passed in opts
  const attributes = Object.assign({}, opts.attributes || {});
  const description = String(opts.description || "").trim();
  if (description) {
    attributes.description = description;
  }

  // Always maintain the Authentik CN attribute (uppercase key).
  // Value should be exactly "CN: <group name without tak_>".
  // Also remove any legacy lowercase "cn" attribute to avoid duplicates.
  delete attributes.cn;
  attributes.CN = normalizeCNValue(
    Object.prototype.hasOwnProperty.call(attributes, "CN") ? attributes.CN : "",
    stripTakPrefix(n)
  );

  if (Object.keys(attributes).length > 0) {
    payload.attributes = attributes;
  }

  const res = await api.post("/core/groups/", payload);
  invalidateGroupsCache();
  return res.data;
}

async function setUserGroups(userId, groupIds) {
  const id = normalizeId(userId);
  const ids = normalizeIdList(groupIds);
  await api.patch(`/core/users/${id}/`, { groups: ids });
  return true;
}

async function deleteGroup(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");
  await api.delete(`/core/groups/${id}/`);
  invalidateGroupsCache();
  invalidateGroupUsersCache();
  return true;
}

/**
 * Rename group in Authentik AND update templates store (templates store group *names*, not IDs)
 * Returns the updated group object, with some meta counts attached.
 */
async function renameGroup(groupId, newName, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Block protected groups unless explicitly overridden
  const current = await assertGroupNotActionLocked(id, opts);

  const n = ensureTakPrefix(String(newName || "").trim());
  if (!n) throw new Error("Group name is required");

  // Need old name so we can update templates that reference it
  const oldName = String(current?.name || "").trim();
  if (!oldName) throw new Error("Could not determine existing group name");

  // Rename (and update attributes) in Authentik
  const payload = { name: n };

  const wantsDescription = Object.prototype.hasOwnProperty.call(opts, "description");
  const wantsPrivate = Object.prototype.hasOwnProperty.call(opts, "private");
  const wantsCN = Object.prototype.hasOwnProperty.call(opts, "CN") ||
                  Object.prototype.hasOwnProperty.call(opts, "cn");

  const existingAttrs =
    current && typeof current.attributes === "object" && current.attributes
      ? current.attributes
      : {};

  const nextAttrs = { ...existingAttrs };

  if (wantsDescription) {
    const desc = String(opts.description || "").trim();
    nextAttrs.description = desc;
  }

  if (wantsPrivate) {
    const priv = String(opts.private || "").trim().toLowerCase();
    // Normalize to "yes"/"no"; treat anything other than "yes" as "no"
    nextAttrs.private = priv === "yes" ? "yes" : "no";
  }

  // Always maintain the Authentik CN attribute (uppercase key).
  // Value should be exactly "CN: <group name without tak_>".
  // Remove any legacy lowercase "cn" attribute to avoid duplicates.
  delete nextAttrs.cn;
  const provided = wantsCN
    ? (Object.prototype.hasOwnProperty.call(opts, "CN") ? opts.CN : opts.cn)
    : "";
  nextAttrs.CN = normalizeCNValue(provided, stripTakPrefix(n));

  payload.attributes = nextAttrs;

  const res = await api.patch(`/core/groups/${id}/`, payload);
  const updatedGroup = res.data;

  // Update templates (replace oldName -> n)
  const templates = templatesStore.load();
  let templatesUpdated = 0;

  const updatedTemplates = templates.map(t => {
    const groupsArr = Array.isArray(t.groups) ? t.groups : [];
    if (!groupsArr.includes(oldName)) return t;

    templatesUpdated++;
    const nextGroups = groupsArr.map(g => (g === oldName ? n : g));
    return { ...t, groups: nextGroups };
  });

  if (templatesUpdated > 0) {
    templatesStore.save(updatedTemplates);
  }

  invalidateGroupsCache();

  return {
    ...updatedGroup,
    _meta: {
      oldName,
      newName: n,
      templatesUpdated
    }
  };
}

// ---------- impact + cleanup ----------
async function getDeleteImpact(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Group name matters because templates store names, not IDs
  const group = await getGroupById(id);
  const groupName = String(group.name || "").trim();

  // Users affected (computed via full user list; reuse users.service cache)
  const users = await usersService.getAllUsers();
  const usersAffected = users.filter(u => {
    const gs = Array.isArray(u.groups) ? u.groups.map(x => String(x)) : [];
    return gs.includes(id);
  }).length;

  // Templates affected (by group name)
  const templates = templatesStore.load();
  const templatesAffected = templates
    .map((t, index) => ({
      index,
      name: String(t.name || ""),
      agencySuffix: String(t.agencySuffix || ""),
      has: Array.isArray(t.groups) && t.groups.includes(groupName)
    }))
    .filter(x => x.has)
    .map(x => ({ index: x.index, name: x.name, agencySuffix: x.agencySuffix }));

  return {
    groupId: id,
    groupName,
    usersAffected,
    templatesAffected,
    templatesAffectedCount: templatesAffected.length
  };
}

async function deleteGroupWithCleanup(groupId, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Block protected groups unless explicitly overridden
  await assertGroupNotActionLocked(id, opts);

  const impact = await getDeleteImpact(id);
  const groupName = impact.groupName;

  // NOTE:
  // We do NOT manually strip this group from every user.
  // Authentik will take care of cleaning up user/group membership
  // when the group is deleted. Here we only clean up templates.

  // 1) Remove group name from templates
  const templates = templatesStore.load();
  let templatesUpdated = 0;
  let templatesNowEmpty = 0;

  const updatedTemplates = templates.map(t => {
    const groups = Array.isArray(t.groups) ? t.groups : [];
    if (!groupName || !groups.includes(groupName)) return t;

    const nextGroups = groups.filter(g => g !== groupName);
    templatesUpdated++;

    if (nextGroups.length === 0) templatesNowEmpty++;

    return { ...t, groups: nextGroups };
  });

  templatesStore.save(updatedTemplates);

  // 2) Delete group in Authentik
  await deleteGroup(id);

  return {
    success: true,
    groupId: id,
    groupName,
    usersUpdated: 0, // we did not touch users directly
    templatesUpdated,
    templatesNowEmpty
  };
}

// ---------- bulk helpers (group-centric membership updates) ----------
async function bulkAddUsersToGroup(groupId, userPks) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const toAdd = normalizeIdList(userPks);
  if (!toAdd.length) return { matched: 0, changed: 0 };

  // Use group.users as source of truth so we don't drop unseen members
  const group = await getGroupById(id);
  const currentUsers = Array.isArray(group.users)
    ? group.users.map(x => String(x))
    : [];

  const merged = Array.from(
    new Set([...currentUsers, ...toAdd.map(String)])
  );

  if (merged.length === currentUsers.length) {
    // nothing actually changed
    return { matched: toAdd.length, changed: 0 };
  }

  await api.patch(`/core/groups/${id}/`, { users: merged });

  return {
    matched: toAdd.length,
    changed: merged.length - currentUsers.length,
  };
}

async function bulkRemoveUsersFromGroup(groupId, userPks) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const toRemove = new Set(
    normalizeIdList(userPks).map(String)
  );
  if (!toRemove.size) return { matched: 0, changed: 0 };

  const group = await getGroupById(id);
  const currentUsers = Array.isArray(group.users)
    ? group.users.map(x => String(x))
    : [];

  const remaining = currentUsers.filter(pk => !toRemove.has(String(pk)));

  if (remaining.length === currentUsers.length) {
    // nothing actually changed
    return { matched: toRemove.size, changed: 0 };
  }

  await api.patch(`/core/groups/${id}/`, { users: remaining });

  return {
    matched: toRemove.size,
    changed: currentUsers.length - remaining.length,
  };
}

// ---------- Mass assign / unassign ----------
async function massAssignUsersToGroup({ groupId, suffixes, sourceGroupIds, userIds }) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Target group is required");

  // Block protected groups
  await assertGroupNotActionLocked(gid);

  const users = await getAllUsers();

  // Strategy 1: explicit users
  const explicitUsers = normalizeIdList(userIds);
  if (explicitUsers.length) {
    const matchedUsers = users.filter(u => explicitUsers.includes(String(u.pk)));
    const targetUserPks = matchedUsers.map(u => u.pk);

    const { changed } = await bulkAddUsersToGroup(gid, targetUserPks);

    return { matched: matchedUsers.length, updated: changed };
  }

  // Strategy 2: users with an existing group (allow multiple)
  const srcGids = normalizeIdList(sourceGroupIds);
  if (srcGids.length) {
    const matchedUsers = users.filter(u => {
      const gs = Array.isArray(u.groups) ? u.groups.map(x => String(x)) : [];
      return srcGids.some(id => gs.includes(id));
    });

    const targetUserPks = matchedUsers.map(u => u.pk);
    const { changed } = await bulkAddUsersToGroup(gid, targetUserPks);

    return { matched: matchedUsers.length, updated: changed };
  }

  // Strategy 3: match by agency suffix
  const suffixList = Array.isArray(suffixes)
    ? suffixes.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!suffixList.length) {
    throw new Error("Provide suffixes, sourceGroupIds, or userIds to mass-assign.");
  }

  const matchedUsers = users.filter(u => {
    const un = String(u.username || "").toLowerCase();
    return suffixList.some(sfx => un.endsWith(sfx));
  });

  const targetUserPks = matchedUsers.map(u => u.pk);
  const { changed } = await bulkAddUsersToGroup(gid, targetUserPks);

  invalidateGroupUsersCache();

  return { matched: matchedUsers.length, updated: changed };
}

// Fetch all members of a single group (lightweight projection)
async function getGroupMembers(groupId, { authUser, agencyAbbreviation } = {}) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Group id is required");

  // Try the fast path: server-side filter by group membership
  // and (for agency admins) by agency_abbreviation.
  let members = await getUsersByGroupIdRaw({
    groupId: gid,
    agencyAbbreviation,
  });

  // Safety: for agency admins, ensure they don't see users outside of allowed agencies.
  // (This preserves existing behavior even if attributes are missing/misconfigured.)
  const access = accessSvc.getAgencyAccess(authUser || null);
  if (!access.isGlobalAdmin) {
    members = members.filter((u) =>
      accessSvc.isUsernameInAllowedAgencies(authUser || null, u?.username)
    );
  }

  return members.map((u) => ({
    pk: u.pk,
    username: u.username,
    name: u.name,
    email: u.email,
    is_active: u.is_active,
    path: u.path,
    attributes: u.attributes || {},
  }));
}

async function massUnassignUsersFromGroup({ groupId, suffixes, sourceGroupIds, userIds }) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Target group is required");

  // Block protected groups
  await assertGroupNotActionLocked(gid);

  const users = await getAllUsers();

  // Strategy 1: explicit users
  const explicitUsers = normalizeIdList(userIds);
  if (explicitUsers.length) {
    const matchedUsers = users.filter((u) => explicitUsers.includes(String(u.pk)));
    const targetUserPks = matchedUsers.map(u => u.pk);

    const { changed } = await bulkRemoveUsersFromGroup(gid, targetUserPks);

    invalidateGroupUsersCache();

    return { matched: matchedUsers.length, updated: changed };
  }

  // Strategy 2: users with an existing group (allow multiple)
  const srcGids = normalizeIdList(sourceGroupIds);
  if (srcGids.length) {
    const matchedUsers = users.filter((u) => {
      const gs = Array.isArray(u.groups) ? u.groups.map((x) => String(x)) : [];
      return srcGids.some((id) => gs.includes(id));
    });

    const targetUserPks = matchedUsers.map(u => u.pk);
    const { changed } = await bulkRemoveUsersFromGroup(gid, targetUserPks);

    invalidateGroupUsersCache();

    return { matched: matchedUsers.length, updated: changed };
  }

  // Strategy 3: match by agency suffix
  const suffixList = Array.isArray(suffixes)
    ? suffixes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!suffixList.length) {
    throw new Error("Provide suffixes, sourceGroupIds, or userIds to mass-unassign.");
  }

  const matchedUsers = users.filter((u) => {
    const un = String(u.username || "").toLowerCase();
    return suffixList.some((sfx) => un.endsWith(sfx));
  });

  const targetUserPks = matchedUsers.map(u => u.pk);
  const { changed } = await bulkRemoveUsersFromGroup(gid, targetUserPks);

  return { matched: matchedUsers.length, updated: changed };
}


// ---------------- Authentik group/user helpers (no caching) ----------------
// Always hit Authentik directly so each page load sees fresh data.

function invalidateGroupsCache() {
  // no-op – kept so existing callers still work
}

function invalidateGroupUsersCache() {
  // no-op – kept so existing callers still work
}

async function getAllGroups(options = {}) {
  // ignore caching / forceRefresh; always reload
  return await getAllGroupsRaw(options);
}

async function getAllUsers(options = {}) {
  // ignore options / forceRefresh; always reload
  return await getAllUsersRaw();
}



module.exports = {
  getAllGroups,
  getGroupById,
  createGroup,
  deleteGroup,

  renameGroup,

  getDeleteImpact,
  deleteGroupWithCleanup,
  massAssignUsersToGroup,
  getGroupMembers,
  massUnassignUsersFromGroup,

  // shared for other services if needed
  getAllUsers,
};
