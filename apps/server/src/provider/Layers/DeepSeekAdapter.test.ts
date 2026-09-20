// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DeepSeekSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeDeepSeekAdapter } from "./DeepSeekAdapter.ts";
import { DEEPSEEK_DEFAULT_MODEL } from "../acp/DeepSeekAcpSupport.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const deepSeekProValue = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);

async function makeMockDshWrapper(extraEnv?: Record<string, string>, argvLogPath?: string) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dsh-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-dsh",
    env: { T3_ACP_DEEPSEEK: "1", ...extraEnv },
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["--profile", "acp"],
      ...(argvLogPath ? { argvLogPath } : {}),
    }),
  });
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const deepSeekAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-deepseek-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDeepSeekAdapter>[1]) =>
  makeDeepSeekAdapter(decodeDeepSeekSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(deepSeekAdapterTestLayer)("DeepSeekAdapterLive", (it) => {
  it.effect("rejects rollback without discarding the provider conversation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-unsupported-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockDshWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Remember this turn" });
      const originalTurns = [...(yield* adapter.readThread(threadId)).turns];
      assert.isFalse(adapter.capabilities.supportsConversationRollback);
      const error = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.deepStrictEqual((yield* adapter.readThread(threadId)).turns, originalTurns);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("launches dsh --profile acp and switches models via session/set_config_option", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-model-switch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dsh-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDshWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }, argvLogPath),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("deepseek"),
          "deepseek-official/deepseek-v4-pro",
        ),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("deepseek"),
          DEEPSEEK_DEFAULT_MODEL,
          [{ id: "reasoningEffort", value: "high" }],
        ),
      });
      const argvRuns = (yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8")))
        .trim()
        .split("\n");
      assert.lengthOf(argvRuns, 1, "session should not restart — only one spawn");
      assert.equal(argvRuns[0], "--profile\tacp");

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(requests.some((entry) => entry.method === "session/set_model"));
      assert.isFalse(requests.some((entry) => entry.method === "session/load"));
      const setConfigRequests = requests.filter(
        (entry) => entry.method === "session/set_config_option",
      );
      assert.isAbove(setConfigRequests.length, 0);
      assert.equal(
        (setConfigRequests[0]?.params as Record<string, unknown> | undefined)?.value,
        deepSeekProValue,
      );
      assert.isTrue(
        setConfigRequests.some(
          (entry) =>
            (entry.params as Record<string, unknown> | undefined)?.configId ===
              "reasoning_effort" &&
            (entry.params as Record<string, unknown> | undefined)?.value === "high",
        ),
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes with session/resume instead of session/load", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-resume");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dsh-acp-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDshWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/resume"));
      assert.isFalse(requests.some((entry) => entry.method === "session/load"));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails closed when the agent omits session/resume", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-incompatible");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDshWrapper({ T3_ACP_OMIT_RESUME: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const error = yield* adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      if (error._tag !== "ProviderAdapterRequestError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.include(error.detail, "session/resume");
    }),
  );
});
