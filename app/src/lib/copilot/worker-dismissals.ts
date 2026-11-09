import { useCallback, useSyncExternalStore } from "react";
import { readStoredPreference, writeStoredPreference } from "@/lib/preference-storage";

const STORAGE_PREFIX = "chisabot-worker-dismissals:v1:";
const EMPTY: ReadonlySet<string> = new Set();
const emptySnapshot = () => EMPTY;

type Dismissals = {
  ids: ReadonlySet<string>;
  listeners: Set<() => void>;
  stopListening?: () => void;
};

const threads = new Map<string, Dismissals>();

function parseIds(raw: string | null): ReadonlySet<string> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const ids = value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    return ids.length ? new Set(ids) : EMPTY;
  } catch {
    return null;
  }
}

function threadFor(key: string): Dismissals {
  let thread = threads.get(key);
  if (!thread) {
    thread = { ids: parseIds(readStoredPreference(key)) ?? EMPTY, listeners: new Set() };
    threads.set(key, thread);
  }
  return thread;
}

function addIds(base: ReadonlySet<string>, additions: Iterable<string>): ReadonlySet<string> {
  let next: Set<string> | undefined;
  for (const id of additions) {
    if (!base.has(id)) (next ??= new Set(base)).add(id);
  }
  return next ?? base;
}

function publish(thread: Dismissals, ids: ReadonlySet<string>) {
  if (thread.ids === ids) return;
  thread.ids = ids;
  for (const listener of thread.listeners) listener();
}

function subscribeToThread(key: string, listener: () => void) {
  const thread = threadFor(key);
  thread.listeners.add(listener);
  if (thread.listeners.size === 1 && typeof window !== "undefined") {
    const target = window;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      try {
        if (event.storageArea && event.storageArea !== target.localStorage) return;
      } catch {
        return;
      }
      if (event.newValue === null) {
        publish(thread, EMPTY);
        return;
      }
      const incoming = parseIds(event.newValue);
      if (!incoming) return;
      // Dismissals are additive. Reconcile simultaneous closes in different tabs
      // without replacing a local close or writing the same list back in a loop.
      const stored = parseIds(readStoredPreference(key));
      const merged = addIds(addIds(thread.ids, incoming), stored ?? EMPTY);
      if (stored && addIds(stored, merged) !== stored) {
        writeStoredPreference(key, JSON.stringify([...merged]));
      }
      publish(thread, merged);
    };
    target.addEventListener("storage", onStorage);
    thread.stopListening = () => target.removeEventListener("storage", onStorage);
    // Catch up if this conversation had no mounted subscribers in this tab.
    publish(thread, addIds(thread.ids, parseIds(readStoredPreference(key)) ?? EMPTY));
  }
  return () => {
    thread.listeners.delete(listener);
    if (!thread.listeners.size) {
      thread.stopListening?.();
      thread.stopListening = undefined;
    }
  };
}

/** Hide worker cards in this browser, sharing the choice between every surface of the thread. */
export function useDismissedWorkers(threadId: string | null | undefined): {
  dismissed: ReadonlySet<string>;
  dismiss: (workerId: string) => void;
} {
  const key = threadId ? STORAGE_PREFIX + threadId : null;
  const subscribe = useCallback((listener: () => void) => key ? subscribeToThread(key, listener) : () => {}, [key]);
  const getSnapshot = useCallback(() => key ? threadFor(key).ids : EMPTY, [key]);
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, emptySnapshot);
  const dismiss = useCallback((workerId: string) => {
    if (!key || !workerId.trim()) return;
    const thread = threadFor(key);
    const ids = addIds(addIds(thread.ids, parseIds(readStoredPreference(key)) ?? EMPTY), [workerId]);
    if (ids === thread.ids) return;
    writeStoredPreference(key, JSON.stringify([...ids]));
    publish(thread, ids);
  }, [key]);
  return { dismissed, dismiss };
}
