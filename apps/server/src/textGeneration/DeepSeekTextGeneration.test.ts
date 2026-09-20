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
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      `  process.stdout.write(${JSON.stringify(`${version}\\n`)});`,
      "  process.exit(0);",
      "}",
      execScriptSource({
        scriptPath: mockAgentPath,
        expectedArgs: ["--profile", "acp"],
      }),
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
});
