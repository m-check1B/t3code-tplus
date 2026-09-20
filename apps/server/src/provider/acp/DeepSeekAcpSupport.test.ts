import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDeepSeekAcpModelSelection,
  buildDeepSeekAcpSpawnInput,
  decodeDeepSeekAcpModelValue,
  deepSeekAcpSpawnArgs,
  deepSeekAcpValueFromModelSlug,
  deepSeekModelSlugFromAcpValue,
  deepSeekPermissionMode,
  DEEPSEEK_ACP_MODEL_CONFIG_ID,
  DEEPSEEK_ACP_REASONING_CONFIG_ID,
  DEEPSEEK_DEFAULT_MODEL,
  isDeepSeekAcpDeveloperPreviewCompatible,
  isDeepSeekCliVersionCompatible,
  isValidDeepSeekReasoningEffortToken,
  parseDeepSeekCliVersion,
  parseDeepSeekResume,
  resolveDeepSeekAcpBaseModelId,
  selectDeepSeekPermissionOptionId,
} from "./DeepSeekAcpSupport.ts";

const flashValue = JSON.stringify(["deepseek-official", "deepseek-flash"]);
const proValue = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);

const catalog: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
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
          { value: flashValue, name: "DeepSeek Flash" },
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
    currentValue: "",
    options: [
      { value: "", name: "Provider default" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

describe("deepSeekAcpSpawnArgs", () => {
  it("launches the official ACP profile with no Grok-style flags", () => {
    expect(deepSeekAcpSpawnArgs()).toEqual(["--profile", "acp"]);
  });
});

describe("deepSeekPermissionMode", () => {
  it("maps Full access onto DSH danger-full-access and every other mode onto workspace-write", () => {
    expect(deepSeekPermissionMode("full-access")).toBe("danger-full-access");
    expect(deepSeekPermissionMode("approval-required")).toBe("workspace-write");
    expect(deepSeekPermissionMode("auto-accept-edits")).toBe("workspace-write");
    expect(deepSeekPermissionMode("auto")).toBe("workspace-write");
    expect(deepSeekPermissionMode()).toBe("workspace-write");
  });
});

describe("buildDeepSeekAcpSpawnInput", () => {
  it("spawns dsh --profile acp and puts permission mode in DSH_PERMISSION_MODE", () => {
    const spawn = buildDeepSeekAcpSpawnInput(
      { binaryPath: "/usr/local/bin/dsh" },
      "/tmp/project",
      { PATH: "/usr/bin", DEEPSEEK_API_KEY: "secret-must-not-be-logged" },
      "full-access",
    );
    expect(spawn).toEqual({
      command: "/usr/local/bin/dsh",
      args: ["--profile", "acp"],
      cwd: "/tmp/project",
      env: {
        PATH: "/usr/bin",
        DEEPSEEK_API_KEY: "secret-must-not-be-logged",
        DSH_PERMISSION_MODE: "danger-full-access",
      },
    });
  });

  it("defaults the command to dsh when no binary path is configured", () => {
    expect(buildDeepSeekAcpSpawnInput(undefined, "/tmp/project").command).toBe("dsh");
  });
});

describe("DeepSeek model slug encoding", () => {
  it("round-trips DSH's opaque JSON catalog values through provider/model slugs", () => {
    expect(decodeDeepSeekAcpModelValue(flashValue)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-flash",
    });
    expect(deepSeekModelSlugFromAcpValue(flashValue)).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(deepSeekAcpValueFromModelSlug(DEEPSEEK_DEFAULT_MODEL)).toBe(flashValue);
    expect(deepSeekAcpValueFromModelSlug("deepseek-flash")).toBe(flashValue);
    expect(deepSeekAcpValueFromModelSlug(flashValue)).toBe(flashValue);
  });

  it("falls back to the shipped DSH default", () => {
    expect(resolveDeepSeekAcpBaseModelId(undefined)).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(resolveDeepSeekAcpBaseModelId("   ")).toBe(DEEPSEEK_DEFAULT_MODEL);
  });
});

describe("DeepSeek CLI version compatibility", () => {
  it("reads the official 0.1.5-rc.2 tag and rejects older developer-preview builds", () => {
    expect(parseDeepSeekCliVersion("0.1.5-rc.2\n")).toBe("0.1.5-rc.2");
    expect(isDeepSeekCliVersionCompatible("0.1.5-rc.2")).toBe(true);
    expect(isDeepSeekCliVersionCompatible("0.1.5")).toBe(true);
    expect(isDeepSeekCliVersionCompatible("0.1.5-rc.1")).toBe(false);
    expect(isDeepSeekCliVersionCompatible("0.1.4")).toBe(false);
    expect(isDeepSeekCliVersionCompatible(null)).toBe(false);
  });
});

describe("isDeepSeekAcpDeveloperPreviewCompatible", () => {
  it("requires protocol v1 and session/resume, and does not accept session/load as a substitute", () => {
    expect(
      isDeepSeekAcpDeveloperPreviewCompatible({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }),
    ).toBe(true);
    expect(
      isDeepSeekAcpDeveloperPreviewCompatible({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }),
    ).toBe(false);
    expect(isDeepSeekAcpDeveloperPreviewCompatible({ protocolVersion: 2 })).toBe(false);
  });
});

describe("isValidDeepSeekReasoningEffortToken", () => {
  it("accepts DSH's empty provider-default token and rejects malformed values", () => {
    expect(isValidDeepSeekReasoningEffortToken("")).toBe(true);
    expect(isValidDeepSeekReasoningEffortToken("high")).toBe(true);
    expect(isValidDeepSeekReasoningEffortToken("not a token")).toBe(false);
  });
});

describe("parseDeepSeekResume", () => {
  it("reads a v1 ACP session id and rejects other cursors", () => {
    expect(parseDeepSeekResume({ schemaVersion: 1, sessionId: "abc" })).toEqual({
      sessionId: "abc",
    });
    expect(parseDeepSeekResume({ schemaVersion: 2, sessionId: "abc" })).toBeUndefined();
    expect(parseDeepSeekResume({ sessionId: "abc" })).toBeUndefined();
  });
});

describe("selectDeepSeekPermissionOptionId", () => {
  const request = {
    sessionId: "mock-session-1",
    toolCall: { toolCallId: "tool-1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
    ],
  };

  it("maps Always allow onto DSH's one-shot allow because DSH has no allow_always", () => {
    expect(selectDeepSeekPermissionOptionId(request, "acceptForSession")).toBe("allow-once");
    expect(selectDeepSeekPermissionOptionId(request, "accept")).toBe("allow-once");
    expect(selectDeepSeekPermissionOptionId(request, "decline")).toBe("reject-once");
  });
});

describe("applyDeepSeekAcpModelSelection", () => {
  const makeRecordingRuntime = (
    options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = catalog,
    failure?: EffectAcpErrors.AcpError,
  ) => {
    let current = options;
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      getConfigOptions: Effect.sync(() => current),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          configCalls.push({ configId, value });
          if (failure) return yield* failure;
          current = current.map((option) =>
            option.id === configId && option.type === "select"
              ? { ...option, currentValue: String(value) }
              : option,
          );
          return { configOptions: current };
        }),
    };
    return { runtime, configCalls };
  };

  it.effect("switches models through session/set_config_option, never session/set_model", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        model: "deepseek-official/deepseek-v4-pro",
        selections: undefined,
        mapError: (context) => context.cause.message,
      });
      expect(configCalls).toEqual([{ configId: "model", value: proValue }]);
      expect(result).toBe(proValue);
    }),
  );

  it.effect("applies reasoning_effort through session/set_config_option", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime();
      yield* applyDeepSeekAcpModelSelection({
        runtime,
        model: DEEPSEEK_DEFAULT_MODEL,
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (context) => context.cause.message,
      });
      expect(configCalls).toEqual([{ configId: "reasoning_effort", value: "high" }]);
    }),
  );

  it.effect("skips set_config_option when the requested model is already current", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        model: DEEPSEEK_DEFAULT_MODEL,
        selections: undefined,
        mapError: (context) => context.cause.message,
      });
      expect(configCalls).toEqual([]);
      expect(result).toBe(flashValue);
    }),
  );

  it.effect("fails closed when the requested model is not in the live catalog", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime();
      const error = yield* applyDeepSeekAcpModelSelection({
        runtime,
        model: "unknown-provider/unknown-model",
        selections: undefined,
        mapError: (context) => context.cause.message,
      }).pipe(Effect.flip);
      expect(configCalls).toEqual([]);
      expect(error).toContain("not in the live ACP catalog");
    }),
  );

  it.effect("fails closed when DSH does not advertise a model config option", () =>
    Effect.gen(function* () {
      const { runtime } = makeRecordingRuntime([]);
      const error = yield* applyDeepSeekAcpModelSelection({
        runtime,
        model: DEEPSEEK_DEFAULT_MODEL,
        selections: undefined,
        mapError: (context) => `${context.configId}:${context.cause.message}`,
      }).pipe(Effect.flip);
      expect(error).toContain("model:");
      expect(error).toContain("did not advertise a model configuration option");
    }),
  );
});
