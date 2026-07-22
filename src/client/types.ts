// UI-side mirror of the JSON shapes the worker's MCP tools return.

export interface Note {
  id: string;
  title: string;
  body: string;
  created_at: number;
}

export interface StatusResult {
  ok: boolean;
  notes: number;
  whatsappConfigured: boolean;
  llmConfigured: boolean;
}

export type McpStatus =
  | "initializing"
  | "connected"
  | "tool-input"
  | "tool-result"
  | "tool-cancelled"
  | "error";

export interface McpState<TInput = unknown, TResult = unknown> {
  status: McpStatus;
  toolName?: string;
  toolInput?: TInput;
  toolResult?: TResult;
  error?: string;
}

export const INITIAL_STATE: McpState = { status: "initializing" };
