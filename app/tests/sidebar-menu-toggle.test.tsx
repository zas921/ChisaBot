import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { RosterToggle, type ShellScope } from "@/components/layout/glass-topbar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SIDEBAR_STORAGE_KEY } from "@/lib/sidebar";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => window.localStorage.clear());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

for (const scope of ["app", "settings", "admin"] satisfies ShellScope[]) {
  test(`${scope}: saved collapsed menu always has a labeled control and toggling leaves the conversation mounted`, () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
    let mounts = 0;
    let unmounts = 0;
    function Conversation() {
      const [instance] = useState(() => crypto.randomUUID());
      useEffect(() => {
        mounts++;
        return () => { unmounts++; };
      }, []);
      return <div data-instance={instance} data-testid="conversation">Running conversation</div>;
    }
    const view = render(
      <SidebarShell iconWidth="80px" width="276px">
        <header><RosterToggle scope={scope} /></header>
        <Conversation />
      </SidebarShell>,
    );
    const conversation = view.getByTestId("conversation");
    const expand = view.getByRole("button", { name: "展开菜单" });
    expect(expand.textContent).toBe("展开菜单");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-controls")).toBe("chisabot-bot-list");
    fireEvent.click(expand);
    const collapse = view.getByRole("button", { name: "折叠菜单" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("expanded");
    fireEvent.click(collapse);
    expect(view.getByRole("button", { name: "展开菜单" }).getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
    expect(view.getByTestId("conversation")).toBe(conversation);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });
}
