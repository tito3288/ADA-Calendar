/** Recognize a request to place hours, not an edit to the project's estimate. */
export function asksToFindTime(source: string, existing = false): boolean {
  const text = source.replace(/[’‘]/g, "'")
    .replace(/\b(?:don't|do not|never)\s+(?:move|reschedule|change|replace|touch)\b[^,.!?;\n]*/gi, "");
  if (/\b(?:don't|do not|never)\s+(?:find|fit|add|book|schedule|reserve)\b|\b(?:maybe|might|what if|should i|could we)\b|(?:^|\n)\s*>|\b(?:said|wrote|quoted|forwarded)\b/i.test(text)) return false;
  if (/\b(?:replace|remove|clear|move|reschedule)\b|\b(?:increase|change|update|add to)\b[^.!?\n]{0,40}\b(?:estimate|total effort|remaining effort)\b/i.test(text)) return false;
  const find = /\b(?:find|pick|choose)\s+(?:(?:me|us|a|an|some|the|available|open|best)\s+)*(?:time|times|space|slots?)\b|\bfit\b[^.!?\n]{0,65}\b(?:hours?|minutes?|work|task|project|session)\b|\b(?:hours?|minutes?|work|task|session)\b[^.!?\n]{0,45}\b(?:where(?:ver)? (?:it|they) fits?|find (?:a )?time)\b/i.test(text);
  const book = existing && /\b(?:add|book|schedule|reserve)\b[^.!?\n]{0,100}\b(?:hours?|hrs?|minutes?|mins?)\b/i.test(text)
    && !/\b(?:estimate|total effort|remaining effort)\b/i.test(text);
  return find || book;
}

const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: .5 };

/** Extract the booking amount from user evidence, never from model estimates. */
export function statedFitMinutes(source: string): { minutes?: number; error?: string } {
  const text = source.replace(/\b(one|two|three|four|five|six|seven) and a half\s+(hours?|hrs?)\b/gi, (_, value: string, unit: string) => `${words[value.toLowerCase()] + .5} ${unit}`)
    .replace(/\b(?:an?|one) hour and a half\b/gi, "1.5 hours");
  if (/\b\d+(?:\.\d+)?\s*(?:[-–—]|to|or)\s*\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/i.test(text))
    return { error: "How many hours should I find time for? Give one amount, such as 2 hours." };
  const amounts = [...text.matchAll(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|an?|a)\s*(hours?|hrs?|minutes?|mins?)\b/gi)]
    .map(match => (words[match[1].toLowerCase()] ?? Number(match[1])) * (/^(?:hour|hr)/i.test(match[2]) ? 60 : 1));
  const unique = [...new Set(amounts)];
  if (unique.length !== 1) return { error: "How many hours should I find time for? Give the amount to book now, such as 2 hours; your project total can stay unchanged." };
  if (!Number.isInteger(unique[0]) || unique[0] < 15 || unique[0] > 100_000 || unique[0] % 15)
    return { error: "Use a booking amount in 15-minute increments, such as 30 minutes or 2 hours." };
  return { minutes: unique[0] };
}
