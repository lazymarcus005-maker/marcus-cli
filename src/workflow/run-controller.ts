import { createHash, randomUUID } from "node:crypto";

export interface RunLimits {
  maxModelTurns: number;
  maxNoProgressAttempts: number;
  maxDurationSeconds: number;
}

/** Per-prompt safety controller; it stops only at provider/tool boundaries. */
export class RunController {
  readonly runId = randomUUID();
  private modelTurns = 0;
  private repeatedFailures = 0;
  private previousFailure: string | undefined;
  private stoppedFor: string | undefined;
  private finalStatus: "completed" | "failed" | "cancelled" | "paused" = "completed";
  private readonly startedAt = Date.now();

  constructor(private readonly limits: RunLimits) {
    for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Run limit ${name} must be a positive integer`);
  }

  assistantTurnEnded(): void {
    this.modelTurns++;
  }

  toolCompleted(input: { name: string; isError: boolean; result: unknown }): void {
    if (!input.isError) {
      this.repeatedFailures = 0;
      this.previousFailure = undefined;
      return;
    }
    const serialized = JSON.stringify(input.result) ?? "unknown tool failure";
    const normalized = serialized.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>").replace(/\b\d{4}-\d\d-\d\dT[^\s"\\]+/g, "<time>");
    const fingerprint = createHash("sha256").update(input.name).update("\0").update(normalized).digest("hex");
    this.repeatedFailures = fingerprint === this.previousFailure ? this.repeatedFailures + 1 : 1;
    this.previousFailure = fingerprint;
    if (this.repeatedFailures >= this.limits.maxNoProgressAttempts) {
      this.stoppedFor = `Repeated identical tool failure (${this.repeatedFailures} attempts)`;
      this.finalStatus = "paused";
    }
  }

  beforeModelRequest(): boolean {
    if (this.stoppedFor) return false;
    if (Date.now() - this.startedAt >= this.limits.maxDurationSeconds * 1000) {
      this.stoppedFor = `Run duration limit reached (${this.limits.maxDurationSeconds}s)`;
      this.finalStatus = "paused";
      return false;
    }
    if (this.modelTurns >= this.limits.maxModelTurns) {
      this.stoppedFor = `Model-turn limit reached (${this.limits.maxModelTurns})`;
      this.finalStatus = "paused";
      return false;
    }
    return true;
  }

  timedOut(): void {
    this.stoppedFor = `Run duration limit reached (${this.limits.maxDurationSeconds}s)`;
    this.finalStatus = "paused";
  }

  cancel(): void { this.stoppedFor = "Run cancelled by user"; this.finalStatus = "cancelled"; }
  fail(): void { if (this.finalStatus === "completed") this.finalStatus = "failed"; }

  get stopReason(): string | undefined { return this.stoppedFor; }
  get turns(): number { return this.modelTurns; }
  get status(): "completed" | "failed" | "cancelled" | "paused" { return this.finalStatus; }
}
