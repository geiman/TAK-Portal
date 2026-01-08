// services/portalAuth.middleware.js
const { getBool, getString } = require("./env");
const accessSvc = require("./access.service");

/**
 * Optional Authentik-based access control with role levels.
 *
 * When PORTAL_AUTH_ENABLED is "false":
 *   - middleware is a no-op (no headers required).
 *
 * When "true":
 *   - for most routes:
 *       - require X-Authentik-Username header (from Caddy + Authentik)
 *       - require membership in at least one configured admin group
 *         if any are configured.
 */

const PUBLIC_PATHS = new Set([
  "/setup-my-device",
]);

function parseGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

function portalAuthMiddleware(req, res, next) {
  const authEnabled = getBool("PORTAL_AUTH_ENABLED", false);

  // Safe defaults for views
  res.locals.authUser = null;
  res.locals.isGlobalAdmin = false;
  res.locals.isAgencyAdmin = false;

  // Always allow logout through so users who are blocked can sign out
  if (req.path === "/logout") {
    return next();
  }

  const isPublicPath = PUBLIC_PATHS.has(req.path);

  if (!authEnabled) {
    // No authentication enforced at all
    return next();
  }

  const username = req.headers["x-authentik-username"];
  const groupsHeader = req.headers["x-authentik-groups"] || "";

  // Allow completely anonymous access to public paths
  if (!username && isPublicPath) {
    return next();
  }

  if (!username) {
    return res
      .status(401)
      .send(
        "Authentication required. This portal expects to be behind an Authentik forward_auth proxy."
      );
  }

  // Parse groups from header. Authentik commonly uses ';' as a separator,
  // but we also tolerate ',' and '|' just in case.
  const userGroups = String(groupsHeader)
    .split(/[;|,]/)
    .map((g) => String(g || "").trim())
    .filter(Boolean);

  const userGroupsLower = userGroups.map((g) => g.toLowerCase());

  // Global Admin groups (existing setting)
  const globalGroupsStr = getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim();
  const globalGroups = parseGroupList(globalGroupsStr);

  const isGlobalAdmin =
    globalGroups.length > 0 &&
    globalGroups.some((needed) => userGroupsLower.includes(needed));

  // Agency admin status now comes purely from the Agencies config. Any
  // agency that lists one of the user's groups in its "adminGroups"
  // field will treat this user as an agency admin for that agency.
  const agencySuffixesForUser =
    accessSvc.getAllowedAgencySuffixesForGroups(userGroupsLower);
  const isAgencyAdmin =
    Array.isArray(agencySuffixesForUser) && agencySuffixesForUser.length > 0;

  const anyAdminGroupConfigured =
    globalGroups.length > 0 || accessSvc.hasAnyAgencyAdminsConfigured();

  // If no admin groups are configured at all, any authenticated user is allowed.
  const hasAnyRequired =
    !anyAdminGroupConfigured || isGlobalAdmin || isAgencyAdmin;

  // For public paths we only enforce "is logged in" when auth is enabled.
  // Group membership does not gate access to the Welcome page, etc.
  if (!hasAnyRequired && !isPublicPath) {
    const safeUsername = username || "";
    return res.status(403).render("access-denied", {
      username: safeUsername,
    });
  }

const displayNameHeader =
  req.headers["x-authentik-name"] || req.headers["x-authentik-display-name"];
const displayName =
  (displayNameHeader && String(displayNameHeader).trim()) || username;

  const authUser = {
    username,
    displayName,
    groups: userGroups,
    isGlobalAdmin,
    isAgencyAdmin,
  };

  req.authentikUser = authUser;
  res.locals.authUser = authUser;
  res.locals.isGlobalAdmin = isGlobalAdmin;
  res.locals.isAgencyAdmin = isAgencyAdmin;

  next();
}

module.exports = portalAuthMiddleware;
