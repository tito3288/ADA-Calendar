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
const monthExpression = new RegExp(
  `\\b(?:(?:the\\s+)?rest\\s+of\\s+(?:the\\s+)?)?${referencePattern}` +
    `(?:\\s+\\d{4}\\b)?(?:\\s+(?:and|through|to)\\s+${referencePattern}(?:\\s+\\d{4}\\b)?)?\\b`,
  "g",
);
const monthReference = new RegExp(
  `\\b(${referencePattern})(?:\\s+(\\d{4})\\b)?`,
  "g",
);

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
  const expressions = [...input.matchAll(monthExpression)];
  if (!references.length || references.length > 2 || expressions.length !== 1)
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
  if (/^(?:and|or|through|to|until|except|excluding)\b/.test(after))
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
    if (relative.every(Boolean)) {
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
      const lastMonth = months.indexOf(references.at(-1)![1]) + 1;
      const firstExplicitYear = references[0][2]
        ? Number(references[0][2])
        : undefined;
      const lastExplicitYear = references.at(-1)![2]
        ? Number(references.at(-1)![2])
        : undefined;
      const rollover =
        references.length === 2 && lastMonth < firstMonth ? 1 : 0;
      const firstYear =
        firstExplicitYear ??
        (lastExplicitYear !== undefined
          ? lastExplicitYear - rollover
          : current.year);
      const lastYear = lastExplicitYear ?? firstYear + rollover;
      if (firstYear < 1 || lastYear < 1 || firstYear > 9999 || lastYear > 9999)
        return null;
      first = Temporal.PlainDate.from(
        { year: firstYear, month: firstMonth, day: 1 },
        { overflow: "reject" },
      );
      last = Temporal.PlainDate.from(
        { year: lastYear, month: lastMonth, day: 1 },
        { overflow: "reject" },
      );
    }
    if (first.year > 9999 || last.year > 9999) return null;
    if (references.length === 2 && !first.add({ months: 1 }).equals(last))
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
