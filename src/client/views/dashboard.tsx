import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useCallTool, useMcpState } from "../context";
import type { Note, StatusResult } from "../types";

interface NotesResult {
  notes: Note[];
}

export function DashboardView() {
  const callTool = useCallTool();
  const { toolResult } = useMcpState();
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, n] = await Promise.all([
        callTool<StatusResult>("get_status", {}, { navigate: false }),
        callTool<NotesResult>("list_notes", {}, { navigate: false }),
      ]);
      setStatus(s);
      setNotes(n.notes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [callTool]);

  // If the host opened us with a preloaded list_notes result, use it;
  // refresh either way to also pick up status.
  useEffect(() => {
    const preloaded = toolResult as NotesResult | undefined;
    if (preloaded?.notes) setNotes(preloaded.notes);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await callTool("add_note", { title: title.trim() }, { navigate: false });
    setTitle("");
    await refresh();
  }

  async function onDelete(id: string) {
    await callTool("delete_note", { id }, { navigate: false });
    await refresh();
  }

  return (
    <div className="dashboard">
      <h1>Notes</h1>

      {status && (
        <div className="pills">
          <span className="pill">{status.notes} notes</span>
          <span className={`pill ${status.llmConfigured ? "ok" : "off"}`}>
            LLM {status.llmConfigured ? "configured" : "not configured"}
          </span>
          <span className={`pill ${status.whatsappConfigured ? "ok" : "off"}`}>
            WhatsApp {status.whatsappConfigured ? "configured" : "not configured"}
          </span>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <form onSubmit={onAdd} className="add-form">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New note title…"
          aria-label="New note title"
        />
        <button type="submit">Add</button>
      </form>

      <ul className="notes">
        {notes.map((n) => (
          <li key={n.id}>
            <div>
              <strong>{n.title}</strong>
              {n.body && <p className="muted">{n.body}</p>}
            </div>
            <button type="button" className="ghost" onClick={() => void onDelete(n.id)}>
              ✕
            </button>
          </li>
        ))}
        {notes.length === 0 && <li className="muted">No notes yet.</li>}
      </ul>
    </div>
  );
}
