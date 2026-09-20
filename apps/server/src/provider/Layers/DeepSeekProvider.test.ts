// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { DeepSeekSettings } from "@t3tools/contracts";

import {
  buildDeepSeekModelCapabilities,
  buildDeepSeekModelsFromConfigOptions,
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
} from "./DeepSeekProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  DEEPSEEK_ACP_MODEL_CONFIG_ID,
  DEEPSEEK_ACP_REASONING_CONFIG_ID,
  DEEPSEEK_DEFAULT_MODEL,
} from "../acp/DeepSeekAcpSupport.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");

const flashValue = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
const proValue = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);

describe("buildDeepSeekModelsFromConfigOptions", () => {
  it("flattens DSH grouped model options and maps reasoning_effort onto capabilities", () => {
    const models = buildDeepSeekModelsFromConfigOptions([
      {
        id: DEEPSEEK_ACP_MODEL_CONFIG_ID,
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
              { value: proValue, name: "DeepSeek V4 Pro" },
            ],
          },
        ],
      },
      {
        id: DEEPSEEK_ACP_REASONING_CONFIG_ID,
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "", name: "Provider default" },
          { value: "high", name: "High" },
        ],
      },
    ]);
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      [DEEPSEEK_DEFAULT_MODEL, true],
      ["deepseek-official/deepseek-v4-pro", false],
    ]);
    expect(models[0]?.capabilities?.optionDescriptors?.[0]?.id).toBe("reasoningEffort");
  });
});

describe("buildDeepSeekModelCapabilities", () => {
  it("keeps models without a reasoning option free of reasoning controls", () => {
    expect(buildDeepSeekModelCapabilities(undefined).optionDescriptors).toEqual([]);
  });
});

describe("buildInitialDeepSeekProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decodeDeepSeekSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — DeepSeek is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(decodeDeepSeekSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDeepSeekProviderSnapshot(
        decodeDeepSeekSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.badgeLabel).toBe("Developer Preview");
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );
});

const writeFakeDshCli = (input: {
  readonly version?: string;
  readonly versionExitCode?: number;
  readonly acp?: boolean;
  readonly omitResume?: boolean;
  readonly resumeNull?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-dsh-probe-" });
    return writeFakeCli({
      directory: dir,
      name: "dsh",
      env: {
        ...(input.acp ? { T3_ACP_DEEPSEEK: "1" } : {}),
        ...(input.omitResume ? { T3_ACP_OMIT_RESUME: "1", T3_ACP_DEEPSEEK: "1" } : {}),
        ...(input.resumeNull ? { T3_ACP_RESUME_NULL: "1", T3_ACP_DEEPSEEK: "1" } : {}),
      },
      source: [
        'if (process.argv[2] === "--version") {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `  process.stdout.write(${JSON.stringify(`${input.version ?? "0.1.5-rc.2"}\\n`)});`,
        `  process.exit(${input.versionExitCode ?? 0});`,
        "}",
        input.acp || input.omitResume || input.resumeNull
          ? [
              'if (process.argv[2] === "--profile" && process.argv[3] === "acp") {',
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `  await import(${JSON.stringify(NodeURL.pathToFileURL(mockAgentPath).href)});`,
              "  await new Promise(() => {});",
              "}",
            ].join("\n")
          : "",
        'process.stderr.write(`unexpected args: ${process.argv.slice(2).join(" ")}\\n`);',
        "process.exit(11);",
        "",
      ].join("\n"),
    });
  });

it.layer(NodeServices.layer)("checkDeepSeekProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDeepSeekProviderStatus(
        decodeDeepSeekSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/dsh-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("does not leak CLI stderr when --version fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli({
            version: "broken dsh: secret-token-value",
            versionExitCode: 2,
          });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: dshPath }),
          );
        }),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("DeepSeek Harness is installed but failed to run.");
      expect(snapshot.message).not.toContain("secret-token-value");
    }),
  );

  it.effect("fails closed for an older developer-preview CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli({ version: "0.1.5-rc.1" });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: dshPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.version).toBe("0.1.5-rc.1");
      expect(snapshot.message).toContain("not compatible");
    }),
  );

  it.effect("fails closed when ACP initialize omits session/resume", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli({ omitResume: true });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: dshPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("session/resume");
    }),
  );

  it.effect("fails closed when ACP initialize advertises resume: null", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli({ resumeNull: true });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: dshPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("session/resume");
    }),
  );

  it.effect("does not claim authenticated or ready from initialize alone", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli({ acp: true });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: dshPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBe("0.1.5-rc.2");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("when a session starts");
      expect(snapshot.message).not.toMatch(/authenticated|logged in/i);
      expect(snapshot.models.some((model) => model.slug === DEEPSEEK_DEFAULT_MODEL)).toBe(true);
    }),
  );

  it.effect("refresh uses a live catalog discovered from session config options", () =>
    Effect.gen(function* () {
      const liveCatalog = buildDeepSeekModelsFromConfigOptions([
        {
          id: DEEPSEEK_ACP_MODEL_CONFIG_ID,
          name: "Model",
          category: "model",
          type: "select",
          currentValue: proValue,
          options: [
            {
              group: "deepseek-official",
              name: "DeepSeek",
              options: [
                { value: flashValue, name: "DeepSeek V4 Flash" },
                { value: proValue, name: "DeepSeek V4 Pro" },
              ],
            },
          ],
        },
      ]);
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const dshPath = yield* writeFakeDshCli({ acp: true });
          return yield* checkDeepSeekProviderStatus(
            decodeDeepSeekSettings({ enabled: true, binaryPath: dshPath }),
            process.env,
            { liveCatalog },
          );
        }),
      );
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        DEEPSEEK_DEFAULT_MODEL,
        "deepseek-official/deepseek-v4-pro",
      ]);
    }),
  );
});
