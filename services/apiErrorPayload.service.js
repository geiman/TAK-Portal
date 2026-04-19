/**
 * Build a short, UI-safe error string for JSON API responses.
 * Authentik (and other proxies) often return full HTML pages on 5xx; never pass those through to the browser.
 */

function looksLikeHtml(str) {
  const s = String(str || "").trim();
  if (s.length < 8) return false;
  const head = s.slice(0, 80).toLowerCase();
  return (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    (head.startsWith("<") && /<\s*html[\s>]/.test(s.slice(0, 500).toLowerCase()))
  );
}

/**
 * @param {unknown} err - Typically an Error or axios error
 * @param {{ maxLen?: number }} [options]
 * @returns {string}
 */
function toSafeApiError(err, options = {}) {
  const maxLen = options.maxLen ?? 500;
  const status = err?.response?.status;
  const data = err?.response?.data;

  let raw = "";

  if (data !== undefined && data !== null) {
    if (typeof data === "string") {
      raw = data;
    } else if (typeof data === "object") {
      if (typeof data.detail === "string") raw = data.detail;
      else if (typeof data.message === "string") raw = data.message;
      else if (typeof data.error === "string") raw = data.error;
      else {
        // Django REST / Authentik field errors: { "email": ["Enter a valid email address."] }
        const fieldParts = [];
        for (const [field, val] of Object.entries(data)) {
          if (Array.isArray(val) && val.every(v => typeof v === "string")) {
            const label =
              field.length && field !== "non_field_errors"
                ? field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ")
                : "";
            const msg = val.filter(Boolean).join(" ");
            if (msg) fieldParts.push(label ? `${label}: ${msg}` : msg);
          }
        }
        if (fieldParts.length) {
          raw = fieldParts.join("; ");
        } else {
          try {
            raw = JSON.stringify(data);
          } catch {
            raw = "";
          }
        }
      }
    }
  }

  if (!String(raw).trim()) {
    raw = err?.message || "Unknown error";
  }

  raw = String(raw).trim();

  if (looksLikeHtml(raw)) {
    return status
      ? `Authentik or upstream API returned an error (HTTP ${status}). Check Authentik logs, URL/token, and connectivity.`
      : "Authentik or upstream API returned an HTML error page. Check Authentik logs, URL/token, and connectivity.";
  }

  if (raw.length > maxLen) return raw.slice(0, maxLen) + "…";
  return raw;
}

module.exports = {
  toSafeApiError,
  looksLikeHtml,
};
