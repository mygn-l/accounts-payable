import { useEffect, useRef, useState } from "react";
import { post } from "../api";
import { useUser } from "../session";

// The chat box at the bottom right of every signed-in page: questions go to Claude, which uses the app's MCP tools as the
// signed-in user. The conversation is kept in this browser for each user, so a reload or another page keeps it.
type Turn = { role: "user" | "assistant"; content: unknown };
type Shown = { who: "you" | "claude" | "error"; text: string };
type Saved = { messages: Turn[]; shown: Shown[] };

const load = (key: string): Saved => {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "null") as Saved | null;
    if (s && Array.isArray(s.messages) && Array.isArray(s.shown)) return s;
  } catch {
    // nothing kept, or storage is blocked
  }
  return { messages: [], shown: [] };
};

export function Assistant() {
  const key = `brim-assistant:${useUser().user_id}`;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Turn[]>(() => load(key).messages);
  const [shown, setShown] = useState<Shown[]>(() => load(key).shown);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ messages, shown }));
    } catch {
      // storage is blocked: the conversation lasts until the reload
    }
  }, [key, messages, shown]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown, busy, open]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setShown((s) => [...s, { who: "you", text }]);
    setBusy(true);
    try {
      const out = await post<{ messages: Turn[]; reply: string }>("/api/assistant", { messages: [...messages, { role: "user", content: text }] });
      setMessages(out.messages);
      setShown((s) => [...s, { who: "claude", text: out.reply }]);
    } catch (e) {
      setShown((s) => [...s, { who: "error", text: e instanceof Error ? e.message : "The assistant could not answer." }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button className="btn btn--sm fixed right-4 bottom-4 z-30" onClick={() => setOpen(true)}>
        Ask Claude
      </button>
    );
  return (
    <div className="card fixed right-4 bottom-4 z-30 flex h-[480px] max-h-[calc(100vh-2rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col">
      <div className="flex items-center justify-between border-b-2 border-border px-3 py-2">
        <strong className="text-sm">Ask Claude</strong>
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm">
        {shown.map((m, i) => (
          <div key={i} className={m.who === "you" ? "ml-8 rounded bg-surface-2 px-2 py-1" : m.who === "error" ? "form-error" : "mr-4 whitespace-pre-wrap"}>
            {m.text}
          </div>
        ))}
        {busy && <div className="muted">Working…</div>}
        <div ref={end} />
      </div>
      <form className="flex gap-2 border-t-2 border-border p-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input className="input min-w-0 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about invoices, payments…" autoFocus />
        <button className="btn btn--sm" disabled={busy || !draft.trim()}>Send</button>
      </form>
    </div>
  );
}
