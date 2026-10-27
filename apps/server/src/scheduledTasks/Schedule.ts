import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function normalizeCronExpression(expression: string): string {
  return expression.trim().split(/\s+/).join(" ");
}

function parseCron(expression: string, zone?: DateTime.TimeZone): Cron.Cron | null {
  // A sixth field would be read as seconds; saved schedules are minute-based.
  if (expression.trim().split(/\s+/).length !== 5) return null;
  const parsed = Cron.parse(expression, zone);
  return Result.isSuccess(parsed) ? parsed.success : null;
}

function nextCronRunAt(expression: string, from: DateTime.DateTime): DateTime.DateTime | null {
  // Without a named zone, effect/Cron searches at a fixed offset and drifts across DST.
  const zone = DateTime.isZoned(from) ? from.zone : DateTime.zoneMakeNamedUnsafe("UTC");
  const cron = parseCron(expression, zone);
  if (cron === null) return null;
  try {
    const next = DateTime.makeZonedUnsafe(Cron.next(cron, from), { timeZone: zone });
    return DateTime.toEpochMillis(next) > DateTime.toEpochMillis(from) ? next : null;
  } catch {
    // effect/Cron throws when no date matches, such as February 30.
    return null;
  }
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }
  if (schedule.type === "cron") return nextCronRunAt(schedule.expression, from);

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "cron") {
    if (b.type !== "cron") return false;
    const aCron = parseCron(a.expression);
    const bCron = parseCron(b.expression);
    return aCron !== null && bCron !== null
      ? Cron.Equivalence(aCron, bCron)
      : normalizeCronExpression(a.expression) === normalizeCronExpression(b.expression);
  }
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

const MISSED_CALENDAR_RUN_GRACE_MS = 10 * MINUTE_MS;

export function isMissedCalendarRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time" && schedule.type !== "cron") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_CALENDAR_RUN_GRACE_MS;
}
