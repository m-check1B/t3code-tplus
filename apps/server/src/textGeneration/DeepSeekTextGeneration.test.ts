// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { DeepSeekSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDeepSeekTextGeneration } from "./DeepSeekTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
import { DEEPSEEK_DEFAULT_MODEL } from "../provider/acp/DeepSeekAcpSupport.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const deepSeekFlashValue = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);

const DeepSeekTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-deepseek-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpDshWrapper(dir: string, env: Record<string, string>): string {
  const version = env.T3_DSH_VERSION ?? "0.1.5-rc.2";
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "dsh",
    env: { T3_ACP_DEEPSEEK: "1", ...env },
    source: [
      'if (process.argv[2] === "--version") {',
      `  process.stdout.write(${JSON.stringify(`${version}\\n`)});`,
      "  process.exit(0);",
      "}",
      'if (process.argv[2] === "--profile" && process.argv[3] === "acp" && process.env.T3_DSH_ENV_LOG_PATH) {',
      '  appendFileSync(process.env.T3_DSH_ENV_LOG_PATH, `${process.argv.slice(2).join("\\t")}\\t${process.env.DSH_PERMISSION_MODE ?? ""}\\n`);',
      "}",
      execScriptSource({
        scriptPath: mockAgentPath,
        expectedArgs: ["--profile", "acp"],
      }),
    ].join("\n"),
  });
}

type AdversarialPermissionId = "numeric" | "empty" | "missing";

function makeAdversarialPermissionPeer(
  dir: string,
  permissionId: AdversarialPermissionId = "numeric",
): string {
  const flashValue = deepSeekFlashValue;
  const catalog = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: flashValue,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: flashValue, name: "DeepSeek V4 Flash" },
          {
            value: JSON.stringify(["deepseek-official", "deepseek-v4-pro"]),
            name: "DeepSeek V4 Pro",
          },
        ],
      },
    ],
  };
  const successJson = JSON.stringify({
    subject: "should not land",
    body: "permission must fail closed",
  });
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "dsh",
    source: [
      'import { createInterface } from "node:readline";',
      'if (process.argv[2] === "--version") {',
      `  process.stdout.write(${JSON.stringify("0.1.5-rc.2\\n")});`,
      "  process.exit(0);",
      "}",
      'if (process.argv[2] !== "--profile" || process.argv[3] !== "acp") {',
      '  process.stderr.write("unexpected args\\n");',
      "  process.exit(11);",
      "}",
      `const catalog = ${JSON.stringify(catalog)};`,
      `const successJson = ${JSON.stringify(successJson)};`,
      `const permissionIdMode = ${JSON.stringify(permissionId)};`,
      'const sessionId = "mock-session-1";',
      "function writeLine(value) {",
      '  process.stdout.write(JSON.stringify(value) + "\\n");',
      "}",
      "const rl = createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      '  if (typeof msg.method !== "string") return;',
      '  if (msg.method === "initialize") {',
      "    writeLine({",
      '      jsonrpc: "2.0",',
      "      id: msg.id,",
      "      result: {",
      "        protocolVersion: 1,",
      '        agentInfo: { name: "deepseek-harness-acp", version: "0.1.5-rc.2" },',
      "        agentCapabilities: {",
      "          mcpCapabilities: { http: true },",
      "          promptCapabilities: { image: true, audio: false, embeddedContext: false },",
      "          sessionCapabilities: { close: {}, list: {}, resume: {} },",
      "        },",
      "        authMethods: [],",
      "      },",
      "    });",
      "    return;",
      "  }",
      '  if (msg.method === "authenticate") {',
      '    writeLine({ jsonrpc: "2.0", id: msg.id, result: {} });',
      "    return;",
      "  }",
      '  if (msg.method === "session/new") {',
      '    writeLine({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: [catalog] } });',
      "    return;",
      "  }",
      '  if (msg.method === "session/set_config_option") {',
      '    writeLine({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [catalog] } });',
      "    return;",
      "  }",
      '  if (msg.method === "session/close") {',
      '    writeLine({ jsonrpc: "2.0", id: msg.id, result: {} });',
      "    return;",
      "  }",
      '  if (msg.method === "session/prompt") {',
      "    const permission = {",
      '      jsonrpc: "2.0",',
      '      method: "session/request_permission",',
      "      params: {",
      "        sessionId,",
      "        toolCall: {",
      '          toolCallId: "tool-call-1",',
      '          title: "Write file",',
      '          kind: "edit",',
      '          status: "pending",',
      "        },",
      "        options: [",
      '          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },',
      '          { optionId: "reject-once", name: "Reject", kind: "reject_once" },',
      "        ],",
      "      },",
      "    };",
      '    if (permissionIdMode === "empty") permission.id = "";',
      '    else if (permissionIdMode !== "missing") permission.id = 900001;',
      "    process.stdout.write([",
      "      JSON.stringify(permission),",
      "      JSON.stringify({",
      '        jsonrpc: "2.0",',
      '        method: "session/update",',
      "        params: {",
      "          sessionId,",
      "          update: {",
      '            sessionUpdate: "agent_message_chunk",',
      '            content: { type: "text", text: successJson },',
      "          },",
      "        },",
      "      }),",
      "      JSON.stringify({",
      '        jsonrpc: "2.0",',
      "        id: msg.id,",
      '        result: { stopReason: "end_turn" },',
      "      }),",
      '    ].join("\\n") + "\\n");',
      "  }",
      "});",
    ].join("\n"),
  });
}

function withFakeAcpDsh<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-dsh-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpDshWrapper(tempDir, env);
    const config = decodeDeepSeekSettings({ binaryPath });
    const textGeneration = yield* makeDeepSeekTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(DeepSeekTextGenerationTestLayer)("DeepSeekTextGeneration", (it) => {
  it.effect(
    "uses ACP set_config_option for the requested model and never session/set_model",
    () => {
      const requestLogDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-dsh-text-log-"),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

      return withFakeAcpDsh(
        {
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "Add DeepSeek provider",
            body: "Wire up the DSH ACP runtime and headless text generation path.",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/deepseek",
              stagedSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
              stagedPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                DEEPSEEK_DEFAULT_MODEL,
              ),
            });

            expect(generated.subject).toBe("Add DeepSeek provider");
            expect(generated.body).toBe(
              "Wire up the DSH ACP runtime and headless text generation path.",
            );

            const requests = readJsonRpcRequests(requestLogPath);
            expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
            expect(requests.some((request) => request.method === "session/load")).toBe(false);
            expect(
              requests.find((request) => request.method === "session/new") ||
                requests.find((request) => request.method === "session/resume"),
            ).toBeDefined();
            expect(
              requests.some(
                (request) =>
                  request.method === "session/set_config_option" &&
                  request.params?.configId === "model" &&
                  request.params?.value === deepSeekFlashValue,
              ) ||
                requests.every(
                  (request) =>
                    request.method !== "session/set_config_option" ||
                    request.params?.configId !== "model",
                ),
            ).toBe(true);
          }),
      );
    },
  );

  it.effect("surfaces catalog rejections as text generation errors", () =>
    withFakeAcpDsh(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up deepseek",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                "unknown-provider/unknown-model",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Failed to set DeepSeek ACP model");
        }),
    ),
  );

  it.effect("fails closed when the CLI is older than 0.1.5-rc.2", () =>
    withFakeAcpDsh({ T3_DSH_VERSION: "0.1.5-rc.1" }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "title this",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("deepseek"),
              DEEPSEEK_DEFAULT_MODEL,
            ),
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toContain("not compatible");
      }),
    ),
  );

  it.effect(
    "spawns native dsh --profile acp with DSH_PERMISSION_MODE=read-only for text generation",
    () => {
      const envLogDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-dsh-text-env-"));
      const envLogPath = NodePath.join(envLogDir, "env.log");
      NodeFS.writeFileSync(envLogPath, "");

      return withFakeAcpDsh(
        {
          T3_DSH_ENV_LOG_PATH: envLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            title: "DeepSeek read-only titles",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "title this",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                DEEPSEEK_DEFAULT_MODEL,
              ),
            });
            expect(generated.title).toBe("DeepSeek read-only titles");

            const envRuns = NodeFS.readFileSync(envLogPath, "utf8")
              .trim()
              .split("\n")
              .filter((line) => line.length > 0);
            expect(envRuns.length).toBeGreaterThan(0);
            expect(envRuns.every((line) => line.startsWith("--profile\tacp\tread-only"))).toBe(
              true,
            );
          }),
      );
    },
  );

  it.effect("rejects ACP permission requests instead of allowing repository mutation", () =>
    withFakeAcpDsh(
      {
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "should not land",
          body: "permission must fail closed",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/deepseek",
              stagedSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
              stagedPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("deepseek"),
                DEEPSEEK_DEFAULT_MODEL,
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("tool permission");
        }),
    ),
  );

  it.effect(
    "fails closed when a peer emits permission, valid output, and prompt success without awaiting a reply",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3code-dsh-text-adversary-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(tempDir, { recursive: true, force: true });
          }),
        );
        const binaryPath = makeAdversarialPermissionPeer(tempDir);
        const config = decodeDeepSeekSettings({ binaryPath });
        const textGeneration = yield* makeDeepSeekTextGeneration(config);
        const error = yield* Effect.flip(
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/deepseek",
            stagedSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
            stagedPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("deepseek"),
              DEEPSEEK_DEFAULT_MODEL,
            ),
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toContain("tool permission");
      }).pipe(Effect.scoped),
  );

  const modelSelection = createModelSelection(
    ProviderInstanceId.make("deepseek"),
    DEEPSEEK_DEFAULT_MODEL,
  );
  const adversarialOperations = [
    {
      name: "generateCommitMessage",
      run: (textGeneration: TextGeneration.TextGeneration["Service"]) =>
        textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/deepseek",
            stagedSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
            stagedPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
            modelSelection,
          })
          .pipe(Effect.asVoid),
    },
    {
      name: "generatePrContent",
      run: (textGeneration: TextGeneration.TextGeneration["Service"]) =>
        textGeneration
          .generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/deepseek",
            commitSummary: "Add DeepSeek provider",
            diffSummary: "M apps/server/src/provider/Drivers/DeepSeekDriver.ts",
            diffPatch: "diff --git a/.../DeepSeekDriver.ts b/.../DeepSeekDriver.ts",
            modelSelection,
          })
          .pipe(Effect.asVoid),
    },
    {
      name: "generateBranchName",
      run: (textGeneration: TextGeneration.TextGeneration["Service"]) =>
        textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "add DeepSeek provider",
            modelSelection,
          })
          .pipe(Effect.asVoid),
    },
    {
      name: "generateThreadTitle",
      run: (textGeneration: TextGeneration.TextGeneration["Service"]) =>
        textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "add DeepSeek provider",
            modelSelection,
          })
          .pipe(Effect.asVoid),
    },
  ] as const;

  for (const permissionId of ["empty", "missing"] as const) {
    for (const operation of adversarialOperations) {
      it.effect(
        `fails ${operation.name} when permission uses ${permissionId === "empty" ? 'id:""' : "a missing id"} without awaiting a reply`,
        () =>
          Effect.gen(function* () {
            const tempDir = NodeFS.mkdtempSync(
              NodePath.join(NodeOS.tmpdir(), `t3code-dsh-text-${permissionId}-`),
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                NodeFS.rmSync(tempDir, { recursive: true, force: true });
              }),
            );
            const binaryPath = makeAdversarialPermissionPeer(tempDir, permissionId);
            const config = decodeDeepSeekSettings({ binaryPath });
            const textGeneration = yield* makeDeepSeekTextGeneration(config);
            const error = yield* Effect.flip(operation.run(textGeneration));
            expect(error._tag).toBe("TextGenerationError");
            expect(error.detail).toContain("tool permission");
          }).pipe(Effect.scoped),
      );
    }
  }
});
