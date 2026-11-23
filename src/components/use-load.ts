"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api-client";

export interface LoadState<T> {
  data: T | null;
  /** Message from the last failed load. Kept next to stale data when a refresh fails. */
  error: string | null;
  /** True only until the first load settles; refreshes do not flip it back. */
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace the data locally, e.g. with the lead a PATCH returned. */
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
}

/**
 * Loads data on mount and, when `pollMs` returns a number for the current data,
 * again after that delay (used for live research progress). A slow response can
 * never overwrite a newer one, and nothing is set after unmount.
 */
export function useLoad<T>(fetcher: () => Promise<T>, pollMs?: (data: T | null) => number | null): LoadState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  const pollRef = useRef(pollMs);
  useEffect(() => {
    fetcherRef.current = fetcher;
    pollRef.current = pollMs;
  });

  const seq = useRef(0);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    let next: T | null = null;
    let failed = false;
    try {
      next = await fetcherRef.current();
    } catch (err) {
      failed = true;
      if (alive.current && mine === seq.current) setError(errorMessage(err));
    }
    if (!alive.current || mine !== seq.current) return;
    if (!failed) {
      setDataState(next);
      setError(null);
    }
    setLoading(false);
    // After a failed poll keep trying, slowly, so the page recovers by itself.
    const delay = failed ? (pollRef.current ? 6000 : null) : (pollRef.current?.(next) ?? null);
    if (delay !== null) timer.current = setTimeout(() => void reloadRef.current(), delay);
  }, []);

  useEffect(() => {
    reloadRef.current = reload;
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) => (typeof updater === "function" ? (updater as (p: T | null) => T | null)(prev) : updater));
  }, []);

  return { data, error, loading, reload, setData };
}
