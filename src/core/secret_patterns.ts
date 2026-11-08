/**
 * Text shaped like a credential, shared by the output scan (report/scan_secrets.ts) and the path guard (guard.ts).
 * Patterns run on latin1 text (one char per byte). The placeholders {API_KEY}, [REDACTED] and __NAME__ are fine.
 */
export const GUID = String.raw`[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}`;
const PLACE = String.raw`(?!\{API_KEY\}|\[REDACTED\]|__[A-Z_]+__)`;

export const CREDENTIAL_PATTERNS = [
  new RegExp(String.raw`\b[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)['"]?\s*[=:]\s*['"]?` + PLACE + String.raw`[A-Za-z0-9-]{16,}`, "g"),
  new RegExp(String.raw`(?:api[_-]?key|registrationkey|subscription-key|user_token|access_token)['"]?\s*[=:]\s*['"]` +
    PLACE + String.raw`(?:[A-Za-z0-9-]{16,}|` + GUID + String.raw`)['"]`, "gi"),
  new RegExp(String.raw`registrationkey['"]?\s*[=:]\s*['"]?` + PLACE + String.raw`[0-9a-f]{20,}`, "gi"),
  new RegExp(String.raw`[?&](?:api_key|apikey|api-key|registrationkey|token|access_token|user_token|subscription-key)=` +
    PLACE + String.raw`[A-Za-z0-9-]{16,}`, "gi"),
  new RegExp(String.raw`[?&]userid=` + GUID, "gi"),
  new RegExp(String.raw`"ParameterName"\s*:\s*"USERID"\s*,\s*"ParameterValue"\s*:\s*"` + GUID, "gi"),
  new RegExp(String.raw`authorization['"]?\s*[:=]\s*['"]?(?:bearer\s+|token\s+|basic\s+)?` + PLACE + String.raw`[A-Za-z0-9._-]{30,}`, "gi"),
  new RegExp(String.raw`(?:x-api-key|api-key|subscription-key)['"]?\s*:\s*['"]?` + PLACE + String.raw`[A-Za-z0-9._-]{16,}`, "gi"),
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
];
