import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES } from "./defaults";
import type { Actor, Category } from "./types";
import { defaultWorkPriority, newWorkItem } from "./work";

const owner: Actor = { id: "test-owner", name: "Test Owner", email: "owner@example.test", role: "owner" };

describe("new work priority defaults", () => {
  it.each<[Category, string]>([["it", "urgent"], ["web", "normal"], ["software", "normal"], ["landings", "normal"]])("defaults %s work to %s", (category, priorityId) => {
    expect(newWorkItem(owner, "2026-09-11", { category }).priorityId).toBe(priorityId);
  });

  it.each(["normal", "high", "low"])("preserves an explicit %s priority on IT work", priorityId => {
    expect(newWorkItem(owner, "2026-09-11", { category: "it", priorityId }).priorityId).toBe(priorityId);
  });

  it("keeps requester IT priority advisory and preserves explicit suggestions", () => {
    const requester: Actor = { ...owner, role: "requester" };
    expect(newWorkItem(requester, "2026-09-11", { category: "it" })).toMatchObject({ priorityId: "normal", requestedPriorityId: "urgent" });
    expect(newWorkItem(requester, "2026-09-11", { category: "it", requestedPriorityId: "low" })).toMatchObject({ priorityId: "normal", requestedPriorityId: "low" });
  });

  it("uses an available priority when Urgent was removed from workspace settings", () => {
    expect(defaultWorkPriority("it", DEFAULT_PRIORITIES.filter(priority => priority.id !== "urgent"))).toBe("normal");
    expect(defaultWorkPriority("it", [{ id: "standard", label: "Standard", rank: 2 }])).toBe("standard");
  });
});
