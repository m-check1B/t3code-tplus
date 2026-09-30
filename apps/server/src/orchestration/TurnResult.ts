import { OrchestrationTurnResult, type OrchestrationTurnResultInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const MAX_TURN_RESULT_BYTES = 32 * 1024;
const decodeTurnResult = Schema.decodeUnknownEffect(OrchestrationTurnResult);

/** The persisted command event proves the input; the turn projection proves
 * its output. Never use latestTurn, message ordering, or timestamp matching. */
export const readTurnResult = Effect.fn("orchestration.readTurnResult")(function* (
  input: OrchestrationTurnResultInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    turnId: string | null;
    state: string | null;
    instanceId: string | null;
    model: string | null;
    optionsJson: string | null;
    outputText: string | null;
    outputBytes: number | null;
    streaming: number | null;
    startFailed: number;
  }>`
    SELECT turns.turn_id AS "turnId", turns.state,
      json_extract(events.payload_json, '$.modelSelection.instanceId') AS "instanceId",
      json_extract(events.payload_json, '$.modelSelection.model') AS model,
      json_extract(events.payload_json, '$.modelSelection.options') AS "optionsJson",
      CASE WHEN length(CAST(messages.text AS BLOB)) <= ${MAX_TURN_RESULT_BYTES}
        THEN messages.text ELSE NULL END AS "outputText",
      length(CAST(messages.text AS BLOB)) AS "outputBytes",
      messages.is_streaming AS streaming,
      EXISTS (SELECT 1 FROM projection_thread_activities failure
        WHERE failure.thread_id = ${input.threadId}
          AND failure.kind = 'provider.turn.start.failed'
          AND json_extract(failure.payload_json, '$.requestId') = ${input.messageId}) AS "startFailed"
    FROM orchestration_events events
    JOIN orchestration_command_receipts receipts
      ON receipts.command_id = events.command_id
      AND receipts.aggregate_kind = 'thread' AND receipts.aggregate_id = ${input.threadId}
      AND receipts.status = 'accepted'
    JOIN projection_threads threads ON threads.thread_id = ${input.threadId}
      AND threads.deleted_at IS NULL
    JOIN projection_thread_messages input_message
      ON input_message.thread_id = ${input.threadId}
      AND input_message.message_id = ${input.messageId} AND input_message.role = 'user'
    LEFT JOIN projection_turns turns ON turns.thread_id = ${input.threadId}
      AND turns.pending_message_id = ${input.messageId}
    LEFT JOIN projection_thread_messages messages
      ON messages.thread_id = ${input.threadId} AND messages.turn_id = turns.turn_id
      AND messages.message_id = turns.assistant_message_id AND messages.role = 'assistant'
    WHERE events.command_id = ${input.turnCommandId}
      AND events.aggregate_kind = 'thread' AND events.stream_id = ${input.threadId}
      AND events.event_type = 'thread.turn-start-requested'
      AND json_extract(events.payload_json, '$.threadId') = ${input.threadId}
      AND json_extract(events.payload_json, '$.messageId') = ${input.messageId}
    LIMIT 2
  `;
  if (rows.length !== 1) return Option.none();
  const row = rows[0]!;
  if (
    (row.instanceId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(row.instanceId)) ||
    (row.model !== null && (row.model.length === 0 || row.model.length > 256)) ||
    (row.optionsJson !== null && row.optionsJson.length > 8192)
  )
    return Option.none();
  const options = row.optionsJson === null ? [] : (JSON.parse(row.optionsJson) as unknown);
  if (!Array.isArray(options)) return Option.none();
  const efforts = options
    .filter(
      (option: unknown) =>
        option !== null &&
        typeof option === "object" &&
        "id" in option &&
        ["reasoningEffort", "effort", "budget"].includes(String(option.id)),
    )
    .map((option: { value?: unknown }) => option.value);
  if (
    efforts.some(
      (value: unknown) => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value),
    ) ||
    new Set(efforts).size > 1
  )
    return Option.none();
  const effort = efforts[0] ?? null;
  // Refuse oversize output rather than silently claiming a truncated reply.
  if ((row.outputBytes ?? 0) > MAX_TURN_RESULT_BYTES) return Option.none();
  const state =
    row.startFailed || row.state === "error"
      ? "failed"
      : row.state === "interrupted"
        ? "cancelled"
        : row.state === "completed" && row.streaming === 0 && row.outputText !== null
          ? "succeeded"
          : "pending";
  return Option.some(
    yield* decodeTurnResult({
      ...input,
      turnId: row.turnId,
      instanceId: row.instanceId,
      model: row.model,
      effort,
      state,
      outputText: state === "succeeded" ? row.outputText : null,
    }),
  );
});
