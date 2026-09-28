// End-to-end test of the Worker + Durable Object flow against `wrangler dev`.
// Spawns a local dev server, exercises the HTTP/WebSocket API, then shuts down.
//
//   npm run build && node test/e2e.mjs
//
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRacePlan } from "../src/shared/simulation.ts";

const PORT = 18_787;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function startDevServer() {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--log-level", "error"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1_000) });
      return child;
    } catch {
      await sleep(400);
    }
  }
  child.kill("SIGTERM");
  throw new Error(`wrangler dev did not start.\n${output}`);
}

function connectWs(roomCode, entrantId, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${WS_BASE}/api/rooms/${roomCode}/ws?clientId=${crypto.randomUUID()}&entrantId=${entrantId}`,
    );
    const states = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "state") {
        states.push(msg.room);
        if (states.length === 1) resolve({ ws, states });
      }
    };
    ws.onerror = () => reject(new Error(`${label} websocket error`));
    setTimeout(() => reject(new Error(`${label} websocket timeout`)), 5_000);
  });
}

async function main() {
  const failures = [];
  const check = (name, cond) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) failures.push(name);
  };

  const server = await startDevServer();
  try {
    // Homepage renders the built SPA.
    const home = await fetch(`${BASE}/`);
    const homeHtml = await home.text();
    check("homepage serves SPA", home.status === 200 && homeHtml.includes('<div id="root">'));

    // Create a room.
    const names = ["Troy", "Jenny", "Mike", "Chris", "Alex", "Sam"];
    const createRes = await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test League", entrants: names }),
    });
    const created = await createRes.json();
    check(
      "create room returns code + host token",
      createRes.ok && /^[A-Z0-9]{6}$/.test(created.roomCode) && typeof created.hostToken === "string",
    );
    const { roomCode, hostToken } = created;

    // Input validation.
    const badRes = await fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", entrants: ["only-one"] }),
    });
    check("rejects fewer than 2 entrants", badRes.status === 400);

    // SPA fallback for the room route.
    const roomPage = await fetch(`${BASE}/r/${roomCode}`);
    check("/r/{code} serves SPA", roomPage.status === 200 && roomPage.headers.get("content-type")?.includes("text/html"));

    // Initial state.
    const state0 = await (await fetch(`${BASE}/api/rooms/${roomCode}`)).json();
    check("lobby state has commitment, hides seed", state0.status === "lobby" && !!state0.seedCommitment && !state0.seed);
    check("entrants normalized", state0.entrants.length === 6 && state0.entrants[0].name === "Troy");

    // Two websocket clients: presence.
    const a = await connectWs(roomCode, "e1", "A");
    const b = await connectWs(roomCode, "spectator", "B");
    await sleep(300);
    const lastState = () => b.states[b.states.length - 1];
    check("presence: entrant connection visible to others", lastState().connectedEntrantIds.includes("e1"));
    check("presence: spectator counted", lastState().spectatorCount === 1);

    // Identity change broadcasts.
    b.ws.send(JSON.stringify({ type: "identify", entrantId: "e3" }));
    await sleep(400);
    check("identify update broadcast", lastState().connectedEntrantIds.includes("e3") && lastState().spectatorCount === 0);

    // Host authorization.
    const noAuth = await fetch(`${BASE}/api/rooms/${roomCode}/start`, { method: "POST" });
    check("start without token rejected", noAuth.status === 403);

    const startRes = await fetch(`${BASE}/api/rooms/${roomCode}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${hostToken}` },
    });
    check("start with host token", startRes.ok);
    await sleep(400);
    const running = lastState();
    check("start broadcast reveals seed + startAt", running.status === "running" && !!running.seed && running.startAt > 0);

    const again = await fetch(`${BASE}/api/rooms/${roomCode}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${hostToken}` },
    });
    check("second start rejected", again.status === 409);

    check("sha256(seed) matches commitment", (await sha256(running.seed)) === state0.seedCommitment);

    // Late joiner mid-race receives the same seed + startAt.
    await sleep(2_500);
    const c = await connectWs(roomCode, "e2", "C");
    const late = c.states[0];
    check(
      "late joiner receives running state with same seed/startAt",
      late.status === "running" && late.seed === running.seed && late.startAt === running.startAt,
    );

    // Race completion via the Durable Object alarm.
    console.log("waiting for race to finish…");
    let finished;
    for (let i = 0; i < 60; i += 1) {
      await sleep(1_000);
      const s = await (await fetch(`${BASE}/api/rooms/${roomCode}`)).json();
      if (s.status === "finished") { finished = s; break; }
    }
    check("room finishes via alarm", !!finished);
    check("final order covers every entrant once", finished.finalOrder.length === 6 && new Set(finished.finalOrder).size === 6);

    // The stored order equals the deterministic simulation from the seed.
    const plan = createRacePlan(running.seed, finished.entrants);
    check("stored order === simulated order", JSON.stringify(plan.order) === JSON.stringify(finished.finalOrder));

    // Persistence after completion.
    const after = await (await fetch(`${BASE}/api/rooms/${roomCode}`)).json();
    check("finished state persists", after.status === "finished" && after.finalOrder.join() === finished.finalOrder.join());

    a.ws.close(); b.ws.close(); c.ws.close();
  } finally {
    server.kill("SIGTERM");
  }

  console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL CHECKS PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
