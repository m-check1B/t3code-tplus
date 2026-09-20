import {
  DEEPSEEK_DEFAULT_MODEL,
  type DeepSeekSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { isCommandMissingCause, spawnAndCollect } from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";

const DEEPSEEK_DRIVER_KIND = ProviderDriverKind.make("deepseek");
const DEEPSEEK_DEFAULT_PROVIDER_ID = "deepseek-official";
const DEEPSEEK_ACP_PROFILE = "acp";
const DEEPSEEK_AUTH_METHOD_ID = "dsh.profile";
export const DEEPSEEK_ACP_MODEL_CONFIG_ID = "model";
export const DEEPSEEK_ACP_REASONING_CONFIG_ID = "reasoning_effort";
export const DEEPSEEK_ACP_PROVIDER_DEFAULT_REASONING_VALUE = "";
export const DEEPSEEK_MIN_COMPATIBLE_CLI_VERSION = "0.1.5-rc.2";
export const DEEPSEEK_PERMISSION_MODE_ENV = "DSH_PERMISSION_MODE";
export type DeepSeekPermissionMode = "read-only" | "workspace-write" | "danger-full-access";
/** Headless commit/PR/title generation must not inherit workspace-write. */
export const DEEPSEEK_TEXT_GENERATION_PERMISSION_MODE: DeepSeekPermissionMode = "read-only";
export const DEEPSEEK_CLI_VERSION_PROBE_TIMEOUT = Duration.millis(4_000);
export { DEEPSEEK_DEFAULT_MODEL };

export function deepSeekCliIncompatibleMessage(version: string | null | undefined): string {
  return `DeepSeek Harness ${version ?? "unknown"} is not compatible with this T3 Code developer preview. Install dsh ${DEEPSEEK_MIN_COMPATIBLE_CLI_VERSION} or newer.`;
}

export function deepSeekAcpErrorDetail(error: EffectAcpErrors.AcpError): string {
  if ("detail" in error && typeof error.detail === "string" && error.detail.trim()) {
    return error.detail;
  }
  return error.message;
}

const DEEPSEEK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

type DeepSeekAcpRuntimeSettings = Pick<DeepSeekSettings, "binaryPath">;

export interface DeepSeekAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly deepSeekSettings: DeepSeekAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Direct `DSH_PERMISSION_MODE` value. When set, this wins over `runtimeMode`.
   * Headless text generation must pass `read-only`.
   */
  readonly permissionMode?: DeepSeekPermissionMode;
  /**
   * Status probes that already ran `dsh --version` skip a second execution-path
   * check. Chat and text-generation must leave this unset so they fail closed.
   */
  readonly skipCliCompatibilityCheck?: boolean;
}

export interface DeepSeekAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId: string;
}

export interface DeepSeekAcpModelRoute {
  readonly provider: string;
  readonly model: string;
}

interface ParsedCliVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepSeekAcpSpawnArgs(): ReadonlyArray<string> {
  return ["--profile", DEEPSEEK_ACP_PROFILE];
}

/**
 * DSH has no Grok-style `--permission-mode` flags. The ACP profile reads
 * `DSH_PERMISSION_MODE` (`read-only` refuses writes; `workspace-write` asks;
 * `danger-full-access` never). Interactive coding maps Full access onto
 * `danger-full-access` and every other RuntimeMode onto `workspace-write`.
 * Headless text generation must pass `read-only` explicitly.
 */
export function deepSeekPermissionMode(runtimeMode?: RuntimeMode): DeepSeekPermissionMode {
  return runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
}

export function resolveDeepSeekAcpPermissionMode(input: {
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly permissionMode?: DeepSeekPermissionMode | undefined;
}): DeepSeekPermissionMode {
  return input.permissionMode ?? deepSeekPermissionMode(input.runtimeMode);
}

export function buildDeepSeekAcpSpawnInput(
  deepSeekSettings: DeepSeekAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  permissionMode?: DeepSeekPermissionMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: deepSeekSettings?.binaryPath || "dsh",
    args: [...deepSeekAcpSpawnArgs()],
    cwd,
    env: {
      ...environment,
      [DEEPSEEK_PERMISSION_MODE_ENV]: resolveDeepSeekAcpPermissionMode({
        runtimeMode,
        permissionMode,
      }),
    },
  };
}

export const makeDeepSeekAcpRuntime = (
  input: DeepSeekAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    if (input.skipCliCompatibilityCheck !== true) {
      yield* ensureDeepSeekCliCompatible(
        input.deepSeekSettings?.binaryPath,
        input.environment ?? process.env,
      );
    }
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDeepSeekAcpSpawnInput(
          input.deepSeekSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
          input.permissionMode,
        ),
        // DSH authenticate is a no-op; credentials stay in the DSH profile.
        authMethodId: DEEPSEEK_AUTH_METHOD_ID,
        resumeMethod: "resume",
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function parseDeepSeekCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function parseCliVersionParts(version: string): ParsedCliVersion | undefined {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

function comparePrereleaseIdentifiers(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "number") {
    return -1;
  }
  if (typeof right === "number") {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareParsedCliVersions(left: ParsedCliVersion, right: ParsedCliVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const limit = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    const compared = comparePrereleaseIdentifiers(
      left.prerelease[index]!,
      right.prerelease[index]!,
    );
    if (compared !== 0) return compared;
  }
  return left.prerelease.length - right.prerelease.length;
}

export function isDeepSeekCliVersionCompatible(version: string | null | undefined): boolean {
  if (!version) {
    return false;
  }
  const parsed = parseCliVersionParts(version);
  const minimum = parseCliVersionParts(DEEPSEEK_MIN_COMPATIBLE_CLI_VERSION);
  if (!parsed || !minimum) {
    return false;
  }
  return compareParsedCliVersions(parsed, minimum) >= 0;
}

export const probeDeepSeekCliVersion = Effect.fn("probeDeepSeekCliVersion")(function* (
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  { readonly version: string | null; readonly missing: boolean; readonly failed: boolean },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = binaryPath?.trim() || "dsh";
  const spawned = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(DEEPSEEK_CLI_VERSION_PROBE_TIMEOUT), Effect.result);

  if (spawned._tag === "Failure") {
    return { version: null, missing: isCommandMissingCause(spawned.failure), failed: true };
  }
  if (Option.isNone(spawned.success)) {
    return { version: null, missing: false, failed: true };
  }
  const output = spawned.success.value;
  const version = parseDeepSeekCliVersion(`${output.stdout}\n${output.stderr}`);
  return {
    version,
    missing: false,
    failed: output.code !== 0,
  };
});

/**
 * Shared fail-closed gate for chat and text-generation. Status probes that
 * already classified `dsh --version` should skip this via
 * `skipCliCompatibilityCheck`.
 */
export const ensureDeepSeekCliCompatible = Effect.fn("ensureDeepSeekCliCompatible")(function* (
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, EffectAcpErrors.AcpError, ChildProcessSpawner.ChildProcessSpawner> {
  const probed = yield* probeDeepSeekCliVersion(binaryPath, environment);
  if (probed.missing) {
    return yield* new EffectAcpErrors.AcpTransportError({
      method: "dsh --version",
      detail: "DeepSeek Harness (`dsh`) is not installed or not on PATH.",
      cause: undefined,
    });
  }
  if (probed.failed || !isDeepSeekCliVersionCompatible(probed.version)) {
    return yield* new EffectAcpErrors.AcpTransportError({
      method: "dsh --version",
      detail: deepSeekCliIncompatibleMessage(probed.version),
      cause: undefined,
    });
  }
  return probed.version as string;
});

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * DSH's developer-preview ACP surface: protocol v1 plus a non-null
 * `session/resume` capability object. `resume: null` and `session/load` are
 * incompatible — T3 must not fall back to Grok's dialect.
 */
export function isDeepSeekAcpDeveloperPreviewCompatible(
  initializeResult: EffectAcpSchema.InitializeResponse,
): boolean {
  if (initializeResult.protocolVersion !== 1) {
    return false;
  }
  return isNonNullObject(initializeResult.agentCapabilities?.sessionCapabilities?.resume);
}

export function encodeDeepSeekAcpModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

export function decodeDeepSeekAcpModelValue(value: string): DeepSeekAcpModelRoute | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return undefined;
    }
    const provider = parsed[0].trim();
    const model = parsed[1].trim();
    if (!provider || !model) {
      return undefined;
    }
    return { provider, model };
  } catch {
    return undefined;
  }
}

export function deepSeekModelSlugFromAcpValue(value: string): string {
  const decoded = decodeDeepSeekAcpModelValue(value);
  return decoded ? `${decoded.provider}/${decoded.model}` : value.trim();
}

export function resolveDeepSeekAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEEPSEEK_DEFAULT_MODEL;
  return normalizeModelSlug(base, DEEPSEEK_DRIVER_KIND) ?? DEEPSEEK_DEFAULT_MODEL;
}

export function deepSeekAcpValueFromModelSlug(slug: string): string {
  const trimmed = resolveDeepSeekAcpBaseModelId(slug);
  if (decodeDeepSeekAcpModelValue(trimmed)) {
    return trimmed;
  }
  const separator = trimmed.indexOf("/");
  if (separator > 0) {
    const provider = trimmed.slice(0, separator).trim();
    const model = trimmed.slice(separator + 1).trim();
    if (provider && model) {
      return encodeDeepSeekAcpModelValue(provider, model);
    }
  }
  return encodeDeepSeekAcpModelValue(DEEPSEEK_DEFAULT_PROVIDER_ID, trimmed);
}

export function isValidDeepSeekReasoningEffortToken(value: string): boolean {
  return value === DEEPSEEK_ACP_PROVIDER_DEFAULT_REASONING_VALUE
    ? true
    : DEEPSEEK_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeDeepSeekReasoningEffort(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const effort = value.trim();
  if (effort === DEEPSEEK_ACP_PROVIDER_DEFAULT_REASONING_VALUE) {
    return DEEPSEEK_ACP_PROVIDER_DEFAULT_REASONING_VALUE;
  }
  return isValidDeepSeekReasoningEffortToken(effort) ? effort : undefined;
}

export function deepSeekSelectEntries(option: EffectAcpSchema.SessionConfigOption): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}> {
  if (option.type !== "select") {
    return [];
  }
  const entries: Array<{ value: string; name: string; description?: string }> = [];
  for (const entry of option.options) {
    if ("value" in entry) {
      const description = entry.description?.trim();
      entries.push({
        value: entry.value,
        name: entry.name,
        ...(description ? { description } : {}),
      });
      continue;
    }
    for (const child of entry.options) {
      const description = child.description?.trim();
      entries.push({
        value: child.value,
        name: child.name,
        ...(description ? { description } : {}),
      });
    }
  }
  return entries;
}

export function currentDeepSeekModelValueFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const model = findSessionConfigOption(configOptions, DEEPSEEK_ACP_MODEL_CONFIG_ID);
  return model?.type === "select" ? model.currentValue.trim() || undefined : undefined;
}

export function currentDeepSeekReasoningEffortFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const reasoning = findSessionConfigOption(configOptions, DEEPSEEK_ACP_REASONING_CONFIG_ID);
  if (reasoning?.type !== "select") {
    return undefined;
  }
  return normalizeDeepSeekReasoningEffort(reasoning.currentValue);
}

interface DeepSeekAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDeepSeekAcpModelSelection<E>(input: {
  readonly runtime: DeepSeekAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DeepSeekAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = findSessionConfigOption(configOptions, DEEPSEEK_ACP_MODEL_CONFIG_ID);
    if (!modelOption || modelOption.type !== "select") {
      return yield* Effect.fail(
        input.mapError({
          cause: EffectAcpErrors.AcpRequestError.invalidParams(
            "DeepSeek Harness did not advertise a model configuration option.",
          ),
          step: "set-config-option",
          configId: DEEPSEEK_ACP_MODEL_CONFIG_ID,
        }),
      );
    }

    const advertisedValues = new Set(collectSessionConfigOptionValues(modelOption));
    const currentValue = modelOption.currentValue.trim() || undefined;
    const requestedSlug = input.model ? resolveDeepSeekAcpBaseModelId(input.model) : undefined;
    const requestedValue = requestedSlug ? deepSeekAcpValueFromModelSlug(requestedSlug) : undefined;
    const targetValue =
      requestedValue && advertisedValues.has(requestedValue)
        ? requestedValue
        : requestedValue && advertisedValues.has(requestedSlug ?? "")
          ? (requestedSlug as string)
          : currentValue;

    if (requestedValue && targetValue !== requestedValue && targetValue !== requestedSlug) {
      return yield* Effect.fail(
        input.mapError({
          cause: EffectAcpErrors.AcpRequestError.invalidParams(
            `DeepSeek Harness model '${requestedSlug}' is not in the live ACP catalog.`,
          ),
          step: "set-config-option",
          configId: DEEPSEEK_ACP_MODEL_CONFIG_ID,
        }),
      );
    }

    if (targetValue !== undefined && targetValue !== currentValue) {
      yield* input.runtime.setConfigOption(DEEPSEEK_ACP_MODEL_CONFIG_ID, targetValue).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: DEEPSEEK_ACP_MODEL_CONFIG_ID,
          }),
        ),
      );
    }

    const requestedReasoningEffort = getProviderOptionStringSelectionValue(
      input.selections,
      "reasoningEffort",
    );
    if (requestedReasoningEffort !== undefined) {
      const reasoningOption = findSessionConfigOption(
        yield* input.runtime.getConfigOptions,
        DEEPSEEK_ACP_REASONING_CONFIG_ID,
      );
      if (!reasoningOption || reasoningOption.type !== "select") {
        return targetValue ?? currentValue;
      }
      const effort = normalizeDeepSeekReasoningEffort(requestedReasoningEffort);
      if (effort === undefined) {
        return targetValue ?? currentValue;
      }
      const advertisedEfforts = new Set(collectSessionConfigOptionValues(reasoningOption));
      if (!advertisedEfforts.has(effort)) {
        return yield* Effect.fail(
          input.mapError({
            cause: EffectAcpErrors.AcpRequestError.invalidParams(
              `DeepSeek Harness reasoning effort '${requestedReasoningEffort}' is not advertised for the selected model.`,
            ),
            step: "set-config-option",
            configId: DEEPSEEK_ACP_REASONING_CONFIG_ID,
          }),
        );
      }
      if (effort !== reasoningOption.currentValue) {
        yield* input.runtime.setConfigOption(DEEPSEEK_ACP_REASONING_CONFIG_ID, effort).pipe(
          Effect.mapError((cause) =>
            input.mapError({
              cause,
              step: "set-config-option",
              configId: DEEPSEEK_ACP_REASONING_CONFIG_ID,
            }),
          ),
        );
      }
    }

    return targetValue ?? currentValue;
  });
}

export function selectDeepSeekPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<import("@t3tools/contracts").ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKind = decision === "decline" ? "reject_once" : "allow_once";
  const preferred = request.options.find((entry) => entry.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();
  if (preferredId) {
    return preferredId;
  }
  if (decision !== "decline") {
    const allowAlways = request.options.find((entry) => entry.kind === "allow_always");
    const allowAlwaysId = allowAlways?.optionId.trim();
    if (allowAlwaysId) {
      return allowAlwaysId;
    }
  }
  return undefined;
}

export function parseDeepSeekResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== 1) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}
