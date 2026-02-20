// services/access.service.js
// Centralized helper for per-agency access rules.
//
// Agency admin rights are derived from Authentik group membership.
// For each agency we compute the expected admin group name:
//   authentik-<AGENCY_ABBREVIATION>-AgencyAdmin
//
// NOTE: For backwards compatibility, we *also* support the legacy
// `adminGroups` field that may still exist in agencies.json.
// Global admins still come from PORTAL_AUTH_REQUIRED_GROUP via portalAuth.middleware.

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

function getAgencyAdminGroupName(agency) {
  const abbr = String(agency?.groupPrefix || "").trim().toUpperCase();
  if (!abbr) return null;
  return `authentik-${abbr}-AgencyAdmin`;
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
    // Legacy (manual) admin groups stored in agencies.json
    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    const legacyAdminList = normalizeGroupList(rawAdmin);

    // New (computed) admin group name
    const computed = getAgencyAdminGroupName(agency);
    const computedLower = computed ? computed.toLowerCase() : null;

    const neededGroups = [];
    if (computedLower) neededGroups.push(computedLower);
    if (legacyAdminList.length) neededGroups.push(...legacyAdminList);

    if (!neededGroups.length) continue;

    const hasAny = neededGroups.some((needed) => groupsLower.includes(needed));
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
    const computed = getAgencyAdminGroupName(agency);
    if (computed) return true;

    // Legacy support
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
 * Compute the agency, county, and state prefixes that the current user is allowed to see.
 *
 * agencyPrefixes: e.g. ["CPD", "CFD"]
 * countyPrefixes: e.g. ["HAMILTON", "BRADLEY"]
 * statePrefixes: e.g. ["TN", "GA"]
 */
function getAgencyCountyAndStatePrefixesForUser(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) {
    // null means "no restriction"
    return { agencyPrefixes: null, countyPrefixes: null, statePrefixes: null };
  }

  const allowed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.map(normalizeSuffix).filter(Boolean)
    : [];
  if (!allowed.length) {
    return { agencyPrefixes: [], countyPrefixes: [], statePrefixes: [] };
  }

  const allowedSet = new Set(allowed);
  const agencies = agenciesStore.load();

  const agencyPrefixes = [];
  const countyPrefixes = [];
  const statePrefixes = [];

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

    // State groups follow the same prefix-before-dash convention as county groups.
    // Derive the user's allowed state prefixes from their allowed agencies.
    const state = String(agency.state || "").trim().toUpperCase();
    if (state && !statePrefixes.includes(state)) {
      statePrefixes.push(state);
    }
  }

  return { agencyPrefixes, countyPrefixes, statePrefixes };
}

// Backwards-compatible alias (older callers expect this name).
// It now also returns statePrefixes.
function getAgencyAndCountyPrefixesForUser(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) {
    return { agencyPrefixes: null, countyPrefixes: null, statePrefixes: null };
  }

  const allowed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.map(normalizeSuffix).filter(Boolean)
    : [];

  if (!allowed.length) {
    return { agencyPrefixes: [], countyPrefixes: [], statePrefixes: [] };
  }

  const allowedSet = new Set(allowed);
  const agencies = agenciesStore.load();

  const agencyPrefixes = [];
  const countyPrefixes = [];
  const statePrefixes = [];

  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency?.suffix);
    if (!sfx || !allowedSet.has(sfx)) continue;

    const gp = String(agency.groupPrefix || "").trim().toUpperCase();
    if (gp && !agencyPrefixes.includes(gp)) {
      agencyPrefixes.push(gp);
    }

    const county = String(agency.county || "").trim().toUpperCase();
    if (county && !countyPrefixes.includes(county)) {
      countyPrefixes.push(county);
    }

    const state = String(agency.state || "").trim().toUpperCase();
    if (state && !statePrefixes.includes(state)) {
      statePrefixes.push(state);
    }
  }

  return { agencyPrefixes, countyPrefixes, statePrefixes };
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

  const { agencyPrefixes, countyPrefixes, statePrefixes } =
    getAgencyAndCountyPrefixesForUser(authUser);

  const hasAgencyPrefixes =
    Array.isArray(agencyPrefixes) && agencyPrefixes.length > 0;
  const hasCountyPrefixes =
    Array.isArray(countyPrefixes) && countyPrefixes.length > 0;
  const hasStatePrefixes =
    Array.isArray(statePrefixes) && statePrefixes.length > 0;

  return list.filter((g) => {
    const privateFlag = String(g?.attributes?.private || "")
      .trim()
      .toLowerCase();

    if (privateFlag === "yes" || privateFlag === "true" || privateFlag === "1") {
      return false;
    }

    let name = String(g?.name || "").trim();
    if (!name) return false;

    // Remove tak_ prefix before parsing
    if (name.toLowerCase().startsWith("tak_")) {
      name = name.slice(4);
    }

    const upper = name.toUpperCase();
    const spaceIdx = upper.indexOf(" ");

    // If no space → treat as global group
    if (spaceIdx <= 0) return true;

    const prefix = upper.slice(0, spaceIdx).trim();

    if (hasAgencyPrefixes && agencyPrefixes.includes(prefix)) return true;
    if (hasCountyPrefixes && countyPrefixes.includes(prefix)) return true;
    if (hasStatePrefixes && statePrefixes.includes(prefix)) return true;

    return false;
  });
}

module.exports = {
  normalizeSuffix,
  normalizeGroupList,
  getAgencyAdminGroupName,
  getAllowedAgencySuffixesForGroups,
  hasAnyAgencyAdminsConfigured,
  getAgencyAccess,
  filterAgenciesForUser,
  isSuffixAllowed,
  isUsernameInAllowedAgencies,
  // Export both names; older routes use getAgencyAndCountyPrefixesForUser.
  getAgencyCountyAndStatePrefixesForUser,
  getAgencyAndCountyPrefixesForUser,
  filterGroupsForUser,
};
