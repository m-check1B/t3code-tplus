import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { MAX_TURN_RESULT_BYTES, readTurnResult } from "./TurnResult.ts";

const input = {
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("user-new"),
  turnCommandId: CommandId.make("command-new"),
};
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
    VALUES ('thread-1','project-1','Synthetic','{"instanceId":"codex","model":"model"}','full-access','default','2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
    VALUES ('user-new','thread-1',NULL,'user','synthetic input',0,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z'),
    ('assistant-old','thread-1','turn-old','assistant','PREVIOUS DONE',0,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')`;
  yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,actor_kind,payload_json,metadata_json)
    VALUES ('event-new','thread','thread-1',1,'thread.turn-start-requested','2026-09-30T00:00:00Z','command-new','user','{"threadId":"thread-1","messageId":"user-new","modelSelection":{"instanceId":"codex","model":"model","options":[{"id":"reasoningEffort","value":"high"}]}}','{}')`;
  yield* sql`INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status)
    VALUES ('command-new','thread','thread-1','2026-09-30T00:00:00Z',1,'accepted')`;
  yield* sql`INSERT INTO projection_turns (thread_id,turn_id,pending_message_id,assistant_message_id,state,requested_at,checkpoint_files_json)
    VALUES ('thread-1','turn-old','user-old','assistant-old','completed','2026-09-30T00:00:00Z','[]')`;
});

it.effect(
  "requires the exact thread, user message and accepted command; previous Done stays pending",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const pending = Option.getOrThrow(yield* readTurnResult(input));
      assert.equal(pending.state, "pending");
      assert.equal(pending.outputText, null);
      assert.equal(pending.assistantMessageId, null);
      for (const mismatch of [
        { ...input, threadId: ThreadId.make("foreign") },
        { ...input, messageId: MessageId.make("user-old") },
        { ...input, turnCommandId: CommandId.make("foreign-command") },
      ])
        assert.isTrue(Option.isNone(yield* readTurnResult(mismatch)));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("returns only the correlated terminal assistant text, with a byte bound", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
    VALUES ('assistant-new','thread-1','turn-new','assistant','REAL OUTPUT',0,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')`;
    yield* sql`INSERT INTO projection_turns (thread_id,turn_id,pending_message_id,assistant_message_id,state,requested_at,checkpoint_files_json)
    VALUES ('thread-1','turn-new','user-new','assistant-new','running','2026-09-30T00:00:00Z','[]')`;
    const pending = Option.getOrThrow(yield* readTurnResult(input));
    assert.equal(pending.state, "pending");
    assert.equal(pending.assistantMessageId, null);
    yield* sql`UPDATE projection_turns SET state = 'completed' WHERE turn_id = 'turn-new'`;
    const result = Option.getOrThrow(yield* readTurnResult(input));
    assert.equal(result.state, "succeeded");
    assert.equal(result.outputText, "REAL OUTPUT");
    assert.equal(result.assistantMessageId, "assistant-new");
    assert.equal(result.turnId, "turn-new");
    assert.equal(result.instanceId, "codex");
    assert.equal(result.model, "model");
    assert.equal(result.effort, "high");
    yield* sql`UPDATE projection_thread_messages SET text = ${"é".repeat(MAX_TURN_RESULT_BYTES)} WHERE message_id = 'assistant-new'`;
    assert.isTrue(Option.isNone(yield* readTurnResult(input)));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("returns correlated start failure and rejects deleted threads", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,tone,kind,summary,payload_json,created_at)
    VALUES ('failure','thread-1','error','provider.turn.start.failed','synthetic','{"requestId":"user-old"}','2026-09-30T00:00:00Z')`;
    assert.equal(Option.getOrThrow(yield* readTurnResult(input)).state, "pending");
    yield* sql`UPDATE projection_thread_activities SET payload_json = '{"requestId":"user-new"}' WHERE activity_id = 'failure'`;
    assert.equal(Option.getOrThrow(yield* readTurnResult(input)).state, "failed");
    yield* sql`UPDATE projection_threads SET deleted_at = '2026-09-30T00:01:00Z' WHERE thread_id = 'thread-1'`;
    assert.isTrue(Option.isNone(yield* readTurnResult(input)));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "keeps incomplete output pending and distinguishes error/cancelled with no transcript leak",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_turns (thread_id,turn_id,pending_message_id,assistant_message_id,state,requested_at,checkpoint_files_json)
    VALUES ('thread-1','turn-new','user-new','assistant-old','completed','2026-09-30T00:00:00Z','[]')`;
      assert.equal(Option.getOrThrow(yield* readTurnResult(input)).state, "pending");
      yield* sql`UPDATE projection_turns SET state = 'error' WHERE turn_id = 'turn-new'`;
      const failed = Option.getOrThrow(yield* readTurnResult(input));
      assert.equal(failed.state, "failed");
      assert.equal(failed.outputText, null);
      assert.equal(failed.assistantMessageId, null);
      yield* sql`UPDATE projection_turns SET state = 'interrupted' WHERE turn_id = 'turn-new'`;
      const cancelled = Option.getOrThrow(yield* readTurnResult(input));
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.assistantMessageId, null);
      yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.modelSelection.options', json('[{"id":"effort","value":"high"},{"id":"budget","value":"low"}]'))`;
      assert.isTrue(Option.isNone(yield* readTurnResult(input)));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
