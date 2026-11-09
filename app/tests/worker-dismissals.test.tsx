import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useDismissedWorkers } from "@/lib/copilot/worker-dismissals";

const keyFor = (threadId: string) => `chisabot-worker-dismissals:v1:${threadId}`;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => { await GlobalRegistrator.unregister(); });

function Surface({ threadId, name, workerId = "worker" }: {
  threadId?: string | null;
  name: string;
  workerId?: string;
}) {
  const { dismissed, dismiss } = useDismissedWorkers(threadId);
  return dismissed.has(workerId) ? null : <button onClick={() => dismiss(workerId)} type="button">{name}</button>;
}

test("closing a failure on one surface hides it on both surfaces of that thread only", () => {
  const threadId = crypto.randomUUID();
  const other = crypto.randomUUID();
  const view = render(<>
    <Surface name="inline failure" threadId={threadId} />
    <Surface name="panel failure" threadId={threadId} />
    <Surface name="other conversation" threadId={other} />
  </>);
  fireEvent.click(view.getByRole("button", { name: "inline failure" }));
  expect(view.queryByRole("button", { name: "inline failure" })).toBeNull();
  expect(view.queryByRole("button", { name: "panel failure" })).toBeNull();
  expect(view.getByRole("button", { name: "other conversation" })).toBeDefined();
  expect(JSON.parse(window.localStorage.getItem(keyFor(threadId))!)).toEqual(["worker"]);
  expect(window.localStorage.getItem(keyFor(other))).toBeNull();
  view.unmount();
  expect(render(<Surface name="remounted failure" threadId={threadId} />).queryByRole("button")).toBeNull();
});

test("a fresh thread snapshot reads saved choices and tolerates damaged storage", () => {
  const restored = crypto.randomUUID();
  const damaged = crypto.randomUUID();
  window.localStorage.setItem(keyFor(restored), JSON.stringify(["worker", null, 3, ""]));
  window.localStorage.setItem(keyFor(damaged), "{broken JSON");
  const view = render(<>
    <Surface name="restored dismissed" threadId={restored} />
    <Surface name="damaged storage" threadId={damaged} />
  </>);
  expect(view.queryByRole("button", { name: "restored dismissed" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "damaged storage" }));
  expect(view.queryByRole("button", { name: "damaged storage" })).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(keyFor(damaged))!)).toEqual(["worker"]);
});

test("cross-tab storage updates merge concurrent closes without changing a different thread", () => {
  const threadId = crypto.randomUUID();
  const key = keyFor(threadId);
  const view = render(<>
    <Surface name="local failure" threadId={threadId} workerId="local" />
    <Surface name="remote failure" threadId={threadId} workerId="remote" />
    <Surface name="foreign failure" threadId={crypto.randomUUID()} workerId="remote" />
  </>);
  fireEvent.click(view.getByRole("button", { name: "local failure" }));
  const newValue = JSON.stringify(["remote"]);
  window.localStorage.setItem(key, newValue);
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue })); });
  expect(view.queryByRole("button", { name: "local failure" })).toBeNull();
  expect(view.queryByRole("button", { name: "remote failure" })).toBeNull();
  expect(view.getByRole("button", { name: "foreign failure" })).toBeDefined();
  expect(JSON.parse(window.localStorage.getItem(key)!).sort()).toEqual(["local", "remote"]);
});

test("a thread catches up with stored changes made while its surfaces were unmounted", () => {
  const threadId = crypto.randomUUID();
  const first = render(<Surface name="failure before leaving" threadId={threadId} />);
  expect(first.getByRole("button")).toBeDefined();
  first.unmount();
  window.localStorage.setItem(keyFor(threadId), JSON.stringify(["worker"]));
  expect(render(<Surface name="failure after returning" threadId={threadId} />).queryByRole("button")).toBeNull();
});

test("localStorage access failure retains the dismissal in memory across remounts", () => {
  const threadId = crypto.randomUUID();
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  try {
    const first = render(<Surface name="failure with storage blocked" threadId={threadId} />);
    fireEvent.click(first.getByRole("button"));
    expect(first.queryByRole("button")).toBeNull();
    first.unmount();
    expect(render(<Surface name="fallback survives remount" threadId={threadId} />).queryByRole("button")).toBeNull();
  } finally {
    if (original) Object.defineProperty(window, "localStorage", original);
    else delete (window as unknown as { localStorage?: Storage }).localStorage;
  }
});

test("without a thread, dismiss does nothing and never affects a later conversation", () => {
  const view = render(<Surface name="unbound failure" />);
  fireEvent.click(view.getByRole("button"));
  expect(view.getByRole("button", { name: "unbound failure" })).toBeDefined();
  view.rerender(<Surface name="bound failure" threadId={crypto.randomUUID()} />);
  expect(view.getByRole("button", { name: "bound failure" })).toBeDefined();
});
