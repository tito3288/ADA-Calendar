import { expect, test } from "@playwright/test";
import { localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState } from "../../src/lib/types";
import { asActor, commit, exactSession, futureDate, makeItem, origin, preview, state } from "./helpers";

// Real browser → isolated demo interpretation → scheduler → captured save/undo.
// Only fictional projects in .data-e2e are created; no live providers are used.
const schedule = ({ items, sessions, blocks }: AppState) => ({ items, sessions, blocks });

test("a natural numbered order moves both bookings of one project only after confirmation", async ({ page, baseURL }, info) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  const snapshot = await state(page.request);
  expect(snapshot.mode).toBe("demo");
  const date = futureDate(snapshot, 420);
  const at = (clock: string) => localDateTime(date, clock, snapshot.settings.timeZone);
  // These shorter fictional sessions fit the demo's existing reserve setting.
  const projects = ["Fictional Cedar Studio copy", "Fictional Birch School form", "Fictional Maple Press header", "Fictional Willow Library homepage", "Fictional Juniper Workshop pages"]
    .map((title, index) => makeItem(snapshot, title, {
      clientId: "agency", windowStart: date, windowEnd: date, minimumSessionMinutes: 15,
      remainingMinutes: index < 3 ? 30 : 90, estimatedMinutes: index < 3 ? 30 : 90,
    }));
  const bookings = [
    exactSession(snapshot, projects[0], "09:00", "09:30"),
    exactSession(snapshot, projects[1], "09:30", "10:00"),
    exactSession(snapshot, projects[2], "10:00", "10:30"),
    exactSession(snapshot, projects[3], "10:30", "12:00"),
    exactSession(snapshot, projects[4], "12:30", "13:15"),
    exactSession(snapshot, projects[4], "13:15", "14:00"),
  ];
  const seedProposal = await preview(page.request, projects.map(item => ({
    type: "create" as const, item, sessions: bookings.filter(booking => booking.workItemId === item.id),
  })));
  expect(seedProposal.status, JSON.stringify(seedProposal.conflicts)).toBe("ready");
  const seeded = await commit(page.request, seedProposal);

  await page.goto("/");
  await page.getByRole("button", { name: "Open ADA helper", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ADA helper", exact: true });
  await dialog.getByLabel("Day to discuss", { exact: true }).fill(date);
  const desiredProjects = [projects[2], projects[1], projects[0], projects[4], projects[3]];
  const numberedOrder = desiredProjects.map((project, index) => `${index + 1}. ${project.title}`).join("\n");
  await dialog.getByLabel("Message ADA helper", { exact: true }).fill(
    `Perfect. Now that you see the list, here’s the order that I want them to go for this day.\n${numberedOrder}`,
  );
  await dialog.getByRole("button", { name: "Send to ADA helper", exact: true }).click();
  const review = dialog.getByRole("region", { name: "Proposed schedule order", exact: true });
  await expect(review, await dialog.innerText()).toBeVisible();
  await expect(review).toContainText("PREVIEW · NOT SAVED");
  await expect(review).toContainText(projects[4].title);
  await expect(review.locator("li").filter({ hasText: projects[4].title })).toHaveCount(2);
  expect(await state(page.request)).toEqual(seeded);
  await page.screenshot({ path: info.outputPath("numbered-project-order-preview.png") });

  await review.getByRole("button", { name: "Confirm new order", exact: true }).click();
  await expect(dialog.getByRole("log")).toContainText("Your schedule is updated");
  await expect(review).toHaveCount(0);
  const saved = await state(page.request);
  const bookingIds = new Set(bookings.map(booking => booking.id));
  expect(saved.items).toEqual(seeded.items);
  expect(saved.settings).toEqual(seeded.settings);
  expect(saved.version).toBe(seeded.version + 1);
  expect(saved.sessions.map(session => [session.id, session.workItemId, minutesBetween(session.start, session.end)]).sort())
    .toEqual(seeded.sessions.map(session => [session.id, session.workItemId, minutesBetween(session.start, session.end)]).sort());
  expect(saved.sessions.filter(session => !bookingIds.has(session.id)))
    .toEqual(seeded.sessions.filter(session => !bookingIds.has(session.id)));
  expect(saved.sessions.filter(session => bookingIds.has(session.id)).sort((a, b) => a.start.localeCompare(b.start))
    .map(session => [session.id, session.start, session.end])).toEqual([
      [bookings[2].id, at("09:00"), at("09:30")],
      [bookings[1].id, at("09:30"), at("10:00")],
      [bookings[0].id, at("10:00"), at("10:30")],
      [bookings[4].id, at("10:30"), at("11:15")],
      [bookings[5].id, at("11:15"), at("12:00")],
      [bookings[3].id, at("12:30"), at("14:00")],
    ]);

  const savedCard = dialog.getByLabel("Last ADA schedule change", { exact: true });
  await savedCard.getByRole("button", { name: "Undo last change", exact: true }).click();
  await expect(dialog.getByRole("log")).toContainText("That ADA change was undone.");
  const restored = await state(page.request);
  expect(schedule(restored)).toEqual(schedule(seeded));
  expect(restored.settings).toEqual(seeded.settings);
  expect(restored.version).toBe(saved.version + 1);
});
