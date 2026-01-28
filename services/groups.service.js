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
  const limit = 200;
  let next = null;
  let all = [];

  do {
    const params = { page_size: limit };
    if (next) params.page = next;

    const res = await api.get("/core/groups/", { params });
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    all = all.concat(results);
    next = data.next ? (new URL(data.next)).searchParams.get("page") : null;
  } while (next);

  return all;
}

let groupsCache = null;
let groupsCacheTs = 0;
const GROUPS_CACHE_TTL_MS = 15 * 1000;

function invalidateGroupsCache() {
  groupsCache = null;
  groupsCacheTs = 0;
}

async function getAllGroups({ forceRefresh } = {}) {
  const now = Date.now();
  if (!forceRefresh && groupsCache && (now - groupsCacheTs) < GROUPS_CACHE_TTL_MS) {
    return groupsCache;
  }
  const raw = await getAllGroupsRaw();
  groupsCache = raw;
  groupsCacheTs = now;
  return raw;
}

async function getGroupById(groupId, options = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");
  const res = await api.get(`/core/groups/${id}/`);
  return res.data;
}

// ---------------- TAK naming helpers ----------------
const TAK_PREFIX = "tak_";

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith(TAK_PREFIX) ? n.slice(TAK_PREFIX.length) : n;
}

function ensureTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith(TAK_PREFIX) ? n : TAK_PREFIX + n;
}

function buildCnAttributeValue(nameWithTak) {
  const without = stripTakPrefix(nameWithTak);
  return `CN: ${without}`;
}

// ---------------- Group CRUD ----------------
async function createGroup(name, opts = {}) {
  const raw = String(name || "").trim();
  if (!raw) throw new Error("Group name is required");

  // Always enforce tak_ prefix
  const n = ensureTakPrefix(raw);

  const payload = { name: n };

  // Merge description (if provided) with any attributes passed in opts
  const attributes = Object.assign({}, opts.attributes || {});
  // Always keep Authentik attribute "CN" in sync (without tak_ prefix)
  attributes.CN = buildCnAttributeValue(n);
  const description = String(opts.description || "").trim();
  if (description) {
    attributes.description = description;
  }

  if (Object.keys(attributes).length > 0) {
    payload.attributes = attributes;
  }

  const res = await api.post("/core/groups/", payload);
  invalidateGroupsCache();
  return res.data;
}

async function setUserGroupMembership(userId, groupIds) {
  const uid = normalizeId(userId);
  if (!uid) throw new Error("User id is required");

  const groups = normalizeIdList(groupIds);

  const res = await api.patch(`/core/users/${uid}/`, { groups });
  return res.data;
}

/**
 * Renames a group in Authentik, and updates any templates that reference the old name.
 * Also supports updating group attributes (description/private).
 * Templates store group NAMES, not IDs, so we need to update those too.
 * Returns the updated group object, with some meta counts attached.
 */
async function renameGroup(groupId, newName, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Block protected groups unless explicitly overridden
  const current = await assertGroupNotActionLocked(id, opts);

  const rawNew = String(newName || "").trim();
  if (!rawNew) throw new Error("Group name is required");

  // Always enforce tak_ prefix
  const n = ensureTakPrefix(rawNew);

  // Need old name so we can update templates that reference it
  const oldName = String(current?.name || "").trim();
  if (!oldName) throw new Error("Could not determine existing group name");

  // Rename (and optionally update attributes) in Authentik
  const payload = { name: n };

  const wantsDescription = Object.prototype.hasOwnProperty.call(opts, "description");
  const wantsPrivate = Object.prototype.hasOwnProperty.call(opts, "private");

  // Always keep Authentik attribute "CN" in sync (without tak_ prefix),
  // and apply optional description/private updates.
  const existingAttrs =
    current && typeof current.attributes === "object" && current.attributes
      ? current.attributes
      : {};

  const nextAttrs = { ...existingAttrs, CN: buildCnAttributeValue(n) };

  if (wantsDescription) {
    const desc = String(opts.description || "").trim();
    nextAttrs.description = desc;
  }

  if (wantsPrivate) {
    const priv = String(opts.private || "").trim().toLowerCase();
    // Normalize to "yes"/"no"; treat anything other than "yes" as "no"
    nextAttrs.private = priv === "yes" ? "yes" : "no";
  }

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

// ---------- impact
async function getDeleteImpact(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const group = await getGroupById(id);
  const name = String(group?.name || "").trim();

  const templates = templatesStore.load();
  const affectedTemplates = templates
    .filter(t => Array.isArray(t.groups) && t.groups.includes(name))
    .map(t => t.name || t.id || "(unnamed)");

  // Count users currently in the group
  const users = await usersService.getAllUsers({ forceRefresh: true });
  const usersInGroup = (Array.isArray(users) ? users : []).filter(u => {
    const groups = Array.isArray(u.groups) ? u.groups : [];
    return groups.includes(id) || groups.includes(String(id));
  });

  return {
    groupId: id,
    groupName: name,
    templatesAffectedCount: affectedTemplates.length,
    templatesAffected: affectedTemplates,
    usersAffected: usersInGroup.length,
  };
}

async function deleteGroup(groupId, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Block protected groups unless explicitly overridden
  await assertGroupNotActionLocked(id, opts);

  const res = await api.delete(`/core/groups/${id}/`);
  invalidateGroupsCache();
  return res.data;
}

async function deleteGroupWithCleanup(groupId, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const group = await getGroupById(id);
  const groupName = String(group?.name || "").trim();

  // Block protected groups unless explicitly overridden
  await assertGroupNotActionLocked(id, opts);

  // Remove group from users
  const users = await usersService.getAllUsers({ forceRefresh: true });
  const affectedUsers = (Array.isArray(users) ? users : []).filter(u => {
    const groups = Array.isArray(u.groups) ? u.groups : [];
    return groups.includes(id) || groups.includes(String(id));
  });

  for (const u of affectedUsers) {
    const uid = normalizeId(u.pk);
    if (!uid) continue;

    const nextGroups = (Array.isArray(u.groups) ? u.groups : [])
      .map(g => String(g))
      .filter(g => g !== String(id));

    await api.patch(`/core/users/${uid}/`, { groups: nextGroups });
  }

  // Remove group from templates store
  const templates = templatesStore.load();
  const updatedTemplates = templates.map(t => {
    const groupsArr = Array.isArray(t.groups) ? t.groups : [];
    if (!groupsArr.includes(groupName)) return t;
    return { ...t, groups: groupsArr.filter(g => g !== groupName) };
  });
  templatesStore.save(updatedTemplates);

  // Delete group
  const res = await api.delete(`/core/groups/${id}/`);
  invalidateGroupsCache();

  return {
    success: true,
    groupId: id,
    groupName,
    usersUpdated: affectedUsers.length,
    templatesUpdated: templates.filter(t => Array.isArray(t.groups) && t.groups.includes(groupName)).length,
    authentik: res.data,
  };
}

// ---------- mass ops
async function massAssignUsersToGroup({ groupId, suffixes, sourceGroupIds, userIds } = {}) {
  const gid = normalizeId(groupId);
  const sfx = normalizeIdList(suffixes).map(s => String(s).trim().toLowerCase());
  const srcGroupIds = Array.isArray(sourceGroupIds)
    ? normalizeIdList(sourceGroupIds)
    : normalizeIdList([sourceGroupIds]);
  const uids = normalizeIdList(userIds);

  if (!gid) throw new Error("groupId is required");
  if (!sfx.length) throw new Error("suffixes are required");
  if (!srcGroupIds.length) throw new Error("sourceGroupIds are required");
  if (!uids.length) throw new Error("userIds are required");

  const users = await usersService.getAllUsers({ forceRefresh: true });

  // Filter users by agency suffix (based on access.service rules)
  const filteredUsers = accessSvc.filterUsersByAgencySuffix(users, sfx);

  // Build a set of eligible user IDs
  const eligibleUserIds = new Set(filteredUsers.map(u => String(u.pk)));

  // Only apply to requested userIds that are eligible
  const targets = uids.filter(id => eligibleUserIds.has(String(id)));

  // For each user, add the group if they are in ANY of the source groups
  let updated = 0;
  let skipped = 0;

  for (const uid of targets) {
    const u = filteredUsers.find(x => String(x.pk) === String(uid));
    if (!u) {
      skipped++;
      continue;
    }

    const currentGroups = Array.isArray(u.groups) ? u.groups.map(g => String(g)) : [];

    // Must be in at least one source group to be included
    const inSource = srcGroupIds.some(sg => currentGroups.includes(String(sg)));
    if (!inSource) {
      skipped++;
      continue;
    }

    if (!currentGroups.includes(String(gid))) {
      const next = currentGroups.concat([String(gid)]);
      await api.patch(`/core/users/${uid}/`, { groups: next });
      updated++;
    } else {
      skipped++;
    }
  }

  return { updated, skipped };
}

async function massUnassignUsersFromGroup({ groupId, suffixes, sourceGroupIds, userIds } = {}) {
  const gid = normalizeId(groupId);
  const sfx = normalizeIdList(suffixes).map(s => String(s).trim().toLowerCase());
  const srcGroupIds = Array.isArray(sourceGroupIds)
    ? normalizeIdList(sourceGroupIds)
    : normalizeIdList([sourceGroupIds]);
  const uids = normalizeIdList(userIds);

  if (!gid) throw new Error("groupId is required");
  if (!sfx.length) throw new Error("suffixes are required");
  if (!srcGroupIds.length) throw new Error("sourceGroupIds are required");
  if (!uids.length) throw new Error("userIds are required");

  const users = await usersService.getAllUsers({ forceRefresh: true });

  const filteredUsers = accessSvc.filterUsersByAgencySuffix(users, sfx);
  const eligibleUserIds = new Set(filteredUsers.map(u => String(u.pk)));

  const targets = uids.filter(id => eligibleUserIds.has(String(id)));

  let updated = 0;
  let skipped = 0;

  for (const uid of targets) {
    const u = filteredUsers.find(x => String(x.pk) === String(uid));
    if (!u) {
      skipped++;
      continue;
    }

    const currentGroups = Array.isArray(u.groups) ? u.groups.map(g => String(g)) : [];

    // Must be in at least one source group to be included
    const inSource = srcGroupIds.some(sg => currentGroups.includes(String(sg)));
    if (!inSource) {
      skipped++;
      continue;
    }

    if (currentGroups.includes(String(gid))) {
      const next = currentGroups.filter(g => g !== String(gid));
      await api.patch(`/core/users/${uid}/`, { groups: next });
      updated++;
    } else {
      skipped++;
    }
  }

  return { updated, skipped };
}

module.exports = {
  getAllGroups,
  getAllGroupsRaw,
  getGroupById,
  createGroup,
  renameGroup,
  deleteGroup,
  deleteGroupWithCleanup,
  getDeleteImpact,
  setUserGroupMembership,
  massAssignUsersToGroup,
  massUnassignUsersFromGroup,
};
