import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { activeEventAt, createRacePlan, progressAt } from "./shared/simulation";
import type { Entrant, PublicRoomState, RacePlan } from "./shared/types";

type CreateResponse = { roomCode: string; hostToken: string };

function parseRoomCode() {
  const match = window.location.pathname.match(/^\/r\/([A-Z0-9]+)\/?$/i);
  return match?.[1]?.toUpperCase();
}

function hostStorageKey(roomCode: string) {
  return `draft-ice:host:${roomCode}`;
}

function identityStorageKey(roomCode: string) {
  return `draft-ice:identity:${roomCode}`;
}

function captureHostToken(roomCode: string) {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const token = hash.get("host");
  if (token) {
    localStorage.setItem(hostStorageKey(roomCode), token);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return token ?? localStorage.getItem(hostStorageKey(roomCode));
}

function App() {
  const roomCode = parseRoomCode();
  return roomCode ? <Room roomCode={roomCode} /> : <CreateRoom />;
}

function CreateRoom() {
  const [title, setTitle] = useState("Fantasy Hockey Draft");
  const [names, setNames] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const entrants = names
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);

    if (entrants.length < 2 || entrants.length > 20) {
      setError("Enter between 2 and 20 managers, one per line.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, entrants }),
      });
      const body = (await response.json()) as CreateResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not create room.");
      window.location.href = `/r/${body.roomCode}#host=${encodeURIComponent(body.hostToken)}`;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create room.");
      setSubmitting(false);
    }
  }

  return (
    <main className="shell landing">
      <section className="hero-card">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        <p className="eyebrow">LIVE FANTASY DRAFT LOTTERY</p>
        <h1>Put your draft order<br />on the ice.</h1>
        <p className="lede">
          Create a room, invite your league, and watch a synchronized hockey race decide the order live.
        </p>

        <form onSubmit={submit} className="create-form">
          <label>
            League name
            <input value={title} onChange={(event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)} maxLength={80} />
          </label>
          <label>
            Managers <span>one per line · 2–20</span>
            <textarea
              value={names}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setNames(event.target.value)}
              placeholder={"Troy\nJenny\nMike\nChris\n..."}
              rows={10}
              autoFocus
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={submitting}>{submitting ? "Creating…" : "Create live race"}</button>
        </form>
        <div className="feature-row">
          <span>Live synced</span><span>Provably fair</span><span>No accounts</span>
        </div>
      </section>
    </main>
  );
}

function Room({ roomCode }: { roomCode: string }) {
  const [room, setRoom] = useState<PublicRoomState | undefined>(undefined);
  const [error, setError] = useState("");
  const [hostToken] = useState(() => captureHostToken(roomCode));
  const [identity, setIdentity] = useState(() => localStorage.getItem(identityStorageKey(roomCode)) || "spectator");
  const [connected, setConnected] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const [starting, setStarting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const applyState = useCallback((next: PublicRoomState) => {
    setClockOffset(next.serverNow - Date.now());
    setRoom(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    let retryTimer: number | undefined;

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const clientId = crypto.randomUUID();
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/api/rooms/${roomCode}/ws?clientId=${encodeURIComponent(clientId)}&entrantId=${encodeURIComponent(identityRef.current)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError("");
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; room?: PublicRoomState };
        if (message.type === "state" && message.room) applyState(message.room);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retryTimer = window.setTimeout(connect, 1200);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [roomCode, applyState]);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "identify", entrantId: identity }));
    }
    localStorage.setItem(identityStorageKey(roomCode), identity);
  }, [identity, roomCode]);

  async function startRace() {
    if (!hostToken) return;
    setStarting(true);
    try {
      const response = await fetch(`/api/rooms/${roomCode}/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${hostToken}` },
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || "Could not start race.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start race.");
    } finally {
      setStarting(false);
    }
  }

  if (!room) {
    return <main className="shell"><div className="loading">{error || "Joining room…"}</div></main>;
  }

  const inviteUrl = `${window.location.origin}/r/${roomCode}`;
  const connectedSet = new Set(room.connectedEntrantIds);

  return (
    <main className="shell room-shell">
      <header className="room-header">
        <a href="/" className="brand-link"><div className="brand-mark small" aria-hidden="true"><span /></div>Draft Ice</a>
        <div className={`connection ${connected ? "online" : ""}`}><i />{connected ? "Live" : "Reconnecting"}</div>
      </header>

      <section className="room-title">
        <div>
          <p className="eyebrow">ROOM {room.roomCode}</p>
          <h1>{room.title}</h1>
        </div>
        <CopyButton value={inviteUrl} />
      </section>

      {error && <div className="error banner">{error}</div>}

      {room.status === "lobby" ? (
        <div className="lobby-grid">
          <section className="panel entrants-panel">
            <div className="panel-heading"><h2>Starting lineup</h2><span>{room.entrants.length} managers</span></div>
            <div className="entrants">
              {room.entrants.map((entrant, index) => (
                <button
                  key={entrant.id}
                  className={`entrant ${identity === entrant.id ? "selected" : ""}`}
                  onClick={() => setIdentity(entrant.id)}
                >
                  <span className="seed-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="entrant-name">{entrant.name}</span>
                  <span className={`presence ${connectedSet.has(entrant.id) ? "present" : ""}`}>{connectedSet.has(entrant.id) ? "HERE" : ""}</span>
                </button>
              ))}
              <button className={`entrant spectator ${identity === "spectator" ? "selected" : ""}`} onClick={() => setIdentity("spectator")}>
                <span className="seed-number">—</span><span className="entrant-name">Just watching</span>
                <span className="presence">{room.spectatorCount ? `${room.spectatorCount} watching` : ""}</span>
              </button>
            </div>
          </section>

          <aside className="panel host-panel">
            <p className="eyebrow">READY ROOM</p>
            <h2>{hostToken ? "You’re the commissioner." : "Waiting for the commissioner."}</h2>
            <p>Share the room link. Everyone can join live from a phone or browser; no account required.</p>
            <div className="fairness">
              <span>Random seed locked</span>
              <code>{room.seedCommitment.slice(0, 18)}…</code>
              <small>The seed is hidden until start, so the result can’t be changed after seeing it.</small>
            </div>
            {hostToken ? (
              <button className="primary start" onClick={startRace} disabled={starting}>{starting ? "Starting…" : "Drop the puck"}</button>
            ) : (
              <div className="waiting"><span className="pulse" /> Race starts when the host drops the puck.</div>
            )}
          </aside>
        </div>
      ) : (
        <Race room={room} clockOffset={clockOffset} />
      )}
    </main>
  );
}

function Race({ room, clockOffset }: { room: PublicRoomState; clockOffset: number }) {
  const plan = useMemo<RacePlan | undefined>(
    () => (room.seed ? createRacePlan(room.seed, room.entrants) : undefined),
    [room.seed, room.entrants],
  );
  const [now, setNow] = useState(Date.now());
  const [replayStart, setReplayStart] = useState<number | undefined>(undefined);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!plan || !room.startAt) return <div className="loading">Preparing race…</div>;

  const serverNow = now + clockOffset;
  const elapsed = replayStart ? now - replayStart : serverNow - room.startAt;
  const countdown = Math.max(0, Math.ceil(-elapsed / 1000));
  const complete = elapsed >= plan.durationMs + 600;
  const entrantById = new Map(room.entrants.map((entrant) => [entrant.id, entrant]));

  return (
    <section className="race-wrap">
      <div className="race-topline">
        <div>
          <p className="eyebrow">LIVE DRAFT ORDER</p>
          <h2>{countdown > 0 ? `Puck drops in ${countdown}` : complete ? "Final draft order" : "Race is on"}</h2>
        </div>
        {complete && <button className="secondary" onClick={() => setReplayStart(Date.now() + 1200)}>Replay race</button>}
      </div>

      {!complete ? (
        <div className="rink" aria-label="Draft order race">
          <div className="center-line" /><div className="blue-line one" /><div className="blue-line two" />
          <div className="goal-line" />
          {room.entrants.map((entrant) => {
            const racer = plan.racers.find((item) => item.entrantId === entrant.id)!;
            const progress = progressAt(racer, Math.max(0, elapsed));
            const event = activeEventAt(racer, Math.max(0, elapsed));
            const finished = elapsed >= racer.finishMs;
            return (
              <div className="lane" key={entrant.id}>
                <div className="lane-name">{entrant.name}</div>
                <div className="track">
                  <div className={`racer ${finished ? "finished" : ""}`} style={{ left: `calc(${progress * 100}% - ${progress * 36}px)` }}>
                    {event && !finished && <span className="race-event">{event}</span>}
                    <span className="stick">🏒</span><span className="puck" />
                  </div>
                </div>
              </div>
            );
          })}
          <div className="goal-label">GOAL</div>
        </div>
      ) : (
        <div className="results-card">
          <div className="podium-glow" />
          <ol className="results-list">
            {plan.order.map((id, index) => (
              <li key={id} className={index < 3 ? `top-${index + 1}` : ""}>
                <span className="pick">{index + 1}</span>
                <span>{entrantById.get(id)?.name}</span>
                {index === 0 && <b>1.01</b>}
              </li>
            ))}
          </ol>
          <div className="proof">
            <span>Verified seed</span>
            <code>{room.seed}</code>
            <small>SHA-256: {room.seedCommitment}</small>
          </div>
        </div>
      )}
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="secondary" onClick={async () => {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }}>{copied ? "Copied" : "Copy invite link"}</button>
  );
}

export default App;
