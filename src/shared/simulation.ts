import type { Entrant, RacePlan, RacerPlan } from "./types";

const EVENT_LABELS = [
  "BREAKAWAY!",
  "POST!",
  "DANGLES!",
  "LOST AN EDGE",
  "TOE DRAG!",
  "HUGE SAVE!",
  "ODD-MAN RUSH!",
  "BLOCKED SHOT!",
  "TOP SHELF!",
  "ZAMBONI DELAY?!",
];

function xmur3(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number) {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function seededRandom(seed: string) {
  const seedFn = xmur3(seed);
  return sfc32(seedFn(), seedFn(), seedFn(), seedFn());
}

function buildRacer(seed: string, entrant: Entrant, entrantIndex: number): RacerPlan {
  const random = seededRandom(`${seed}:${entrant.id}:${entrantIndex}`);
  const finishMs = Math.round(29_000 + random() * 13_500 + entrantIndex * 0.013);
  const stepMs = 1_000;
  const stepCount = Math.ceil(finishMs / stepMs);
  const weights: number[] = [];

  for (let i = 0; i < stepCount; i += 1) {
    const roll = random();
    let weight = 0.55 + random() * 1.15;
    if (roll < 0.08) weight *= 0.16;
    if (roll > 0.91) weight *= 2.2;
    weights.push(weight);
  }

  const total = weights.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  const keyframes = [{ atMs: 0, progress: 0 }];

  for (let i = 0; i < weights.length; i += 1) {
    cumulative += weights[i];
    keyframes.push({
      atMs: Math.min((i + 1) * stepMs, finishMs),
      progress: Math.min(cumulative / total, 1),
    });
  }

  keyframes[keyframes.length - 1] = { atMs: finishMs, progress: 1 };

  const events = [];
  const eventCount = 2 + Math.floor(random() * 3);
  for (let i = 0; i < eventCount; i += 1) {
    const atMs = Math.round(4_000 + random() * Math.max(4_000, finishMs - 8_000));
    events.push({
      atMs,
      durationMs: 1_100 + Math.round(random() * 900),
      label: EVENT_LABELS[Math.floor(random() * EVENT_LABELS.length)],
    });
  }
  events.sort((a, b) => a.atMs - b.atMs);

  return { entrantId: entrant.id, finishMs, keyframes, events };
}

export function createRacePlan(seed: string, entrants: Entrant[]): RacePlan {
  const racers = entrants.map((entrant, index) => buildRacer(seed, entrant, index));
  const order = [...racers]
    .sort((a, b) => a.finishMs - b.finishMs || a.entrantId.localeCompare(b.entrantId))
    .map((racer) => racer.entrantId);
  const durationMs = Math.max(...racers.map((racer) => racer.finishMs), 0);
  return { racers, order, durationMs };
}

export function progressAt(racer: RacerPlan, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= racer.finishMs) return 1;

  for (let i = 1; i < racer.keyframes.length; i += 1) {
    const next = racer.keyframes[i];
    if (elapsedMs <= next.atMs) {
      const previous = racer.keyframes[i - 1];
      const segment = next.atMs - previous.atMs || 1;
      const local = (elapsedMs - previous.atMs) / segment;
      const eased = local * local * (3 - 2 * local);
      return previous.progress + (next.progress - previous.progress) * eased;
    }
  }

  return 1;
}

export function activeEventAt(racer: RacerPlan, elapsedMs: number): string | undefined {
  return racer.events.find(
    (event) => elapsedMs >= event.atMs && elapsedMs <= event.atMs + event.durationMs,
  )?.label;
}
