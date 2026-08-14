// Canonical, server-resolved date ranges. The whole point of this file is that
// "last_month" always means the exact same UTC instants no matter which
// conversation or which person asks - so two people asking the same question
// can never get different boundaries just because the LLM did its own date math.

const STORE_TIMEZONE = "Australia/Melbourne";

function offsetMinutesAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const match = tzName.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = match ? parseInt(match[1], 10) : 0;
  const mins = match?.[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -mins : mins);
}

function localDateToUtcIso(year, month, day, timeZone = STORE_TIMEZONE) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMin = offsetMinutesAt(guess, timeZone);
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

function todayInTimezone(timeZone = STORE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return {
    year: +parts.find((p) => p.type === "year").value,
    month: +parts.find((p) => p.type === "month").value, // 1-indexed
    day: +parts.find((p) => p.type === "day").value,
  };
}

function addDays(year, month, day, delta) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function mondayOf(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7; // Mon=1..Sun=7
  return addDays(year, month, day, -(dow - 1));
}

const PERIOD_NAMES = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "last_7_days",
  "last_30_days",
  "last_90_days",
];

export function resolvePeriod(name) {
  const { year, month, day } = todayInTimezone();
  const startOfToday = { year, month, day };
  const startOfTomorrow = addDays(year, month, day, 1);

  switch (name) {
    case "today":
      return range(startOfToday, startOfTomorrow);
    case "yesterday":
      return range(addDays(year, month, day, -1), startOfToday);
    case "this_week": {
      const mon = mondayOf(year, month, day);
      return range(mon, startOfTomorrow);
    }
    case "last_week": {
      const thisMon = mondayOf(year, month, day);
      const lastMon = addDays(thisMon.year, thisMon.month, thisMon.day, -7);
      return range(lastMon, thisMon);
    }
    case "this_month":
      return range({ year, month, day: 1 }, startOfTomorrow);
    case "last_month": {
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      return range({ year: prevYear, month: prevMonth, day: 1 }, { year, month, day: 1 });
    }
    case "this_quarter": {
      const qStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
      return range({ year, month: qStartMonth, day: 1 }, startOfTomorrow);
    }
    case "last_quarter": {
      const qStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
      const prevQStartMonth = qStartMonth === 1 ? 10 : qStartMonth - 3;
      const prevQYear = qStartMonth === 1 ? year - 1 : year;
      return range({ year: prevQYear, month: prevQStartMonth, day: 1 }, { year, month: qStartMonth, day: 1 });
    }
    case "this_year":
      return range({ year, month: 1, day: 1 }, startOfTomorrow);
    case "last_year":
      return range({ year: year - 1, month: 1, day: 1 }, { year, month: 1, day: 1 });
    case "last_7_days":
      return range(addDays(year, month, day, -7), startOfTomorrow);
    case "last_30_days":
      return range(addDays(year, month, day, -30), startOfTomorrow);
    case "last_90_days":
      return range(addDays(year, month, day, -90), startOfTomorrow);
    default:
      throw new Error(`Unknown period "${name}". Valid periods: ${PERIOD_NAMES.join(", ")}`);
  }
}

function range(startParts, endParts) {
  return {
    startAt: localDateToUtcIso(startParts.year, startParts.month, startParts.day),
    endAt: localDateToUtcIso(endParts.year, endParts.month, endParts.day),
  };
}

export { PERIOD_NAMES, STORE_TIMEZONE };
