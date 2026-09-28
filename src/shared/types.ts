export type RoomStatus = "lobby" | "running" | "finished";

export interface Entrant {
  id: string;
  name: string;
}

export interface PublicRoomState {
  roomCode: string;
  title: string;
  entrants: Entrant[];
  status: RoomStatus;
  seedCommitment: string;
  seed?: string;
  startAt?: number;
  finishAt?: number;
  finalOrder?: string[];
  connectedEntrantIds: string[];
  spectatorCount: number;
  serverNow: number;
}

export interface PersistedRoomState {
  roomCode: string;
  title: string;
  entrants: Entrant[];
  status: RoomStatus;
  seedCommitment: string;
  seed: string;
  hostTokenHash: string;
  createdAt: number;
  startAt?: number;
  finishAt?: number;
  finalOrder: string[];
}

export interface RaceEvent {
  atMs: number;
  durationMs: number;
  label: string;
}

export interface RaceKeyframe {
  atMs: number;
  progress: number;
}

export interface RacerPlan {
  entrantId: string;
  finishMs: number;
  keyframes: RaceKeyframe[];
  events: RaceEvent[];
}

export interface RacePlan {
  racers: RacerPlan[];
  order: string[];
  durationMs: number;
}
