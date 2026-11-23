/**
 * Links that open a prefilled message in the user's own tools. Client-safe.
 * V0 sends nothing itself: these open Gmail or the mail app with the draft filled in.
 */

export function gmailComposeUrl(input: { to?: string | null; subject: string; body: string }): string {
  const params = new URLSearchParams({ view: "cm", fs: "1", su: input.subject, body: input.body });
  if (input.to) params.set("to", input.to);
  return `https://mail.google.com/mail/?${params.toString()}`;
}

export function mailtoUrl(input: { to?: string | null; subject: string; body: string }): string {
  const q = new URLSearchParams({ subject: input.subject, body: input.body }).toString().replace(/\+/g, "%20");
  return `mailto:${encodeURIComponent(input.to ?? "")}?${q}`;
}
