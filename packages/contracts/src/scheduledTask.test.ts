import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("cron schedules", () => {
  it.each(["17 0,4,8-20 * * *", "0 9 * * MON-FRI", "0 9 * * 7", "0 0 30 2 1"])(
    "accepts %s",
    (expression) => {
      expect(decodeUpsertSchedule({ type: "cron", expression })).toEqual({
        type: "cron",
        expression,
      });
    },
  );

  it.each([
    ["*/10 * * * * *", "Use five fields: minute hour day-of-month month weekday."],
    ["@daily", "Use five fields: minute hour day-of-month month weekday."],
    ["0 9 L * *", "Day of month: Expected a positive integer"],
    ["60 * * * *", "Minute: Expected a value between 0 and 59"],
    ["0 0 30 2 *", "This schedule never runs."],
    ["0 0 30 2 */2", "This schedule never runs."],
  ])("rejects %s", (expression, message) => {
    expect(() => decodeUpsertSchedule({ type: "cron", expression })).toThrow(message);
  });

  it("keeps a stored expression readable after the save rules reject it", () => {
    const stored = { type: "cron", expression: "0 0 30 2 *" };
    expect(() => decodeUpsertSchedule(stored)).toThrow();
    expect(decodeSchedule(stored)).toEqual(stored);
  });
});

describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});
