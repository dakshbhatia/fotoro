import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import accounts from "../fixtures/accounts.json";

const cwd = fileURLToPath(new URL("../services/api", import.meta.url));
const localState = process.env.FOTORO_LOCAL_STATE ?? ".wrangler/fotoro-v1";
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function wrangler(args: string[]) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", ...args, "--persist-to", localState],
    { cwd, stdio: "inherit", shell: false },
  );
  if (result.status !== 0) throw new Error("Local D1 setup failed");
}

// Every command is explicitly --local. These are checked-in public test keys.
wrangler(["d1", "migrations", "apply", "fotoro-local", "--local"]);
const directory = await mkdtemp(join(tmpdir(), "fotoro-public-seed-"));
try {
  const statements: string[] = [];
  for (const [index, card] of accounts.accounts.entries()) {
    const secrets = accounts.testSecrets.find(
      (row) => row.accountId === card.accountId,
    )!;
    const wrapper = {
      version: 1,
      wrapperId: `00000000-0000-4000-8000-${String(40 + index).padStart(12, "0")}`,
      kind: "recovery",
      credentialId: null,
      prfSalt: null,
      wrappedBundle: secrets.encryptedBundle,
      verified: true,
    };
    statements.push(
      `INSERT OR IGNORE INTO accounts(id,card) VALUES(${quote(card.accountId)},${quote(JSON.stringify(card))});`,
    );
    statements.push(
      `INSERT OR IGNORE INTO wrappers(id,account_id,json) VALUES(${quote(wrapper.wrapperId)},${quote(card.accountId)},${quote(JSON.stringify(wrapper))});`,
    );
  }
  const path = join(directory, "public-accounts.sql");
  await writeFile(path, statements.join("\n"));
  wrangler(["d1", "execute", "fotoro-local", "--local", "--file", path]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Public test accounts seeded in local D1. Recover in the web client using a public fixture code:",
);
for (const secrets of accounts.testSecrets)
  console.log(`fotoro1.${secrets.accountId}.${secrets.recoverySecret}`);
