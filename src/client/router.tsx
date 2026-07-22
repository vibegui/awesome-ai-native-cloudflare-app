// Runtime routing: one bundle, many views. The host sets
// hostContext.toolInfo.tool.name when it opens the iframe for a tool result;
// TOOL_PAGES maps that name to a view component. No router library needed.
import type { ComponentType } from "react";
import { useMcpHostContext, useMcpState } from "./context";
import { DashboardView } from "./views/dashboard";

const TOOL_PAGES: Record<string, ComponentType> = {
  get_status: DashboardView,
  list_notes: DashboardView,
  add_note: DashboardView,
};

export function AppRouter() {
  const { toolName, status } = useMcpState();
  const hostContext = useMcpHostContext();
  const insets = hostContext?.safeAreaInsets;

  if (status === "initializing") {
    return <div className="center muted">Connecting to host…</div>;
  }

  const Page = (toolName ? TOOL_PAGES[toolName] : undefined) ?? DashboardView;
  return (
    <main
      style={{
        paddingTop: insets?.top,
        paddingBottom: insets?.bottom,
        paddingLeft: insets?.left,
        paddingRight: insets?.right,
      }}
    >
      <Page />
    </main>
  );
}
