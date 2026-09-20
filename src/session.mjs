import { USER_ASK_MAX } from "./roles.mjs";

export function looksSecret(text) {
  return /apikey_|Bearer\s+[A-Za-z0-9._-]+|TYPESAFE_API_KEY\s*=/i.test(String(text ?? ""));
}

export function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export function sanitizeAsk(text, max = USER_ASK_MAX) {
  if (looksSecret(text)) return "";
  return truncate(String(text ?? "").trim(), max);
}
