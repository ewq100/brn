/**
 * The wire contract.
 *
 * Every request body, response body and stream event BRN exchanges is described
 * here as an explicit TypeBox schema: named fields, `additionalProperties: false`,
 * and a bound on every string and array. Nothing is `Type.Any`, so neither side
 * can accept a shape nobody reviewed.
 *
 * The module is browser-safe on purpose: it imports no Node, Pi, transport or
 * storage module. The core conversation interfaces are matched structurally by
 * typed assignments in `test/events.test.ts` rather than by importing them here,
 * which keeps the dependency edge pointing only one way.
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** The maximum prompt BRN accepts, in UTF-8 bytes. Checked after schema validation. */
export const MAX_PROMPT_BYTES = 16384;

/** The HTTP request-body ceiling, in bytes, applied before any parsing. */
export const MAX_BODY_BYTES = 128 * 1024;

/** An opaque session identifier is bounded and never used as a path component. */
export const MAX_SESSION_ID_LENGTH = 256;

/** Listings are bounded so a large catalogue cannot become an unbounded response. */
export const MAX_LIST_ITEMS = 512;

/** The live-preview ceiling the coordinator enforces, mirrored as a wire bound. */
export const MAX_LIVE_TEXT_LENGTH = 1024 * 1024;

export const ModelIdSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1, maxLength: 128 }),
		id: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);
export const PromptSchema = Type.Object(
	{
		requestId: Type.String({
			pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
		}),
		sessionId: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
		model: ModelIdSchema,
		text: Type.String({ minLength: 1, maxLength: MAX_PROMPT_BYTES }),
	},
	{ additionalProperties: false },
);
export type PromptRequest = Static<typeof PromptSchema>;
export function isPrompt(value: unknown): value is PromptRequest {
	return Value.Check(PromptSchema, value);
}

export const HealthSchema = Type.Object(
	{
		status: Type.Literal("ok"),
		/** True whenever the service answers at all: it is not ready before that. */
		ready: Type.Literal(true),
		version: Type.Literal(1),
		instanceId: Type.String({ minLength: 1, maxLength: 128 }),
		pid: Type.Integer(),
	},
	{ additionalProperties: false },
);
export type Health = Static<typeof HealthSchema>;

export const UsageSchema = Type.Object(
	{
		input: Type.Integer({ minimum: 0 }),
		output: Type.Integer({ minimum: 0 }),
		cacheRead: Type.Integer({ minimum: 0 }),
		cacheWrite: Type.Integer({ minimum: 0 }),
		totalTokens: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

/** An unknown token count stays `null`; it is never reported as a tidy zero. */
export const ContextUsageSchema = Type.Union([
	Type.Null(),
	Type.Object(
		{
			tokens: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]),
			contextWindow: Type.Integer({ minimum: 0 }),
			percent: Type.Union([Type.Null(), Type.Number({ minimum: 0 })]),
		},
		{ additionalProperties: false },
	),
]);

export const SessionInfoSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
		model: Type.Union([Type.Null(), ModelIdSchema]),
	},
	{ additionalProperties: false },
);

export const ConversationSnapshotSchema = Type.Object(
	{
		session: Type.Union([Type.Null(), SessionInfoSchema]),
		context: ContextUsageSchema,
		usage: UsageSchema,
	},
	{ additionalProperties: false },
);

const EntryIdsSchema = Type.Array(
	Type.String({ minLength: 1, maxLength: 256 }),
	{ maxItems: MAX_LIST_ITEMS },
);

export const RunResultSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("completed"),
			entryIds: EntryIdsSchema,
			truncated: Type.Boolean(),
			usage: UsageSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("cancelled"), entryIds: EntryIdsSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("failed"),
			code: Type.Union([
				Type.Literal("PROVIDER_ERROR"),
				Type.Literal("NO_MODEL"),
				Type.Literal("AUTH_REQUIRED"),
			]),
			entryIds: EntryIdsSchema,
		},
		{ additionalProperties: false },
	),
]);

export const OperationStateSchema = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("running"),
	Type.Literal("cancelling"),
	Type.Literal("succeeded"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("interrupted"),
]);

export const OperationSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		sessionId: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
		requestHash: Type.String({ minLength: 1, maxLength: 128 }),
		state: OperationStateSchema,
		result: Type.Union([Type.Null(), RunResultSchema]),
		failureCode: Type.Union([
			Type.Null(),
			Type.String({ minLength: 1, maxLength: 64 }),
		]),
	},
	{ additionalProperties: false },
);
export type OperationResponse = Static<typeof OperationSchema>;

export const OperationViewSchema = Type.Object(
	{
		operation: Type.Union([Type.Null(), OperationSchema]),
		liveText: Type.String({ maxLength: MAX_LIVE_TEXT_LENGTH }),
		accepting: Type.Boolean(),
		controlling: Type.Boolean(),
	},
	{ additionalProperties: false },
);

/**
 * One complete, bounded view of the service.
 *
 * `sequence` increases within one `instanceId` and carries no meaning across
 * instances: a restart begins a new sequence, which is why every connection
 * starts from a fresh snapshot instead of replaying a journal.
 */
export const SnapshotSchema = Type.Object(
	{
		instanceId: Type.String({ minLength: 1, maxLength: 128 }),
		sequence: Type.Integer({ minimum: 0 }),
		conversation: ConversationSnapshotSchema,
		work: OperationViewSchema,
	},
	{ additionalProperties: false },
);
export type Snapshot = Static<typeof SnapshotSchema>;

export const StreamEventSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("snapshot"), snapshot: SnapshotSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("update"), snapshot: SnapshotSchema },
		{ additionalProperties: false },
	),
]);
export type StreamEvent = Static<typeof StreamEventSchema>;

export function isStreamEvent(value: unknown): value is StreamEvent {
	return Value.Check(StreamEventSchema, value);
}

export const ModelsResponseSchema = Type.Object(
	{ models: Type.Array(ModelIdSchema, { maxItems: MAX_LIST_ITEMS }) },
	{ additionalProperties: false },
);

export const SessionsResponseSchema = Type.Object(
	{ sessions: Type.Array(SessionInfoSchema, { maxItems: MAX_LIST_ITEMS }) },
	{ additionalProperties: false },
);

export const ModelRequestSchema = Type.Object(
	{ model: ModelIdSchema },
	{ additionalProperties: false },
);
export type ModelRequest = Static<typeof ModelRequestSchema>;

export const ResumeRequestSchema = Type.Object(
	{
		sessionId: Type.String({ minLength: 1, maxLength: MAX_SESSION_ID_LENGTH }),
	},
	{ additionalProperties: false },
);
export type ResumeRequest = Static<typeof ResumeRequestSchema>;

/** Cancellation is explicit: an absent or false confirmation is not a cancellation. */
export const CancelRequestSchema = Type.Object(
	{ confirmed: Type.Literal(true) },
	{ additionalProperties: false },
);
export type CancelRequest = Static<typeof CancelRequestSchema>;

export const ResultResponseSchema = Type.Object(
	{
		text: Type.String({ maxLength: MAX_LIVE_TEXT_LENGTH }),
		truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type ResultResponse = Static<typeof ResultResponseSchema>;

/** Every failure body. The message is fixed text chosen in BRN's own source. */
export const ErrorResponseSchema = Type.Object(
	{
		error: Type.Object(
			{
				code: Type.String({ minLength: 1, maxLength: 64 }),
				message: Type.String({ minLength: 1, maxLength: 128 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export function isModelRequest(value: unknown): value is ModelRequest {
	return Value.Check(ModelRequestSchema, value);
}

export function isResumeRequest(value: unknown): value is ResumeRequest {
	return Value.Check(ResumeRequestSchema, value);
}

export function isCancelRequest(value: unknown): value is CancelRequest {
	return Value.Check(CancelRequestSchema, value);
}

/** Counts the UTF-8 bytes of a prompt, which JSON Schema `maxLength` cannot. */
export function promptBytes(text: string): number {
	return new TextEncoder().encode(text).length;
}
