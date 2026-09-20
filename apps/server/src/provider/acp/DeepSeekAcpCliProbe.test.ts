/**
 * Optional integration check against a real `dsh --profile acp` install.
 * Enable with: T3_DEEPSEEK_ACP_PROBE=1 vp test run DeepSeekAcpCliProbe
 *
 * Credentials stay in the DSH profile. This probe never prints environment
 * values or DSH secrets.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  applyDeepSeekAcpModelSelection,
  isDeepSeekAcpDeveloperPreviewCompatible,
  makeDeepSeekAcpRuntime,
  resolveDeepSeekAcpBaseModelId,
} from "./DeepSeekAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeDeepSeekAcpRuntime({
    deepSeekSettings: { binaryPath: "dsh" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-deepseek-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_DEEPSEEK_ACP_PROBE === "1")("DeepSeek ACP CLI probe", () => {
  it.effect("initialize advertises protocol v1 with session/resume", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const initialized = yield* runtime.initialize();
      expect(isDeepSeekAcpDeveloperPreviewCompatible(initialized)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "session/new advertises a model config option and accepts a no-op set_config_option",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
        const started = yield* runtime.start();
        expect(typeof started.sessionId).toBe("string");
        const model = (yield* runtime.getConfigOptions).find((option) => option.id === "model");
        expect(model?.type).toBe("select");
        const current = model?.type === "select" ? model.currentValue : undefined;
        expect(current).toBeDefined();
        if (!current) return;
        yield* applyDeepSeekAcpModelSelection({
          runtime,
          model: resolveDeepSeekAcpBaseModelId(
            current.startsWith("[") ? current : `deepseek-official/${current}`,
          ),
          selections: undefined,
          mapError: (context) => context.cause,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
