// services/portalAuth.middleware.js
const { getBool, getString } = require("./env");

/**
 * Optional Authentik-based access control.
 *
 * When PORTAL_AUTH_ENABLED is "false":
 *   - middleware is a no-op.
 *
 * When "true":
 *   - require X-Authentik-Username header (Caddy + Authentik forward_auth).
 *   - if PORTAL_AUTH_REQUIRED_GROUP is set, require user to be in at least one of those groups.
 *
 * PORTAL_AUTH_REQUIRED_GROUP can be a comma-separated list of groups.
 * Authentik sends X-Authentik-Groups as a '|' separated list, e.g. "group1|group2|group3".
 */
function portalAuthMiddleware(req, res, next) {
  const authEnabled = getBool("PORTAL_AUTH_ENABLED", false);
  if (!authEnabled) {
    return next();
  }

  // Node lower-cases header names, so we use lowercase keys here.
  const username = req.headers["x-authentik-username"];
  const groupsHeader = req.headers["x-authentik-groups"] || "";

  if (!username) {
    return res
      .status(401)
      .send(
        "Authentication required. This portal expects to be behind an Authentik forward_auth proxy."
      );
  }

  // Authentik groups come in as a pipe-separated string
  const userGroups = groupsHeader
    .split("|")
    .map((g) => String(g || "").trim())
    .filter(Boolean);

  const requiredGroupsStr = getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim();
  if (requiredGroupsStr) {
    const requiredGroups = requiredGroupsStr
      .split(",")
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean);

    const hasAnyRequired = requiredGroups.some((needed) =>
      userGroups.some((g) => g.toLowerCase() === needed)
    );

    if (!hasAnyRequired) {
      return res
        .status(403)
        .send("Access denied. You are not in an allowed Authentik group.");
    }
  }

  // Make Authentik user info available downstream if needed (optional)
  req.authentikUser = {
    username,
    groups: userGroups,
  };

  next();
}

module.exports = portalAuthMiddleware;
