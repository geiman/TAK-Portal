// services/portalAuth.middleware.js
const { getBool, getString } = require("./env");
const accessSvc = require("./access.service");

const PUBLIC_PATHS = new Set([
  "/",
  "/dashboard",
  "/setup-my-device",

  // ✅ public request access pages
  "/request-access",
  "/request-access/confirmation",

  "/api/setup-my-device/enroll-qr",
  "/api/qr/download",
  "/styles.css",
  "/favicon.ico",
]);

function parseGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePath(p) {
  const out = String(p || "").replace(/\/+$/, "");
  return out || "/";
}

function portalAuthMiddleware(req, res, next) {
  const authEnabled = getBool("PORTAL_AUTH_ENABLED", false);

  // Safe defaults for views
  res.locals.authUser = null;
  res.locals.isGlobalAdmin = false;
  res.locals.isAgencyAdmin = false;

  if (req.path === "/logout") {
    return next();
  }

  const normalizedPath = normalizePath(req.path);
  const isPublicPath = PUBLIC_PATHS.has(normalizedPath);

  // ✅ allow anonymous submission only for POST /api/user-requests
  const isPublicAccessRequestSubmit =
    normalizedPath === "/api/user-requests" &&
    String(req.method || "").toUpperCase() === "POST";

  // AUTH DISABLED => EVERYTHING WIDE OPEN + BOOTSTRAP ADMIN USER
  if (!authEnabled) {
    const bootstrapUser = {
      username: "bootstrap",
      uid: null,
      displayName: "ANONYMOUS",
      groups: [],
      isGlobalAdmin: true,
      isAgencyAdmin: true,
    };

    req.authentikUser = bootstrapUser;
    res.locals.authUser = bootstrapUser;
    res.locals.isGlobalAdmin = true;
    res.locals.isAgencyAdmin = true;

    return next();
  }

  // AUTH ENABLED
  const usernameHeader = req.headers["x-authentik-username"];
  const username = (usernameHeader && String(usernameHeader).trim()) || "";

  const uidHeader =
    req.headers["x-authentik-uid"] ||
    req.headers["x-authentik-user-id"] ||
    req.headers["x-authentik-userid"] ||
    req.headers["x-authentik-user-pk"];
  const uid = (uidHeader && String(uidHeader).trim()) || null;

  const groupsHeader = req.headers["x-authentik-groups"] || "";

  // ✅ Allow anonymous access to public paths & public submit endpoint
  if (!username && (isPublicPath || isPublicAccessRequestSubmit)) {
    return next();
  }

  if (!username) {
    return res
      .status(401)
      .send(
        "Authentication required. This portal expects to be behind an Authentik forward_auth proxy."
      );
  }

  const userGroups = String(groupsHeader)
    .split(/[;|,]/)
    .map((g) => String(g || "").trim())
    .filter(Boolean);

  const userGroupsLower = userGroups.map((g) => g.toLowerCase());

  const globalGroupsStr = getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim();
  const globalGroups = parseGroupList(globalGroupsStr);

  const isGlobalAdmin =
    globalGroups.length > 0 &&
    globalGroups.some((needed) => userGroupsLower.includes(needed));

  // NOTE: these two calls can throw if access config files are missing/invalid
  const agencySuffixesForUser =
    accessSvc.getAllowedAgencySuffixesForGroups(userGroupsLower);
  const isAgencyAdmin =
    Array.isArray(agencySuffixesForUser) && agencySuffixesForUser.length > 0;

  const anyAdminGroupConfigured =
    globalGroups.length > 0 || accessSvc.hasAnyAgencyAdminsConfigured();

  const hasAnyRequired =
    !anyAdminGroupConfigured || isGlobalAdmin || isAgencyAdmin;

  if (!hasAnyRequired && !isPublicPath) {
    return res.status(403).render("access-denied", { username });
  }

  const displayNameHeader =
    req.headers["x-authentik-name"] || req.headers["x-authentik-display-name"];
  const displayName =
    (displayNameHeader && String(displayNameHeader).trim()) || username;

  const authUser = {
    username,
    uid,
    displayName,
    groups: userGroups,
    isGlobalAdmin,
    isAgencyAdmin,
  };

  req.authentikUser = authUser;
  res.locals.authUser = authUser;
  res.locals.isGlobalAdmin = isGlobalAdmin;
  res.locals.isAgencyAdmin = isAgencyAdmin;

  return next();
}

module.exports = portalAuthMiddleware;