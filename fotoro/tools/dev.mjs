import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const children = [];
let stopping = false;
const service = process.argv.includes("--service");

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}

// Fixtures are public test data; this command never starts a production server.
console.log(
  `Fotoro ${service ? "local D1/R2 service" : "public demo"}: http://localhost:4310`,
);
if (!service) console.log("Fixture data resets when this process stops.");
for (const script of [service ? "dev:api" : "dev:fixtures", "dev:web"]) {
  const env = { ...process.env };
  if (script === "dev:web") {
    env.VITE_FOTORO_FIXTURES = service ? "0" : "1";
    env.VITE_FOTORO_API = `http://127.0.0.1:${service ? 8787 : 8790}`;
  }
  const child = spawn("pnpm", [script], {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(signal ? 1 : (code ?? 1));
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
