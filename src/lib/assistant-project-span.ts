import { Temporal } from "temporal-polyfill";

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const monthPattern = months.join("|");
const referencePattern = `(?:this\\s+month|next\\s+month|${monthPattern})`;
const datedReferencePattern = `${referencePattern}(?:\\s+\\d{4}\\b)?`;
const restPattern = `(?:(?:the\\s+)?rest\\s+of\\s+(?:the\\s+)?)?`;
const yearEndPattern = `(?:(?:the\\s+)?end\\s+of\\s+(?:(?:the|this)\\s+)?year|year[- ]end)`;
const yearEndExpression = new RegExp(
  `\\b(?:${restPattern}${datedReferencePattern}\\s+(?:and\\s+)?(?:through|to|until)\\s+${yearEndPattern}|(?:through|to|until)\\s+${yearEndPattern})\\b`,
  "g",
);
const monthExpression = new RegExp(
  `\\b${restPattern}${datedReferencePattern}` +
    `(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+(?:and|through|to|until)\\s+)${datedReferencePattern}){0,11}\\b`,
  "g",
);
const monthReference = new RegExp(
  `\\b(${referencePattern})(?:\\s+(\\d{4})\\b)?`,
  "g",
);

function continuesWithProse(text: string): boolean {
  return /^and\s+(?:(?:as|when|while|once|if|after|before)\s+)?(?:i|we|you|they|he|she|it|the\s+client|keep|leave|await|waiting|awaiting|wait|add|update|show|reserve|do|don't|will)\b/.test(
    text,
  );
}

/**
 * Recognizes a small set of whole-month display-span expressions, not work dates.
 * Nothing in this helper reserves capacity, interprets effort, or authorizes a change.
 * `today` must already be the workspace-local date; the server clock is never used.
 */
export function projectMonthSpan(
  text: string,
  today: string,
): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  let current: Temporal.PlainDate;
  try {
    current = Temporal.PlainDate.from(today);
    if (current.year < 1 || current.toString() !== today) return null;
  } catch {
    return null;
  }

  const input = text.toLowerCase().replace(/\s+/g, " ").trim();
  // Explicit dates belong to the main date compiler, even if a month is also named.
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(input)) return null;
  if (/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(input)) return null;

  const references = [...input.matchAll(monthReference)];
  const yearEnds = [...input.matchAll(yearEndExpression)];
  const expressions = yearEnds.length
    ? yearEnds
    : [...input.matchAll(monthExpression)];
  if (
    (!references.length && !yearEnds.length) ||
    references.length > 12 ||
    expressions.length !== 1
  )
    return null;
  const expression = expressions[0];
  const expressionReferences = [...expression[0].matchAll(monthReference)];
  if (expressionReferences.length !== references.length) return null;

  const before = input.slice(0, expression.index).trimEnd();
  const after = input
    .slice(expression.index! + expression[0].length)
    .trimStart();
  // Reject partial endpoints, stray range connectors, and directly negated spans.
  if (
    /\b(?:early|mid|middle|late|start|beginning|end|half|quarter|first|last)(?:[- ]+(?:of|the))*[- ]*$/.test(
      before,
    )
  )
    return null;
  if (
    /\b(?:and|or|through|to|until|between|not|except|excluding|instead of|rather than)\s*$/.test(
      before,
    )
  )
    return null;
  if (
    /\b(?:not|never|don't|do not|instead of|rather than)(?:\s+(?:for|in|during|use|show|span|cover)){0,2}\s*$/.test(
      before,
    )
  )
    return null;
  if (
    /^(?:and|or|through|to|until|except|excluding)\b/.test(after) &&
    !continuesWithProse(after)
  )
    return null;
  if (/^(?:early|mid|middle|late|first|last)\b/.test(after)) return null;
  if (
    /^(?:[-–—/]\s*\w|\d)/.test(after) ||
    /\d(?:st|nd|rd|th)?(?:\s+of)?\s*$/.test(before)
  )
    return null;
  if (
    new RegExp(
      `\\b(?:early|mid|middle|late|start|beginning|end|half|quarter)(?:[- ]+(?:of|the))*[- ]+(?:${referencePattern})\\b`,
    ).test(input)
  )
    return null;
  if (
    /\b(?:early|mid|late)[- ]month\b|\b(?:first|second|latter|last)\s+half\b/.test(
      input,
    )
  )
    return null;
  if (
    new RegExp(
      `\\b(?:${referencePattern})\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b`,
    ).test(input)
  )
    return null;
  // Do not borrow a year from another phrase, or ignore a conflicting year.
  if (
    (input.match(/\b\d{4}\b/g) ?? []).length !==
    references.filter((ref) => ref[2]).length
  )
    return null;

  const rest = /^(?:the )?rest of\b/.test(expression[0]);
  const relative = references.map((ref) =>
    /^(?:this|next) month$/.test(ref[1]),
  );
  if (relative.some(Boolean) && !relative.every(Boolean)) return null;

  let first: Temporal.PlainDate;
  let last: Temporal.PlainDate;
  try {
    if (yearEnds.length) {
      // A year-end phrase always means the current workspace year. It cannot
      // silently combine another month expression or a conflicting explicit year.
      if (references.length > 1) return null;
      const ref = references[0];
      if (ref?.[2] && Number(ref[2]) !== current.year) return null;
      first = !ref
        ? current
        : ref[1] === "this month"
          ? current.with({ day: 1 })
          : ref[1] === "next month"
            ? current.with({ day: 1 }).add({ months: 1 })
            : Temporal.PlainDate.from({
                year: current.year,
                month: months.indexOf(ref[1]) + 1,
                day: 1,
              });
      if (first.year !== current.year) return null;
      last = current.with({ month: 12, day: 1 });
    } else if (relative.every(Boolean)) {
      if (references.length > 2) return null;
      if (references.some((ref) => ref[2])) return null;
      const month = current.with({ day: 1 });
      first =
        references[0][1] === "next month" ? month.add({ months: 1 }) : month;
      last =
        references.at(-1)![1] === "next month"
          ? month.add({ months: 1 })
          : month;
    } else {
      // A lone unqualified name may be a client or person, not a date instruction.
      if (
        references.length === 1 &&
        !rest &&
        !references[0][2] &&
        !/\b(?:for|in|during|throughout|spans|from|over)\s*$/.test(before) &&
        before !== ""
      )
        return null;
      const firstMonth = months.indexOf(references[0][1]) + 1;
      const isRange = /\b(?:through|to|until)\b/.test(expression[0]);
      if (isRange && references.length !== 2) return null;
      // A backwards range is ambiguous without both years, except the familiar
      // December–January rollover already supported by the calendar.
      if (
        isRange &&
        months.indexOf(references[1][1]) < firstMonth - 1 &&
        !(firstMonth === 12 && references[1][1] === "january") &&
        !references.every((ref) => ref[2])
      )
        return null;
      const offsets = [0];
      for (let index = 1; index < references.length; index++) {
        const previousMonth = months.indexOf(references[index - 1][1]) + 1;
        const nextMonth = months.indexOf(references[index][1]) + 1;
        const difference = (nextMonth - previousMonth + 12) % 12;
        if (!difference || (!isRange && difference !== 1)) return null;
        offsets.push(offsets[index - 1] + difference);
      }
      // Twelve months inclusive is the maximum display range, including rollover.
      if (offsets.at(-1)! > 11) return null;
      const baseYears = references.flatMap((ref, index) =>
        ref[2]
          ? [
              Number(ref[2]) -
                Math.floor((firstMonth - 1 + offsets[index]) / 12),
            ]
          : [],
      );
      if (new Set(baseYears).size > 1) return null;
      const firstYear = baseYears[0] ?? current.year;
      if (firstYear < 1 || firstYear > 9999) return null;
      first = Temporal.PlainDate.from(
        { year: firstYear, month: firstMonth, day: 1 },
        { overflow: "reject" },
      );
      last = first.add({ months: offsets.at(-1)! });
    }
    if (first.year > 9999 || last.year > 9999) return null;
    if (
      !yearEnds.length &&
      relative.every(Boolean) &&
      references.length === 2 &&
      !first.add({ months: 1 }).equals(last)
    )
      return null;
    const end = last.with({ day: last.daysInMonth });
    if (
      rest &&
      Temporal.PlainDate.compare(
        current,
        first.with({ day: first.daysInMonth }),
      ) > 0
    )
      return null;
    const start =
      rest && current.year === first.year && current.month === first.month
        ? current
        : first;
    return { start: start.toString(), end: end.toString() };
  } catch {
    return null;
  }
}

type ProjectDateSpanResult = {
  span?: { start: string; end: string };
  error?: string;
};

type SpanEndpoint = {
  fixed?: Temporal.PlainDate;
  year?: number;
  month: number;
  day?: number;
  boundary?: "start" | "end";
  wholeMonth?: boolean;
};

const isoDayPattern = "\\d{4}-\\d{2}-\\d{2}";
const ordinalDayPattern = "\\d{1,2}(?:st|nd|rd|th)?";
const namedDayPattern =
  `(?:${monthPattern})(?:\\s+(?:the\\s+)?${ordinalDayPattern})?(?:,?\\s+\\d{4})?` +
  `|(?:the\\s+)?${ordinalDayPattern}\\s+(?:of\\s+)?(?:${monthPattern})(?:,?\\s+\\d{4})?`;
const relativeDayPattern = `(?:today|now|tomorrow)(?:[ ,]+\\(?${isoDayPattern}\\)?)?`;
const endpointPattern =
  `(?:${relativeDayPattern}|${isoDayPattern}|${yearEndPattern}|` +
  `(?:(?:the\\s+)?(?:start|beginning|end)\\s+of\\s+(?:the\\s+)?)?` +
  `(?:this\\s+month|next\\s+month|${namedDayPattern}))`;
const rangeExpression = new RegExp(
  `\\b(${endpointPattern})\\s+(?:through|thru|to|until|–|—)\\s+(${endpointPattern})(?![\\w-])`,
  "g",
);
const namedEndpoint = new RegExp(
  `^(${monthPattern})(?:\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?$`,
);
const dayFirstEndpoint = new RegExp(
  `^(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})(?:,?\\s+(\\d{4}))?$`,
);
const dateEvidence = new RegExp(
  `\\b(?:${referencePattern}|today|now|tomorrow|year[- ]end)\\b|\\b\\d{4,}\\b|\\b\\d{1,2}[/-]\\d{1,2}\\b`,
);
const spanError =
  "I couldn't determine one valid project timeline from those dates. Please state the start and end dates, including years if the range crosses a year.";
const negatedSpanPrefix =
  /\b(?:not|never|don't|do not|rather than|instead of|except|excluding)(?:\s+(?:of|the|a|for|in|during|want|use|show|set|display|span|cover|it|this|that|from|to|be|have|project|timeline|date|dates|range|run|go)){0,12}\s*$/;
const partialMonth =
  /\b(?:early|mid|middle|late)[- ]month\b|\b(?:early|mid|middle|late)\s+(?:of\s+)?(?:the\s+)?month\b|\b(?:first|second|latter|last)\s+half\b/;

function strictDay(text: string): Temporal.PlainDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  try {
    const date = Temporal.PlainDate.from(text, { overflow: "reject" });
    return date.year >= 1 && date.toString() === text ? date : null;
  } catch {
    return null;
  }
}

function parseSpanEndpoint(
  text: string,
  current: Temporal.PlainDate,
  side: "start" | "end",
): SpanEndpoint | null {
  const relative =
    /^(today|now|tomorrow)(?:[ ,]+\(?(\d{4}-\d{2}-\d{2})\)?)?$/.exec(text);
  if (relative) {
    const fixed =
      relative[1] === "tomorrow" ? current.add({ days: 1 }) : current;
    if (relative[2] && !strictDay(relative[2])?.equals(fixed)) return null;
    return { fixed, month: fixed.month };
  }
  const iso = strictDay(text);
  if (iso) return { fixed: iso, month: iso.month };
  if (new RegExp(`^${yearEndPattern}$`).test(text)) {
    const fixed = current.with({ month: 12, day: 31 });
    return { fixed, month: fixed.month };
  }
  const edge = /^(?:the )?(start|beginning|end) of (?:the )?/.exec(text);
  const boundary = edge ? (edge[1] === "end" ? "end" : "start") : undefined;
  const value = edge ? text.slice(edge[0].length) : text;
  if (/^(?:this|next) month$/.test(value)) {
    const month = current
      .with({ day: 1 })
      .add({ months: value === "next month" ? 1 : 0 });
    const fixed =
      (boundary ?? side) === "end"
        ? month.with({ day: month.daysInMonth })
        : month;
    return { fixed, month: fixed.month, wholeMonth: !boundary };
  }
  const named = namedEndpoint.exec(value);
  const dayFirst = named ? null : dayFirstEndpoint.exec(value);
  if (!named && !dayFirst) return null;
  const month = months.indexOf(named ? named[1] : dayFirst![2]) + 1;
  const dayText = named ? named[2] : dayFirst![1];
  const yearText = named ? named[3] : dayFirst![3];
  return {
    month,
    day: dayText ? Number(dayText) : undefined,
    year: yearText ? Number(yearText) : undefined,
    boundary: boundary ?? (dayText ? undefined : side),
    wholeMonth: !boundary && !dayText,
  };
}

function endpointDate(
  endpoint: SpanEndpoint,
  year: number,
): Temporal.PlainDate {
  if (endpoint.fixed) return endpoint.fixed;
  const month = Temporal.PlainDate.from(
    { year, month: endpoint.month, day: 1 },
    { overflow: "reject" },
  );
  const day =
    endpoint.boundary === "end"
      ? month.daysInMonth
      : endpoint.boundary === "start"
        ? 1
        : endpoint.day;
  if (!day || (endpoint.boundary && endpoint.day && endpoint.day !== day))
    throw new Error("Conflicting month boundary");
  return month.with({ day }, { overflow: "reject" });
}

/**
 * Compiles a single, already-scoped project display-span instruction. The caller
 * must select the current instruction/clarification, not concatenate documents,
 * invoice dates, old replies, work-session dates, or deadlines as span evidence.
 * The result supplies display dates only; it never authorizes work or a mutation.
 * A recognized but invalid range returns an error so callers cannot fall back to
 * a looser date extractor. An isolated date is left to the caller's date handling.
 */
export function projectDateSpan(
  text: string,
  today: string,
): ProjectDateSpanResult {
  const current = strictDay(today);
  if (!current)
    return {
      error:
        "The workspace date is invalid; please refresh before setting the project timeline.",
    };
  const input = text.toLowerCase().replace(/\s+/g, " ").trim();
  const monthSpan = projectMonthSpan(input, today);
  if (monthSpan) {
    const expression =
      [...input.matchAll(yearEndExpression)][0] ??
      [...input.matchAll(monthExpression)][0];
    if (
      negatedSpanPrefix.test(input.slice(0, expression.index).trimEnd()) ||
      partialMonth.test(input)
    )
      return { error: spanError };
    return { span: monthSpan };
  }

  const expressions = [...input.matchAll(rangeExpression)];
  if (!expressions.length) {
    // A month by itself can also be a person's name. Only recognizable range or
    // partial-date language makes a failed parse a blocking span clarification.
    const hasRange = /\b(?:through|thru|to|until|between|or|and)\b/.test(input);
    const hasPartial =
      /\b(?:early|mid|middle|late|half|quarter|start|beginning|end|rest)\b/.test(
        input,
      );
    return dateEvidence.test(input) && (hasRange || hasPartial)
      ? { error: spanError }
      : {};
  }
  if (expressions.length !== 1) return { error: spanError };
  const expression = expressions[0];
  const before = input.slice(0, expression.index).trimEnd();
  const after = input
    .slice(expression.index! + expression[0].length)
    .trimStart();
  if (
    partialMonth.test(input) ||
    /\b(?:early|mid|middle|late)[- ]/.test(input)
  ) {
    return {
      error:
        "Partial-month wording needs an exact date for the project timeline. Please specify the intended start and end dates.",
    };
  }
  if (
    dateEvidence.test(`${before} ${after}`) ||
    negatedSpanPrefix.test(before) ||
    /\b(?:early|mid|middle|late|half|quarter|first|last|not|never|don't|do not|rather than|instead of|except|excluding)(?:[- ]+(?:of|the|for|in|during|want|use|show|set|display|span|cover|it|this|from)){0,5}[- ]*$/.test(
      before,
    ) ||
    /\b(?:or|and|through|thru|to|until|between)\s*$/.test(before) ||
    (/^[,;: ]*(?:and|or|through|thru|to|until|except|excluding)\b/.test(
      after,
    ) &&
      !continuesWithProse(after.replace(/^[,;: ]+/, ""))) ||
    /^(?:[-–—/]\s*\w|\d|early\b|mid\b|middle\b|late\b|first\b|last\b)/.test(
      after,
    ) ||
    /\b(?:end|ending|ends|until|through|to)\s+(?:on\s+)?(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b/.test(
      after,
    )
  )
    return { error: spanError };

  try {
    const start = parseSpanEndpoint(expression[1], current, "start");
    const end = parseSpanEndpoint(expression[2], current, "end");
    if (
      (!start && /^(?:today|now|tomorrow)[ ,]+\(?\d/.test(expression[1])) ||
      (!end && /^(?:today|now|tomorrow)[ ,]+\(?\d/.test(expression[2]))
    ) {
      return {
        error:
          "The explicit date beside today, now, or tomorrow does not match the workspace date. Please clarify which date to use for the project timeline.",
      };
    }
    if (!start || !end || (start.wholeMonth && end.wholeMonth))
      return { error: spanError };
    // Years belong to the endpoints themselves. A single explicit endpoint year
    // anchors the pair, and a decreasing month crosses into the following year.
    const rollover = end.month < start.month ? 1 : 0;
    if (
      rollover &&
      !start.fixed &&
      start.year === undefined &&
      !(start.month === 12 && end.month === 1)
    )
      return { error: spanError };
    const startYear =
      start.fixed?.year ??
      start.year ??
      ((end.fixed?.year ?? end.year) !== undefined
        ? (end.fixed?.year ?? end.year)! - rollover
        : current.year);
    const endYear = end.fixed?.year ?? end.year ?? startYear + rollover;
    const first = endpointDate(start, startYear);
    const last = endpointDate(end, endYear);
    if (
      first.year < 1 ||
      last.year > 9999 ||
      Temporal.PlainDate.compare(first, last) > 0 ||
      Temporal.PlainDate.compare(last, first.add({ years: 1 })) >= 0
    )
      return { error: spanError };
    return { span: { start: first.toString(), end: last.toString() } };
  } catch {
    return { error: spanError };
  }
}
