"use client";

import { useState } from "react";
import { ApiError, errorMessage, login } from "@/lib/api-client";
import { Button, Label, Notice } from "@/components/ui";

/**
 * Only paths on this site are accepted, so `?next=` cannot send anyone to another site.
 * The browser drops tabs and newlines when it resolves a URL ("/\t/evil.example" becomes
 * "//evil.example"), so the value is resolved the same way and its origin compared.
 */
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const origin = window.location.origin;
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname.startsWith("/login")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      setError("Enter the team password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(password);
      // A full navigation so the proxy sees the new session cookie.
      window.location.assign(safeNext());
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That password is not right." : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[340px]">
        <h1 className="text-center font-serif text-[32px] leading-tight tracking-[-0.01em]">Lead Engine</h1>
        <p className="mt-1.5 text-center text-quiet">Enter the team password to continue.</p>
        <form onSubmit={onSubmit} noValidate className="card mt-7 space-y-4 p-5">
          <div>
            <Label htmlFor="password">Password</Label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              className="field"
              value={password}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          </div>
          {error && <Notice>{error}</Notice>}
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            {busy ? "Checking…" : "Log in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
