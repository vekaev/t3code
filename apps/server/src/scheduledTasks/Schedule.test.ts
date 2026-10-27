import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isMissedCalendarRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });

  it("finds the next cron occurrence in the given zone", () => {
    const from = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 3, hour: 10, minute: 0, second: 0, millisecond: 0 },
      { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
    );
    const weekdays = nextScheduledRunAt({ type: "cron", expression: "0 9 * * MON-FRI" }, from);
    expect(weekdays ? DateTime.formatIso(DateTime.toUtc(weekdays)) : null).toBe(
      "2026-07-06T16:00:00.000Z",
    );
    const hourly = nextScheduledRunAt({ type: "cron", expression: "17 0,4,8-20 * * *" }, from);
    const parts = hourly ? DateTime.toParts(hourly) : null;
    expect(parts?.day).toBe(3);
    expect(parts?.hour).toBe(10);
    expect(parts?.minute).toBe(17);
  });

  it.each(["0 0 9 * * *", "0 9 L * *", "0 0 30 2 *"])(
    "has no next run for cron %s",
    (expression) => {
      const from = DateTime.makeZonedUnsafe(
        { year: 2026, month: 7, day: 3, hour: 10, minute: 0, second: 0, millisecond: 0 },
        { timeZone: "UTC", adjustForTimeZone: true },
      );
      expect(nextScheduledRunAt({ type: "cron", expression }, from)).toBeNull();
    },
  );

  it("compares cron schedules by the times they run", () => {
    expect(
      isSameSchedule(
        { type: "cron", expression: "0 9 * * MON-FRI" },
        { type: "cron", expression: "0  9 * * 1-5" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "cron", expression: "0 9 * * MON-FRI" },
        { type: "cron", expression: "0 10 * * MON-FRI" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "cron", expression: "0 9 * * *" },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });

  it("skips calendar runs missed by more than the grace period", () => {
    const dueAt = DateTime.makeUnsafe("2026-07-03T09:00:00.000Z");
    const late = DateTime.add(dueAt, { minutes: 11 });
    const cron = { type: "cron", expression: "0 9 * * *" } as const;
    expect(isMissedCalendarRun(cron, dueAt, late)).toBe(true);
    expect(isMissedCalendarRun(cron, dueAt, DateTime.add(dueAt, { minutes: 5 }))).toBe(false);
    expect(isMissedCalendarRun({ type: "interval", everyMs: 60_000 }, dueAt, late)).toBe(false);
  });
});
