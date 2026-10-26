import { IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useId, useState } from "react";
import { readStoredPreference, writeStoredPreference } from "@/lib/preference-storage";

/** Keep the body mounted so collapsing does not discard list positions or interactive state. */
export function PanelCard({
  title,
  preferenceKey,
  status,
  menu,
  children,
}: {
  title: string;
  preferenceKey: string;
  status?: ReactNode;
  menu: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readStoredPreference(preferenceKey) === "collapsed");
  const bodyId = useId();
  return (
    <>
      <header className="live-panel-head">
        <h3 className="live-panel-heading">
          <button
            aria-controls={bodyId}
            aria-expanded={!collapsed}
            className="live-panel-toggle"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              writeStoredPreference(preferenceKey, next ? "collapsed" : "expanded");
            }}
            type="button"
          >
            <IconChevronRight aria-hidden className="live-panel-chevron size-4 shrink-0" />
            <span className="live-panel-title">{title}</span>
          </button>
        </h3>
        {status}
        {menu}
      </header>
      <div className="live-panel-content" hidden={collapsed} id={bodyId}>
        {children}
      </div>
    </>
  );
}
