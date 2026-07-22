// Runtime routing: one bundle, many views. The host sets
// hostContext.toolInfo.tool.name when it opens the iframe for a tool result;
// TOOL_PAGES maps that name to a view component. A small tab bar lets humans
// switch views manually (e.g. to watch the agents' rooms). No router library.
import { type ComponentType, useState } from "react";
import { useMcpHostContext, useMcpState } from "./context";
import { DashboardView } from "./views/dashboard";
import { BoardView } from "./views/board";
import { RoomsView } from "./views/rooms";

const TOOL_PAGES: Record<string, ComponentType> = {
  get_status: DashboardView,
  list_notes: DashboardView,
  add_note: DashboardView,
  task_list: BoardView,
  task_create: BoardView,
  task_update: BoardView,
  room_read: RoomsView,
  room_post: RoomsView,
};

const TABS: Array<{ label: string; component: ComponentType }> = [
  { label: "Dashboard", component: DashboardView },
  { label: "Rooms", component: RoomsView },
  { label: "Board", component: BoardView },
];

export function AppRouter() {
  const { toolName, status } = useMcpState();
  const hostContext = useMcpHostContext();
  const insets = hostContext?.safeAreaInsets;
  const [tab, setTab] = useState<number | null>(null);

  if (status === "initializing") {
    return <div className="center muted">Connecting to host…</div>;
  }

  const Page =
    tab !== null
      ? (TABS[tab]?.component ?? DashboardView)
      : ((toolName ? TOOL_PAGES[toolName] : undefined) ?? DashboardView);

  return (
    <main
      style={{
        paddingTop: insets?.top,
        paddingBottom: insets?.bottom,
        paddingLeft: insets?.left,
        paddingRight: insets?.right,
      }}
    >
      <nav className="tabs">
        {TABS.map((t, i) => (
          <button
            key={t.label}
            type="button"
            className={`tab ${Page === t.component ? "active" : ""}`}
            onClick={() => setTab(i)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <Page />
    </main>
  );
}
