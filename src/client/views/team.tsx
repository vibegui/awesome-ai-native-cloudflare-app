import { useCallback, useEffect, useState } from "react";
import { useCallTool } from "../context";

interface Task {
  id: string;
  subject: string;
  status: string;
  owner: string | null;
  updated_at: number;
}

interface RoomMessage {
  id: string;
  room: string;
  author: string;
  content: string;
  created_at: number;
}

function timeAgo(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

export function TeamView() {
  const callTool = useCallTool();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([
        callTool<{ tasks: Task[] }>("task_list", {}, { navigate: false }),
        callTool<{ messages: RoomMessage[] }>("room_read", { limit: 50 }, { navigate: false }),
      ]);
      setTasks(t.tasks);
      setMessages(m.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [callTool]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));

  return (
    <div className="dashboard">
      <h1>Team</h1>
      {error && <p className="error">{error}</p>}

      <h2>Board</h2>
      <ul className="notes">
        {open.map((t) => (
          <li key={t.id}>
            <div>
              <strong>{t.subject}</strong>
              <p className="muted">
                {t.status}
                {t.owner ? ` · ${t.owner}` : " · unclaimed"} · {timeAgo(t.updated_at)} ago
              </p>
            </div>
          </li>
        ))}
        {open.length === 0 && <li className="muted">No open tasks.</li>}
      </ul>

      <h2>Rooms</h2>
      <ul className="notes">
        {messages.map((m) => (
          <li key={m.id}>
            <div>
              <strong>
                #{m.room} · {m.author}
              </strong>
              <p className="muted">{m.content}</p>
              <p className="muted">{timeAgo(m.created_at)} ago</p>
            </div>
          </li>
        ))}
        {messages.length === 0 && <li className="muted">No messages yet.</li>}
      </ul>
    </div>
  );
}
