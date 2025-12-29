// services/portalAuth.middleware.js
const { getBool, getString } = require("./env");

/**
 * Optional Authentik-based access control.
 *
 * When PORTAL_AUTH_ENABLED is "false":
 *   - middleware is a no-op.
 *
 * When "true":
 *   - require X-Authentik-Username header (from Caddy + Authentik)
 *   - optionally require membership in PORTAL_AUTH_REQUIRED_GROUP (comma-separated list)
 */
function portalAuthMiddleware(req, res, next) {
  const authEnabled = getBool("PORTAL_AUTH_ENABLED", false);

  // Always allow logout route to pass through so users who are blocked can sign out
  if (req.path === "/logout") {
    return next();
  }

  if (!authEnabled) {
    return next();
  }

  const username = req.headers["x-authentik-username"];
  const groupsHeader = req.headers["x-authentik-groups"] || "";

  if (!username) {
    return res
      .status(401)
      .send(
        "Authentication required. This portal expects to be behind an Authentik forward_auth proxy."
      );
  }

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
      // Render a friendly access denied page with a Logout button
      return res.status(403).render("access-denied", {
        username,
      });
    }
  }

  req.authentikUser = {
    username,
    groups: userGroups,
  };

  next();
}

module.exports = portalAuthMiddleware;
