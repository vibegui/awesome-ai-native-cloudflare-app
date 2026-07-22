// The company window: rooms as live chat. Watch the agents
// talk; speak as the human; pause or redirect the whole company. Pause/Resume are
// messages in the #control room — agents read the latest control directive
// from get_briefing and obey it (CLAUDE.md).
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useCallTool } from "../context";

interface RoomMessage {
  id: string;
  room: string;
  author: string;
  content: string;
  created_at: number;
}

const HUMAN = "Human";

function authorHue(author: string): number {
  let h = 0;
  for (const ch of author.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function timeAgo(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

export function RoomsView() {
  const callTool = useCallTool();
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [room, setRoom] = useState<string>("all");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await callTool<{ messages: RoomMessage[] }>("room_read", { limit: 200 }, { navigate: false });
      setMessages([...r.messages].sort((a, b) => a.created_at - b.created_at));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [callTool]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [messages, room]);

  const rooms = ["all", ...Array.from(new Set(messages.map((m) => m.room)))];
  const visible = room === "all" ? messages : messages.filter((m) => m.room === room);

  const lastControl = [...messages].reverse().find((m) => m.room === "control");
  const paused = lastControl ? /^pause/i.test(lastControl.content) : false;

  async function post(targetRoom: string, content: string) {
    setSending(true);
    try {
      await callTool("room_post", { room: targetRoom, author: HUMAN, content }, { navigate: false });
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await post(room === "all" ? "general" : room, content);
  }

  return (
    <div className="company">
      <div className="controlbar">
        <span className={`pill ${paused ? "paused" : "ok"}`}>
          {paused ? "⏸ paused" : "● running"}
        </span>
        {paused ? (
          <button
            type="button"
            disabled={sending}
            onClick={() => void post("control", "RESUME — back to normal pull order.")}
          >
            Resume
          </button>
        ) : (
          <button
            type="button"
            className="warn"
            disabled={sending}
            onClick={() =>
              void post("control", "PAUSE — hold all new work until further notice. Finish nothing new; reply in rooms only.")
            }
          >
            Pause company
          </button>
        )}
        {lastControl && (
          <span className="muted control-last" title={lastControl.content}>
            last directive: {lastControl.content.slice(0, 60)}
            {lastControl.content.length > 60 ? "…" : ""}
          </span>
        )}
      </div>

      <nav className="tabs rooms-nav">
        {rooms.map((r) => (
          <button
            key={r}
            type="button"
            className={`tab ${room === r ? "active" : ""}`}
            onClick={() => setRoom(r)}
          >
            {r === "all" ? "all rooms" : `#${r}`}
          </button>
        ))}
      </nav>

      {error && <p className="error">{error}</p>}

      <div className="feed" ref={feedRef}>
        {visible.map((m) => {
          const mine = m.author.toLowerCase() === HUMAN.toLowerCase();
          return (
            <div key={m.id} className={`msg ${mine ? "mine" : ""}`}>
              <span className="avatar" style={{ background: `hsl(${authorHue(m.author)} 65% 45%)` }}>
                {m.author.slice(0, 1).toUpperCase()}
              </span>
              <div className="bubble">
                <div className="msg-head">
                  <strong>{m.author}</strong>
                  {room === "all" && <span className="muted">#{m.room}</span>}
                  <span className="muted">{timeAgo(m.created_at)}</span>
                </div>
                <p>{m.content}</p>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && <p className="muted">No messages yet.</p>}
      </div>

      <form className="composer" onSubmit={onSend}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Speak as ${HUMAN} in ${room === "all" ? "#general" : `#${room}`} — direct, redirect, decide…`}
          aria-label="Message"
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
