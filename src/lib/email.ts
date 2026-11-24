/**
 * One plain email address, checked the same way in the browser and on the server (imports,
 * the lead page and PATCH /api/leads/[id]). Pure.
 *
 * The local part takes letters, digits and . _ + ' - only: never ? # % & = / or a space, so a
 * stored address can never add a header (a hidden bcc=) to a mailto: link. The domain must be a
 * hostname: labels of letters, digits and hyphens, and a top-level domain of letters.
 */
const LOCAL_RE = /^[\p{L}\p{M}\p{N}_+'-]+(?:\.[\p{L}\p{M}\p{N}_+'-]+)*$/u;
const HOST_RE = /^(?=.{4,253}$)(?:[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?\.)+(?:[\p{L}\p{M}]{2,63}|xn--[a-z0-9-]{2,59})$/iu;

export function isEmailAddress(value: string): boolean {
  if (typeof value !== "string" || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  return local.length <= 64 && LOCAL_RE.test(local) && HOST_RE.test(value.slice(at + 1));
}
