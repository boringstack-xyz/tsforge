/**
 * Scoped terminal-output routing. The terminal is one resource, but N event
 * streams may write to it (the parent loop today; subagents from Phase B on).
 * Instead of a single undifferentiated text sink, every write is routed by the
 * emitting agent's id: a registered agent sink wins, else the parent sink
 * (the REPL's StatusBar region), else plain stdout. Replaces the old
 * module-level `interactiveStream` latch in cli/logging.ts.
 */

export type OutputSink = (text: string) => void;

export class OutputRouter {
  private parentSink: OutputSink | null = null;
  private readonly agentSinks = new Map<string, OutputSink>();
  /** Boot-time buffer. Non-null ⇒ every routed chunk is held here instead of
   *  reaching a sink. Nothing may land on the raw terminal before the pane
   *  console owns the screen: its first full paint clears, so anything printed
   *  during boot flickers once and is gone. */
  private capture: string[] | null = null;

  /** Install (or clear, with null) the parent stream sink — the REPL's
   *  StatusBar-aware writer. Headless/one-shot runs leave it null (stdout). */
  setParentSink(sink: OutputSink | null): void {
    this.parentSink = sink;
  }

  /** Start holding routed output instead of emitting it. Idempotent, so a
   *  second call can't discard what the first already captured. */
  beginCapture(): void {
    this.capture ??= [];
  }

  /** True while boot output is being held. */
  get capturing(): boolean {
    return this.capture !== null;
  }

  /** Stop holding and hand back everything captured, for the caller to seed
   *  into the pane's scrollback. Routing resumes normally afterwards. */
  endCapture(): string {
    const held = this.capture;

    this.capture = null;

    return held === null ? "" : held.join("");
  }

  /** Register a dedicated sink for one subagent's rendered output. */
  setAgentSink(agentId: string, sink: OutputSink): void {
    this.agentSinks.set(agentId, sink);
  }

  /** Remove a subagent's sink (its writes fall back to the parent sink). */
  clearAgentSink(agentId: string): void {
    this.agentSinks.delete(agentId);
  }

  /** Route one rendered chunk: capture → agent sink → parent sink → stdout. */
  route(text: string, agentId?: string): void {
    // Capture wins over every sink: during boot there is no screen to own yet,
    // and a subagent sink installed this early would paint into a frame the
    // pane console has not drawn.
    if (this.capture !== null) {
      this.capture.push(text);

      return;
    }

    if (agentId !== undefined) {
      const sink = this.agentSinks.get(agentId);

      if (sink !== undefined) {
        sink(text);

        return;
      }
    }

    if (this.parentSink !== null) {
      this.parentSink(text);

      return;
    }

    process.stdout.write(text);
  }
}
