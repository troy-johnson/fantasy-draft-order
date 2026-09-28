import { DurableObject } from "cloudflare:workers";
import { createRacePlan } from "../src/shared/simulation";
import type { Entrant, PersistedRoomState, PublicRoomState } from "../src/shared/types";

interface Env {
  DRAFT_ROOMS: DurableObjectNamespace<DraftRoom>;
  ASSETS: Fetcher;
}

type SocketAttachment = { clientId: string; entrantId: string };

const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

function randomString(length: number, alphabet = ROOM_CODE_ALPHABET) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return result;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") continue;
    const name = value.trim().replace(/\s+/g, " ").slice(0, 50);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function stubFor(env: Env, roomCode: string) {
  const id = env.DRAFT_ROOMS.idFromName(roomCode);
  return env.DRAFT_ROOMS.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      let body: { title?: unknown; entrants?: unknown };
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid request body." }, { status: 400 });
      }

      const names = normalizeNames(body.entrants);
      if (names.length < 2 || names.length > 20) {
        return json({ error: "Enter between 2 and 20 unique manager names." }, { status: 400 });
      }

      const title = typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 80)
        : "Fantasy Hockey Draft";
      const hostToken = randomToken();
      const hostTokenHash = await sha256(hostToken);
      const seed = randomToken();
      const seedCommitment = await sha256(seed);
      const entrants: Entrant[] = names.map((name, index) => ({ id: `e${index + 1}`, name }));

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomCode = randomString(6);
        const response = await stubFor(env, roomCode).fetch("https://room.internal/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomCode, title, entrants, seed, seedCommitment, hostTokenHash }),
        });
        if (response.ok) return json({ roomCode, hostToken });
        if (response.status !== 409) return json({ error: "Could not create room." }, { status: 500 });
      }
      return json({ error: "Could not allocate a room code. Try again." }, { status: 503 });
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(start|ws))?$/i);
    if (roomMatch) {
      const roomCode = roomMatch[1].toUpperCase();
      const action = roomMatch[2];
      const stub = stubFor(env, roomCode);

      if (action === "ws") {
        const headers = new Headers(request.headers);
        return stub.fetch(new Request(`https://room.internal/ws${url.search}`, {
          method: "GET",
          headers,
        }));
      }
      if (action === "start" && request.method === "POST") {
        const authorization = request.headers.get("authorization") || "";
        return stub.fetch("https://room.internal/start", {
          method: "POST",
          headers: { authorization },
        });
      }
      if (!action && request.method === "GET") {
        return stub.fetch("https://room.internal/state");
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class DraftRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") return this.init(request);
    if (url.pathname === "/state" && request.method === "GET") return this.stateResponse();
    if (url.pathname === "/start" && request.method === "POST") return this.start(request);
    if (url.pathname === "/ws") return this.handleWebSocket(request);
    return json({ error: "Not found." }, { status: 404 });
  }

  private async init(request: Request) {
    const existing = await this.ctx.storage.get<PersistedRoomState>("room");
    if (existing) return json({ error: "Room already exists." }, { status: 409 });

    const input = await request.json<{
      roomCode: string;
      title: string;
      entrants: Entrant[];
      seed: string;
      seedCommitment: string;
      hostTokenHash: string;
    }>();
    const plan = createRacePlan(input.seed, input.entrants);
    const room: PersistedRoomState = {
      roomCode: input.roomCode,
      title: input.title,
      entrants: input.entrants,
      status: "lobby",
      seedCommitment: input.seedCommitment,
      seed: input.seed,
      hostTokenHash: input.hostTokenHash,
      createdAt: Date.now(),
      finalOrder: plan.order,
    };
    await this.ctx.storage.put("room", room);
    return json({ ok: true });
  }

  private async handleWebSocket(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade." }, { status: 426 });
    }
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (!room) return json({ error: "Room not found." }, { status: 404 });

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId")?.slice(0, 100) || crypto.randomUUID();
    const entrantId = this.validIdentity(room, url.searchParams.get("entrantId"));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clientId, entrantId } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "state", room: this.publicState(room) }));
    this.broadcastState(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let parsed: { type?: string; entrantId?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (!room) return;

    if (parsed.type === "identify") {
      const current = (ws.deserializeAttachment() || {}) as Partial<SocketAttachment>;
      const attachment: SocketAttachment = {
        clientId: current.clientId || crypto.randomUUID(),
        entrantId: this.validIdentity(room, parsed.entrantId),
      };
      ws.serializeAttachment(attachment);
      this.broadcastState(room);
    }
  }

  async webSocketClose() {
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (room) this.broadcastState(room);
  }

  async webSocketError() {
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (room) this.broadcastState(room);
  }

  async alarm() {
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (!room || room.status !== "running") return;
    room.status = "finished";
    await this.ctx.storage.put("room", room);
    this.broadcastState(room);
  }

  private validIdentity(room: PersistedRoomState, entrantId: string | null | undefined) {
    return room.entrants.some((entrant) => entrant.id === entrantId) ? entrantId! : "spectator";
  }

  private async start(request: Request) {
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (!room) return json({ error: "Room not found." }, { status: 404 });
    if (room.status !== "lobby") return json({ error: "Race has already started." }, { status: 409 });

    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!token || (await sha256(token)) !== room.hostTokenHash) {
      return json({ error: "Host authorization required." }, { status: 403 });
    }

    const plan = createRacePlan(room.seed, room.entrants);
    room.status = "running";
    room.startAt = Date.now() + 4_000;
    room.finishAt = room.startAt + plan.durationMs + 1_200;
    room.finalOrder = plan.order;
    await this.ctx.storage.put("room", room);
    await this.ctx.storage.setAlarm(room.finishAt);
    this.broadcastState(room);
    return json({ ok: true, startAt: room.startAt });
  }

  private async stateResponse() {
    const room = await this.ctx.storage.get<PersistedRoomState>("room");
    if (!room) return json({ error: "Room not found." }, { status: 404 });
    return json(this.publicState(room));
  }

  private publicState(room: PersistedRoomState): PublicRoomState {
    const sockets = this.ctx.getWebSockets();
    const connected = new Set<string>();
    let spectatorCount = 0;
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.entrantId === "spectator") spectatorCount += 1;
      else connected.add(attachment.entrantId);
    }

    return {
      roomCode: room.roomCode,
      title: room.title,
      entrants: room.entrants,
      status: room.status,
      seedCommitment: room.seedCommitment,
      ...(room.status !== "lobby" ? { seed: room.seed } : {}),
      ...(room.startAt ? { startAt: room.startAt } : {}),
      ...(room.finishAt ? { finishAt: room.finishAt } : {}),
      ...(room.status === "finished" ? { finalOrder: room.finalOrder } : {}),
      connectedEntrantIds: [...connected],
      spectatorCount,
      serverNow: Date.now(),
    };
  }

  private broadcastState(room: PersistedRoomState) {
    const payload = JSON.stringify({ type: "state", room: this.publicState(room) });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Socket cleanup is handled by the runtime.
      }
    }
  }
}
