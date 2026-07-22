// MCP-App bridge: wires @modelcontextprotocol/ext-apps' useApp() into React.
//
// The host (deco studio, or any MCP-Apps-capable client) renders this bundle
// in a sandboxed iframe and proxies every tool call through its own MCP
// client — the UI never holds the worker URL or auth token.
import {
  type App,
  type McpUiHostContext,
  useApp,
  useHostStyles,
} from "@modelcontextprotocol/ext-apps/react";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useState,
} from "react";
import { INITIAL_STATE, type McpState } from "./types";

const McpStateContext = createContext<McpState>(INITIAL_STATE);
const McpStateSetterContext = createContext<Dispatch<SetStateAction<McpState>> | null>(null);
const McpAppContext = createContext<App | null>(null);
const McpHostContext = createContext<McpUiHostContext | undefined>(undefined);

export function McpProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<McpState>(INITIAL_STATE);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>(undefined);

  const onAppCreated = useCallback((app: App) => {
    app.ontoolinput = (params) => {
      setState((prev) => ({ ...prev, status: "tool-input", toolInput: params.arguments }));
    };
    app.ontoolresult = (result) => {
      if (result.isError) {
        const textBlock = result.content?.find((c) => c.type === "text");
        const errorText =
          (textBlock?.type === "text" ? textBlock.text : undefined) ?? "Tool returned an error";
        setState((prev) => ({ ...prev, status: "error", error: errorText }));
        return;
      }
      setState((prev) => ({ ...prev, status: "tool-result", toolResult: result.structuredContent }));
    };
    app.ontoolcancelled = () => {
      setState((prev) => ({ ...prev, status: "tool-cancelled" }));
    };
    app.onerror = (err) => console.error("MCP App error:", err);
    app.onhostcontextchanged = (ctx) => setHostContext((prev) => ({ ...prev, ...ctx }));
  }, []);

  const { app, isConnected } = useApp({
    appInfo: { name: "awesome-ai-native-cloudflare-app", version: "0.1.0" },
    capabilities: {},
    onAppCreated,
  });

  useHostStyles(app, app?.getHostContext());

  if (isConnected && state.status === "initializing") {
    const ctx = app?.getHostContext();
    if (ctx) setHostContext(ctx);
    setState({ status: "connected", toolName: ctx?.toolInfo?.tool.name });
  }

  return (
    <McpAppContext.Provider value={app}>
      <McpHostContext.Provider value={hostContext}>
        <McpStateSetterContext.Provider value={setState}>
          <McpStateContext.Provider value={state}>{children}</McpStateContext.Provider>
        </McpStateSetterContext.Provider>
      </McpHostContext.Provider>
    </McpAppContext.Provider>
  );
}

export function useMcpState<TInput = unknown, TResult = unknown>() {
  return useContext(McpStateContext) as McpState<TInput, TResult>;
}

export function useMcpApp() {
  return useContext(McpAppContext);
}

export function useMcpHostContext() {
  return useContext(McpHostContext);
}

/**
 * Call a tool on this same MCP server; the host proxies the call. The result
 * is returned AND (by default) written into McpState so the router can swap
 * views. Pass { navigate: false } for an in-place data refresh.
 */
export function useCallTool() {
  const app = useMcpApp();
  const setState = useContext(McpStateSetterContext);
  return useCallback(
    async <T = unknown>(
      name: string,
      args: Record<string, unknown> = {},
      opts: { navigate?: boolean } = {},
    ): Promise<T> => {
      if (!app) throw new Error("MCP App not connected yet");
      const navigate = opts.navigate !== false;

      const result = await app.callServerTool({ name, arguments: args });
      if (result?.isError) {
        const textBlock = result.content?.find((c) => c.type === "text");
        const message =
          textBlock?.type === "text" ? textBlock.text : `Tool ${name} returned an error`;
        throw new Error(message);
      }
      if (navigate && setState) {
        setState((prev) => ({
          ...prev,
          status: "tool-result",
          toolName: name,
          toolResult: result.structuredContent,
        }));
      }
      return result.structuredContent as T;
    },
    [app, setState],
  );
}
