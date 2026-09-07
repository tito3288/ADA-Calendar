/** Run with a TypeScript runner, e.g. npx tsx scripts/evaluate-intents.ts.
 * No provider calls occur unless --live AND OPENAI_API_KEY are present.
 * Live evaluations return proposals only: no scheduler commits or emails.
 */
import { createDemoState, DEMO_MEMBERS } from "../src/lib/fixtures";
import { interpretInput } from "../src/lib/server/assistant";
import { nextContinuation } from "../src/lib/assistant-conversation";

const live = process.argv.includes("--live");
if (live && !process.env.OPENAI_API_KEY) throw new Error("Live evaluation requires OPENAI_API_KEY. No calls were made.");
const cases = [
  { text: "Add IT work for Higher Ground Tree: fix the form, 2 hours on 2026-09-08", kind: "commands", count: 1 },
  { text: "I have to tell her about the completed landings", kind: "email_draft", count: 0 },
  { text: "Maybe I could move Higher Ground Tree to next week", kind: "clarification", count: 0 },
  { text: "Add IT work for Unknown Company: fix form, 1 hour", kind: "clarification", count: 0 },
  { text: "Add IT work for Higher Ground Tree: fix form, 1 hour on 2026-09-08; Add web work for Laville: change heading, 1 hour on 2026-09-09", kind: "commands", count: 2 },
];
async function main() {
  console.log(live ? "LIVE MODEL EVALUATION — real API usage; proposals only" : "DEMO PARSER CHECK — deterministic subset, not an AI model evaluation");
  let failed = 0;
  for (const test of cases) {
    const result = await interpretInput(test.text, createDemoState("2026-09-07T12:00:00Z"), DEMO_MEMBERS[0], { demo: !live, now: new Date("2026-09-07T12:00:00Z") });
    const pass = result.kind === test.kind && result.commands.length === test.count;
    if (!pass) failed += 1;
    console.log(JSON.stringify({ pass, text: test.text, expected: test.kind, actual: result.kind, commands: result.commands.length, usage: result.usage ?? null }));
  }
  const now = new Date("2026-09-07T12:00:00Z");
  const state = createDemoState(now.toISOString());
  const text = "Add IT work for Higher Ground Tree: fix the form, on 2026-09-08";
  const first = await interpretInput(text, state, DEMO_MEMBERS[0], { demo: !live, now });
  const continuation = nextContinuation(text, first, now);
  const reply = continuation ? await interpretInput("Two hours", state, DEMO_MEMBERS[0], { demo: !live, now, continuation }) : null;
  const work = reply?.commands[0];
  const pass = first.kind === "clarification" && first.commands.length === 0 && reply?.commands.length === 1 && work?.type === "create" && work.item.clientId === "higher-ground" && work.item.estimatedMinutes === 120 && work.item.windowStart === "2026-09-08";
  if (!pass) failed += 1;
  console.log(JSON.stringify({ pass, scenario: "short clarification reply retains original client and date", initialKind: first.kind, replyKind: reply?.kind, usage: [first.usage ?? null, reply?.usage ?? null] }));
  if (failed) process.exitCode = 1;
}
void main();
