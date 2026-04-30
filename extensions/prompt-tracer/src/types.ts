export type TraceStatus = "idle" | "recording" | "flushing";

export type PhaseKind =
  | "before_prompt_build"
  | "llm_input"
  | "tool_call"
  | "llm_output"
  | "message_write";

export type PhaseBeforePromptBuild = {
  kind: "before_prompt_build";
  at: string;
  prompt: string;
  messages: unknown[];
};

export type PhaseLlmInput = {
  kind: "llm_input";
  at: string;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

export type PhaseToolCall = {
  kind: "tool_call";
  at: string;
  toolName: string;
  toolCallId?: string;
  runId?: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type PhaseLlmOutput = {
  kind: "llm_output";
  at: string;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type PhaseMessageWrite = {
  kind: "message_write";
  at: string;
  role: string;
  contentPreview: string;
};

export type PhaseRecord =
  | PhaseBeforePromptBuild
  | PhaseLlmInput
  | PhaseToolCall
  | PhaseLlmOutput
  | PhaseMessageWrite;

export type TurnRecord = {
  index: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  synthetic?: boolean;
  phases: PhaseRecord[];
};

export type TraceMeta = {
  provider?: string;
  model?: string;
  channel?: string;
  openclawVersion?: string;
};

/**
 * Observed-tools table accumulated from `before_tool_call` events across the
 * whole trace. This is the best substitute we have for a pre-normalization
 * tools[] snapshot — it only shows tools the LLM actually invoked, not every
 * tool the LLM was told about. See the design note surfaced in the viewer.
 */
export type ObservedTool = {
  toolName: string;
  callCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Field names observed across invocations (union of all param keys). */
  paramKeys: string[];
};

export type TraceSession = {
  status: TraceStatus;
  traceId: string;
  sessionKey: string;
  sessionId?: string;
  channel?: string;
  startedAt: string;
  endedAt?: string;
  turns: TurnRecord[];
  meta: TraceMeta;
  /** byte estimate of all phase data accumulated in memory */
  estimatedBytes: number;
  /** turn currently being assembled (not yet closed) */
  activeTurn: TurnRecord | null;
  /** toolName → ObservedTool, accumulated across the entire session */
  observedTools: Map<string, ObservedTool>;
};
