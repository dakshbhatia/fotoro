import { writeFile } from "node:fs/promises";
import { createFixtureServer } from "./fixture-server.js";
import accounts from "../fixtures/accounts.json";
const server = createFixtureServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
try {
  const page = await (
    await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/v1/changes`,
      {
        headers: { "x-fotoro-fixture-account": accounts.accounts[0].accountId },
      },
    )
  ).json();
  await writeFile("fixtures/changes-v1.json", JSON.stringify(page, null, 2));
} finally {
  await new Promise<void>((r) => server.close(() => r()));
}
