// services/apiTokenAuth.middleware.js
//
// Authenticates /api/v1 requests with a portal API token
// (Authorization: Bearer tpk_...). Authentik identity headers are ignored on
// this path, so Caddy can route /api/v1/* around forward_auth safely.

const apiTokens = require("./apiTokens.service");
const permsSvc = require("./permissions.service");

// No per-IP lockout: behind Caddy every request has the same IP, so a lockout
// would let anyone block real clients. Tokens are 256-bit random values.

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "").trim();
}

async function apiTokenAuth(req, res, next) {
  // Never trust forwarded identity on the token API.
  delete req.authentikUser;
  delete req.effectivePermissionSet;

  const ip = clientIp(req);

  const token = apiTokens.extractToken(req);
  if (!token) {
    res.set("WWW-Authenticate", 'Bearer realm="tak-portal"');
    return res.status(401).json({ error: "API token required (Authorization: Bearer tpk_...)." });
  }

  let row = null;
  try {
    row = await apiTokens.findActiveToken(token);
  } catch (err) {
    return res.status(503).json({ error: "Token check failed; database unavailable." });
  }
  if (!row) {
    res.set("WWW-Authenticate", 'Bearer realm="tak-portal", error="invalid_token"');
    return res.status(401).json({ error: "Invalid, expired, or revoked API token." });
  }

  const authUser = apiTokens.buildAuthUserForToken(row);
  req.authentikUser = authUser;
  req.effectivePermissionSet = permsSvc.getEffectivePermissionSet(authUser, false);
  res.locals.authUser = authUser;
  apiTokens.touchToken(row.id, ip);
  return next();
}

module.exports = apiTokenAuth;
