import { describe, expect, it } from "vitest";
import { interpretationEstimatedUsd, transcriptionEstimatedUsd, transcriptionReservationUsd } from "./ai-cost";

describe("standard-tier interpretation estimates", () => {
  it("uses documented short and long context rates", () => {
    expect(interpretationEstimatedUsd(1000, 1000)).toBeCloseTo(0.024);
    expect(interpretationEstimatedUsd(300_000, 1000)).toBeCloseTo(2.43);
  });
  it("rejects invalid provider usage", () => {
    expect(() => interpretationEstimatedUsd(-1, 100)).toThrow();
    expect(() => interpretationEstimatedUsd(100, Number.NaN)).toThrow();
  });
});

describe("bounded transcription budget estimates", () => {
  it("estimates verified duration instead of charging every recording fifty cents", () => {
    expect(transcriptionEstimatedUsd(60)).toBe(0.0045);
    expect(transcriptionEstimatedUsd(120)).toBe(0.009);
    expect(transcriptionEstimatedUsd(0.25)).toBe(0.000075);
  });

  it("reserves a margin above the estimate, including short recordings", () => {
    expect(transcriptionReservationUsd(1)).toBe(0.01);
    expect(transcriptionReservationUsd(120)).toBe(0.0135);
    for (const duration of [0.5, 1, 30.2, 60, 95, 120]) {
      expect(transcriptionReservationUsd(duration)).toBeGreaterThan(transcriptionEstimatedUsd(duration));
    }
  });

  it("cannot create budget estimates from missing, invalid, or oversized duration", () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120.001]) {
      expect(() => transcriptionEstimatedUsd(duration)).toThrow(/server-verified/);
      expect(() => transcriptionReservationUsd(duration)).toThrow(/server-verified/);
    }
  });
});
