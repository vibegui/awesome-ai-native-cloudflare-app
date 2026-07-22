import { useCallback, useEffect, useState } from "react";
import { useCallTool } from "../context";

interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  created_by: string | null;
  updated_at: number;
}

const ORDER = ["review", "in_progress", "pending", "done", "cancelled"];

function timeAgo(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

export function BoardView() {
  const callTool = useCallTool();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const t = await callTool<{ tasks: Task[] }>("task_list", {}, { navigate: false });
      setTasks(t.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [callTool]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [refresh]);

  const sorted = [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return (
    <div>
      <h1>Board</h1>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {sorted.map((t) => (
          <li key={t.id}>
            <div>
              <strong>{t.subject}</strong>
              <p className="muted">
                <span className={`status status-${t.status}`}>{t.status}</span>
                {t.owner ? ` · ${t.owner}` : " · unclaimed"}
                {t.created_by ? ` · by ${t.created_by}` : ""} · {timeAgo(t.updated_at)} ago
              </p>
              {t.description && <p className="muted">{t.description}</p>}
            </div>
          </li>
        ))}
        {tasks.length === 0 && <li className="muted">No tasks yet.</li>}
      </ul>
    </div>
  );
}
