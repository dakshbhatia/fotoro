#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(root, ".dev");
const web = join(root, "web");
const env = {
    ...process.env,
    PATH:
        ["ruby/bin", "gems/bin", "flutter/bin", "cargo/bin", "go/bin"]
            .map((p) => join(root, ".tools", p))
            .join(":") +
        ":" +
        process.env.PATH,
    CARGO_HOME: join(root, ".tools/cargo"),
    RUSTUP_HOME: join(root, ".tools/rustup"),
    ...(existsSync(join(root, ".tools/gems"))
        ? {
              GEM_HOME: join(root, ".tools/gems"),
              GEM_PATH: join(root, ".tools/gems"),
          }
        : {}),
    FLUTTER_SUPPRESS_ANALYTICS: "true",
    NEXT_PUBLIC_ENTE_ENDPOINT:
        process.env.NEXT_PUBLIC_ENTE_ENDPOINT || "http://localhost:4800",
};
const run = (cmd, args, cwd = root, extra = {}) => {
    const result = spawnSync(cmd, args, {
        cwd,
        env,
        stdio: "inherit",
        ...extra,
    });
    if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}`);
};
const compose = [
    "compose",
    "-p",
    "ai-photos",
    "-f",
    join(runtime, "my-ente/compose.yaml"),
];

function setupServices() {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const config = join(runtime, "my-ente/compose.yaml");
    if (!existsSync(config))
        run("sh", [join(root, "server/quickstart.sh")], runtime, {
            input: "n\n",
            stdio: ["pipe", "inherit", "inherit"],
        });
    let yaml = readFileSync(config, "utf8");
    for (const [from, to] of [
        ["- 8080:8080 # API", "- 127.0.0.1:4800:8080 # API"],
        [
            "- 3000:3000 # Photos web app",
            "- 127.0.0.1:4390:3000 # Photos web app",
        ],
        ["# - 3001:3001 # Accounts", "- 127.0.0.1:4391:3001 # Accounts"],
        [
            "- 3002:3002 # Public albums",
            "- 127.0.0.1:4392:3002 # Public albums",
        ],
        ["- 3200:3200 # MinIO API", "- 127.0.0.1:4320:3200 # MinIO API"],
        [
            "ENTE_API_ORIGIN: http://localhost:8080",
            "ENTE_API_ORIGIN: http://localhost:4800",
        ],
        ["TCP-LISTEN:3200,fork,reuseaddr", "TCP-LISTEN:4320,fork,reuseaddr"],
    ])
        yaml = yaml.replace(from, to);
    writeFileSync(config, yaml, { mode: 0o600 });
    chmodSync(config, 0o600);
    const museum = join(runtime, "my-ente/museum.yaml");
    let settings = readFileSync(museum, "utf8")
        .replaceAll("endpoint: localhost:3200", "endpoint: localhost:4320")
        .replace(
            "accounts: http://localhost:3001",
            "accounts: http://localhost:4391",
        )
        .replace(
            "public-albums: http://localhost:3002",
            "public-albums: http://localhost:4392",
        );
    if (!settings.includes("webauthn:"))
        settings +=
            "\nwebauthn:\n    rpid: localhost\n    origins:\n        - http://localhost:4391\n        - http://localhost:4300\n";
    writeFileSync(museum, settings, { mode: 0o600 });
    chmodSync(museum, 0o600);
    run("docker", [...compose, "config", "--quiet"]);
}

try {
    switch (process.argv[2]) {
        case "doctor":
            for (const [cmd, args] of [
                ["node", ["--version"]],
                ["npm", ["--version"]],
                ["flutter", ["--version"]],
                ["rustc", ["--version"]],
                ["go", ["version"]],
                ["xcodebuild", ["-version"]],
                ["docker", ["compose", "version"]],
                ["docker", ["info", "--format", "Docker {{.ServerVersion}}"]],
            ])
                run(cmd, args);
            if (existsSync(join(root, ".tools/gems/bin/pod")))
                run("pod", ["--version"]);
            break;
        case "setup-web":
            run(
                "npx",
                ["--yes", "npm@11.12.1", "ci", "--no-audit", "--no-fund"],
                web,
            );
            run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
            run("npm", ["run", "build:prelogin-wasm"], web);
            run("npm", ["run", "build:photos-wasm"], web);
            break;
        case "services":
            setupServices();
            run("docker", [...compose, "up", "-d"]);
            break;
        case "stop":
            run("docker", [...compose, "stop"]);
            break;
        case "web":
            run(
                "npm",
                [
                    "exec",
                    "--workspace",
                    "photos",
                    "--",
                    "next",
                    "dev",
                    "--webpack",
                    "-H",
                    "127.0.0.1",
                    "-p",
                    "4300",
                ],
                web,
            );
            break;
        case "test":
            run("npm", ["run", "test", "--workspace", "photos"], web);
            break;
        case "build-web":
            run(
                "npm",
                [
                    "exec",
                    "--workspace",
                    "photos",
                    "--",
                    "next",
                    "build",
                    "--webpack",
                ],
                web,
                { env: { ...env, FOTORO_BUILD_DIR: ".next-fotoro-build" } },
            );
            break;
        case "typecheck":
            run(
                "npm",
                [
                    "exec",
                    "--workspace",
                    "photos",
                    "--",
                    "tsc",
                    "--noEmit",
                    "--project",
                    "tsconfig.json",
                ],
                web,
            );
            break;
        case "setup-mobile":
            run("rustup", ["component", "add", "rustfmt"]);
            run(
                "flutter",
                ["pub", "get", "--enforce-lockfile"],
                join(root, "mobile"),
            );
            run(
                "dart",
                ["run", "rive_native:setup", "--clean", "--platform", "ios"],
                join(root, "mobile/apps/photos"),
            );
            run("cargo", ["codegen", "frb", "photos"], join(root, "rust"));
            break;
        case "ios":
            run(
                "flutter",
                ["build", "ios", "--debug", "--no-codesign"],
                join(root, "mobile/apps/photos"),
            );
            break;
        case "setup-ios":
            run("ruby", ["--version"]);
            run("gem", [
                "install",
                "cocoapods",
                "--version",
                "1.17.0",
                "--install-dir",
                join(root, ".tools/gems"),
                "--no-document",
            ]);
            break;
        case "ios-sim":
            run(
                "flutter",
                ["build", "ios", "--simulator", "--debug"],
                join(root, "mobile/apps/photos"),
            );
            break;
        default:
            console.log(
                "Usage: node scripts/ai-photos.mjs doctor|setup-web|services|stop|web|build-web|test|typecheck|setup-mobile|setup-ios|ios|ios-sim",
            );
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
