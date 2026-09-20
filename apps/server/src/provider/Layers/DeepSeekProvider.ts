import {
  type CustomModelSetting,
  DEEPSEEK_DEFAULT_MODEL,
  type DeepSeekSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  DEEPSEEK_ACP_MODEL_CONFIG_ID,
  DEEPSEEK_ACP_REASONING_CONFIG_ID,
  DEEPSEEK_MIN_COMPATIBLE_CLI_VERSION,
  currentDeepSeekModelValueFromConfigOptions,
  deepSeekModelSlugFromAcpValue,
  deepSeekSelectEntries,
  isDeepSeekAcpDeveloperPreviewCompatible,
  isDeepSeekCliVersionCompatible,
  makeDeepSeekAcpRuntime,
  parseDeepSeekCliVersion,
  resolveDeepSeekAcpBaseModelId,
} from "../acp/DeepSeekAcpSupport.ts";
import { findSessionConfigOption } from "../acp/AcpRuntimeModel.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  supportsConversationRollback: false,
  badgeLabel: "Developer Preview",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const DEEPSEEK_ACP_INITIALIZE_TIMEOUT_MS = 8_000;

const DEEPSEEK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEEPSEEK_DEFAULT_MODEL,
    name: "DeepSeek Flash",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDeepSeekProviderSnapshot(
  deepSeekSettings: DeepSeekSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = deepSeekModelsFromSettings(deepSeekSettings.customModels);

    if (!deepSeekSettings.enabled) {
      return buildServerProvider({
        presentation: DEEPSEEK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "DeepSeek Harness is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking DeepSeek Harness availability...",
      },
    });
  });
}

function deepSeekModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEEPSEEK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function displayNameFromDeepSeekModelSlug(slug: string): string {
  const name = slug.includes("/") ? (slug.split("/").at(-1) ?? slug) : slug;
  return name
    .split(/[-_]/g)
    .map((part) => (part.toLowerCase() === "deepseek" ? "DeepSeek" : part))
    .join(" ");
}

export function buildDeepSeekModelCapabilities(
  reasoning: EffectAcpSchema.SessionConfigOption | undefined,
): ModelCapabilities {
  if (!reasoning || reasoning.type !== "select") {
    return EMPTY_CAPABILITIES;
  }
  const options = deepSeekSelectEntries(reasoning);
  if (options.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  const currentValue = reasoning.currentValue;
  const advertisedDefault = options.find((option) => option.value === currentValue)?.value;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: options.map((option) => ({
          id: option.value,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
          ...(option.value === advertisedDefault ? { isDefault: true } : {}),
        })),
        ...(currentValue !== undefined ? { currentValue } : {}),
      },
    ],
  });
}

/** Models advertised by DSH `session/set_config_option` catalog state. */
export function buildDeepSeekModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }
  const modelOption = findSessionConfigOption(configOptions, DEEPSEEK_ACP_MODEL_CONFIG_ID);
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const currentValue = currentDeepSeekModelValueFromConfigOptions(configOptions);
  const reasoning = findSessionConfigOption(configOptions, DEEPSEEK_ACP_REASONING_CONFIG_ID);
  const capabilities = buildDeepSeekModelCapabilities(reasoning);
  const seen = new Set<string>();
  return deepSeekSelectEntries(modelOption).flatMap((entry): ServerProviderModel[] => {
    const slug = resolveDeepSeekAcpBaseModelId(deepSeekModelSlugFromAcpValue(entry.value));
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name.trim() || displayNameFromDeepSeekModelSlug(slug),
        isCustom: false,
        ...(entry.value === currentValue || slug === currentValue ? { isDefault: true } : {}),
        capabilities,
      },
    ];
  });
}

const runDeepSeekCliCommand = (
  deepSeekSettings: DeepSeekSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = deepSeekSettings.binaryPath || "dsh";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const probeDeepSeekAcpInitialize = (
  deepSeekSettings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDeepSeekAcpRuntime({
      deepSeekSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    return yield* acp.initialize();
  }).pipe(Effect.scoped);

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  deepSeekSettings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = deepSeekModelsFromSettings(deepSeekSettings.customModels);

  if (!deepSeekSettings.enabled) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDeepSeekCliCommand(
    deepSeekSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("DeepSeek Harness CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepSeekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "DeepSeek Harness (`dsh`) is not installed or not on PATH."
          : "Failed to execute DeepSeek Harness health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepSeekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is installed but timed out while running `dsh --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseDeepSeekCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("DeepSeek Harness version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepSeekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is installed but failed to run.",
      },
    });
  }

  if (!isDeepSeekCliVersionCompatible(version)) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepSeekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `DeepSeek Harness ${version ?? "unknown"} is not compatible with this T3 Code developer preview. Install dsh ${DEEPSEEK_MIN_COMPATIBLE_CLI_VERSION} or newer.`,
      },
    });
  }

  const acpExit = yield* probeDeepSeekAcpInitialize(deepSeekSettings, environment).pipe(
    Effect.timeoutOption(DEEPSEEK_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const initialized = Exit.isSuccess(acpExit) ? Option.getOrUndefined(acpExit.value) : undefined;
  if (initialized === undefined) {
    yield* Effect.logWarning("DeepSeek Harness ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepSeekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "DeepSeek Harness is installed but ACP initialize failed. T3 will not fall back to another provider protocol.",
      },
    });
  }

  if (!isDeepSeekAcpDeveloperPreviewCompatible(initialized)) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: deepSeekSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "DeepSeek Harness ACP is not compatible with this T3 Code developer preview. The agent must speak protocol v1 with session/resume.",
      },
    });
  }

  const auth: ServerProviderAuth = {
    status: "authenticated",
    type: "cached_token",
    label: "DSH profile",
  };

  return buildServerProvider({
    presentation: DEEPSEEK_PRESENTATION,
    enabled: deepSeekSettings.enabled,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichDeepSeekSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("DeepSeek version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
