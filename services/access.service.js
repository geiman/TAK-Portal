// services/access.service.js
// Centralized helper for per-agency access rules.
// Agency admin rights are defined *only* on the Agencies page:
// each agency may declare one or more "admin groups". Any Authentik
// user who is a member of one of those groups is treated as an
// "agency admin" for that agency. Global admins still come from
// PORTAL_AUTH_REQUIRED_GROUP via portalAuth.middleware.

const agenciesStore = require("./agencies.service");

function normalizeSuffix(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Compute all agency suffixes the given user-groups are admin for.
 * This uses only the `adminGroups` field attached to agencies.json.
 *
 * @param {string[]|null|undefined} userGroups - array of group names
 * @returns {string[]} unique, normalized agency suffixes
 */
function getAllowedAgencySuffixesForGroups(userGroups) {
  const groupsLower = Array.isArray(userGroups)
    ? userGroups.map((g) => String(g || "").trim().toLowerCase()).filter(Boolean)
    : [];

  if (!groupsLower.length) return [];

  const agencies = agenciesStore.load();
  const allowed = new Set();

  for (const agency of agencies) {
    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    const adminList = normalizeGroupList(rawAdmin);

    if (!adminList.length) continue;

    const hasAny = adminList.some((needed) => groupsLower.includes(needed));
    if (!hasAny) continue;

    const sfx = normalizeSuffix(agency.suffix);
    if (sfx) {
      allowed.add(sfx);
    }
  }

  return Array.from(allowed);
}

/**
 * Whether any agency declares agency-admin groups at all.
 */
function hasAnyAgencyAdminsConfigured() {
  const agencies = agenciesStore.load();
  return agencies.some((agency) => {
    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    const list = normalizeGroupList(rawAdmin);
    return list.length > 0;
  });
}

/**
 * Return a unified view of the current user's access.
 *
 * - Global admins (from portalAuth) can see all agencies.
 * - Agency admins can see only agencies whose suffix they are admin for.
 *
 * @param {object|null} authUser - req.authentikUser
 * @returns {{ isGlobalAdmin: boolean, isAgencyAdmin: boolean, allowedAgencySuffixes: string[]|null }}
 */
function getAgencyAccess(authUser) {
  const isGlobalAdmin = !!(authUser && authUser.isGlobalAdmin);

  if (isGlobalAdmin) {
    return {
      isGlobalAdmin: true,
      isAgencyAdmin: false,
      // null means "all agencies"
      allowedAgencySuffixes: null,
    };
  }

  const groups =
    authUser && Array.isArray(authUser.groups) ? authUser.groups : [];
  const allowedAgencySuffixes = getAllowedAgencySuffixesForGroups(groups);

  return {
    isGlobalAdmin: false,
    isAgencyAdmin: allowedAgencySuffixes.length > 0,
    allowedAgencySuffixes,
  };
}

/**
 * Filter a list of agencies down to those visible for the current user.
 */
function filterAgenciesForUser(authUser, agencies) {
  const access = getAgencyAccess(authUser);
  const list = Array.isArray(agencies) ? agencies : [];

  if (access.isGlobalAdmin) {
    return list;
  }

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return [];

  const allowedSet = new Set(allowed.map(normalizeSuffix));
  return list.filter((a) => allowedSet.has(normalizeSuffix(a.suffix)));
}

/**
 * Does the user have access to a given agency suffix?
 */
function isSuffixAllowed(authUser, suffix) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return true;
  const sfx = normalizeSuffix(suffix);
  if (!sfx) return false;
  const allowed = access.allowedAgencySuffixes || [];
  return allowed.map(normalizeSuffix).includes(sfx);
}

/**
 * Does a username belong to any agency the current user can manage?
 * We infer agency from the username suffix: badge + agencySuffix.
 */
function isUsernameInAllowedAgencies(authUser, username) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return true;

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return false;

  const un = String(username || "").toLowerCase();
  return allowed
    .map(normalizeSuffix)
    .some((sfx) => sfx && un.endsWith(sfx));
}

/**
 * Compute the agency and county prefixes that the current user is allowed to see.
 *
 * agencyPrefixes: e.g. ["CPD", "CFD"]
 * countyPrefixes: e.g. ["HAMILTON", "BRADLEY"]
 */
function getAgencyAndCountyPrefixesForUser(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) {
    // null means "no restriction"
    return { agencyPrefixes: null, countyPrefixes: null };
  }

  const allowed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.map(normalizeSuffix).filter(Boolean)
    : [];
  if (!allowed.length) {
    return { agencyPrefixes: [], countyPrefixes: [] };
  }

  const allowedSet = new Set(allowed);
  const agencies = agenciesStore.load();

  const agencyPrefixes = [];
  const countyPrefixes = [];

  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency && agency.suffix);
    if (!sfx || !allowedSet.has(sfx)) continue;

    const gp = String(agency.groupPrefix || "").trim().toUpperCase();
    if (gp && !agencyPrefixes.includes(gp)) {
      agencyPrefixes.push(gp);
    }

    const county = String(agency.county || "").trim().toUpperCase();
    if (county && !countyPrefixes.includes(county)) {
      countyPrefixes.push(county);
    }
  }

  return { agencyPrefixes, countyPrefixes };
}

/**
 * Filter a list of Authentik groups for the current user.
 *
 * - Global admins: see all groups (after GROUPS_HIDDEN_PREFIXES is applied).
 * - Agency admins: see
 *   - their agency-specific groups
 *       (name starts with agency groupPrefix + "-" or groupPrefix + " -"),
 *   - their county groups
 *       (name starts with COUNTYNAME + "-" or COUNTYNAME + " -"),
 *   - "global" groups with no prefix (no "-").
 */
function filterGroupsForUser(authUser, groups) {
  const access = getAgencyAccess(authUser);
  const list = Array.isArray(groups) ? groups : [];

  if (access.isGlobalAdmin) {
    return list;
  }

  const { agencyPrefixes, countyPrefixes } =
    getAgencyAndCountyPrefixesForUser(authUser);

  const hasAgencyPrefixes =
    Array.isArray(agencyPrefixes) && agencyPrefixes.length > 0;
  const hasCountyPrefixes =
    Array.isArray(countyPrefixes) && countyPrefixes.length > 0;

  return list.filter((g) => {
    const name = String(g && g.name ? g.name : "").trim();
    if (!name) return false;

    const upper = name.toUpperCase();
    const dashIdx = upper.indexOf("-");
    if (dashIdx > 0) {
      // IMPORTANT:
      // Support both "CPD-GROUP" and "CPD - GROUP" by trimming the prefix segment.
      const rawPrefix = upper.slice(0, dashIdx);
      const prefix = rawPrefix.trim();

      if (hasAgencyPrefixes && agencyPrefixes.includes(prefix)) return true;
      if (hasCountyPrefixes && countyPrefixes.includes(prefix)) return true;

      // Other agency/county prefixes are hidden for this user.
      return false;
    }

    // No dash: treat as global/unprefixed.
    // Whether it is visible at all is already controlled by GROUPS_HIDDEN_PREFIXES
    // in groups.service.getAllGroups; here we keep such groups.
    return true;
  });
}

module.exports = {
  normalizeSuffix,
  normalizeGroupList,
  getAllowedAgencySuffixesForGroups,
  hasAnyAgencyAdminsConfigured,
  getAgencyAccess,
  filterAgenciesForUser,
  isSuffixAllowed,
  isUsernameInAllowedAgencies,
  getAgencyAndCountyPrefixesForUser,
  filterGroupsForUser,
};
