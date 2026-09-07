/** Verify a locally built ADA production image without external networking or mounted data.
 * Usage: node scripts/container-smoke.mjs [ada-calendar:v1-local]
 * Only disposable, uniquely named test containers created here are stopped afterward.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2] || "ada-calendar:v1-local";
if (!/^ada-calendar:[a-zA-Z0-9_.-]+$/.test(image)) {
  throw new Error("Use an explicitly named local ada-calendar image tag.");
}
const docker = async (args) =>
  (
    await execute("docker", args, { timeout: 30_000, maxBuffer: 1_000_000 })
  ).stdout.trim();

// This code runs inside the container using its installed Node runtime. The container
// has --network none, so the test cannot reach live Auth, AI, or email providers.
async function probe(mode) {
  const { default: assert } = await import("node:assert/strict");
  const { existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const origin = `http://127.0.0.1:${process.env.PORT}`;
  assert.equal(
    process.versions.node.split(".")[0],
    "24",
    "Production must use Node 24",
  );
  assert.notEqual(process.getuid(), 0, "Production must not run as root");
  assert.equal(
    existsSync("/app/.env.local"),
    false,
    "Local configuration must not be copied into the image",
  );
  assert.equal(
    existsSync("/app/.data/ada-demo.json"),
    false,
    "Demo persistence must not be copied into the image",
  );
  assert.match(
    execFileSync("ffprobe", ["-version"], { encoding: "utf8" }),
    /^ffprobe version/,
  );

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Allow the bounded startup interval. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    ready,
    "Production server did not become healthy on the supplied PORT",
  );
  const health = await fetch(`${origin}/api/health`);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "ada-calendar",
  });

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.doesNotMatch(html, /Your plate, at a glance\.|SAMPLE PREVIEW/);
  if (mode === "unconfigured") {
    assert.match(html, /Connect your private workspace/);
    assert.doesNotMatch(html, /Email me a sign-in link/);
  } else {
    assert.match(html, /Email me a sign-in link/);
    assert.doesNotMatch(html, /Connect your private workspace/);
    assert.match(page.headers.get("cache-control") || "", /private/);
  }

  // A development cookie/flag never grants production workspace access.
  const state = await fetch(`${origin}/api/state`, {
    headers: { cookie: "ada-demo-actor=bryan" },
  });
  assert.equal(state.status, 401);
  assert.doesNotMatch(
    await state.text(),
    /Oil change survey|higher-ground|"items"/,
  );
  const icon = await fetch(`${origin}/icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") || "", /image\/svg/);
  const asset = html.match(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/);
  assert.ok(asset, "Expected a traced production JavaScript or CSS asset");
  assert.equal(
    (await fetch(new URL(asset[1].replaceAll("&amp;", "&"), origin))).status,
    200,
  );
  console.log(
    JSON.stringify({
      mode,
      passed: true,
      node: process.version,
      nonRoot: true,
      health: 200,
      privateState: 401,
      assets: 200,
      network: "none",
    }),
  );
}

const imageId = await docker([
  "image",
  "inspect",
  image,
  "--format",
  "{{.Id}}",
]);
console.log(`Checking local production image ${imageId}`);
for (const mode of ["unconfigured", "runtime-configured"]) {
  const name = `ada-calendar-smoke-${randomUUID()}`;
  let started = false;
  try {
    const args = [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--env",
      "PORT=4321",
      "--env",
      "APP_URL=http://127.0.0.1:4321",
      "--env",
      "ADA_DEMO_MODE=true",
      "--env",
      "EMAIL_MODE=capture",
    ];
    if (mode === "runtime-configured")
      args.push(
        "--env",
        "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9",
        "--env",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=fixture-public-key",
      );
    await docker([...args, image]);
    started = true;
    console.log(
      await docker([
        "exec",
        name,
        "node",
        "--input-type=module",
        "-e",
        `await (${probe.toString()})(${JSON.stringify(mode)});`,
      ]),
    );
  } finally {
    if (started) await docker(["stop", "--time", "10", name]);
  }
}
console.log(
  "Production container checks passed; both temporary test containers were removed.",
);
