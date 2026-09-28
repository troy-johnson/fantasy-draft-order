import { describe, expect, it } from "vitest";
import { createRacePlan, progressAt } from "./simulation";

const entrants = Array.from({ length: 10 }, (_, index) => ({
  id: `e${index + 1}`,
  name: `Manager ${index + 1}`,
}));

describe("race simulation", () => {
  it("is deterministic", () => {
    expect(createRacePlan("same-seed", entrants)).toEqual(createRacePlan("same-seed", entrants));
  });

  it("changes order with a different seed", () => {
    expect(createRacePlan("seed-a", entrants).order).not.toEqual(createRacePlan("seed-b", entrants).order);
  });

  it("finishes every racer at progress 1", () => {
    const plan = createRacePlan("finish-test", entrants);
    for (const racer of plan.racers) {
      expect(progressAt(racer, racer.finishMs)).toBe(1);
    }
  });

  it("contains every entrant exactly once in the result", () => {
    const plan = createRacePlan("order-test", entrants);
    expect(new Set(plan.order).size).toBe(entrants.length);
    expect([...plan.order].sort()).toEqual(entrants.map((entrant) => entrant.id).sort());
  });
});
