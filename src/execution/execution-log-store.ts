import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_EXECUTION_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_READ_BYTES = 64 * 1024;

export interface ExecutionLogOptions {
  maxExecutionBytes?: number;
  maxTotalBytes?: number;
  retentionDays?: number;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function redact(value: string, secrets: string[]): string {
  let text = value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/(--?(?:api[-_]?key|token|secret|password)(?:=|\s+))[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/gi, "$1=[REDACTED]");
}

async function ensurePrivateDirectory(root: string, path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Execution log directories must not be symlinks");
  const actual = await realpath(path);
  if (!inside(root, actual)) throw new Error("Execution log directory escapes the repository root");
  await chmod(actual, 0o700);
}

interface LogFileInfo { path: string; size: number; mtimeMs: number }

export class ExecutionLogStore {
  private readonly maxExecutionBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionMs: number;
  private readonly active = new Set<string>();

  constructor(private readonly rootPath: string, options: ExecutionLogOptions = {}) {
    this.maxExecutionBytes = options.maxExecutionBytes ?? DEFAULT_MAX_EXECUTION_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    if (!Number.isSafeInteger(this.maxExecutionBytes) || this.maxExecutionBytes < 1 || this.maxExecutionBytes > DEFAULT_MAX_EXECUTION_BYTES) throw new Error("maxExecutionBytes is out of range");
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 1 || this.maxTotalBytes > DEFAULT_MAX_TOTAL_BYTES) throw new Error("maxTotalBytes is out of range");
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > DEFAULT_RETENTION_DAYS) throw new Error("retentionDays is out of range");
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  }

  private sessionDirectory(root: string, sessionId: string): string {
    const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return resolve(root, ".macus", "logs", sessionKey);
  }

  private async listLogFiles(logRoot: string): Promise<LogFileInfo[]> {
    const files: LogFileInfo[] = [];
    let sessionDirs;
    try { sessionDirs = await readdir(logRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return files; throw error; }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory() || sessionDir.isSymbolicLink()) continue;
      const directory = resolve(logRoot, sessionDir.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".log")) continue;
        const path = resolve(directory, entry.name);
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink()) files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    return files;
  }

  private async cleanup(root: string, logRoot: string): Promise<number> {
    const now = Date.now();
    const files = await this.listLogFiles(logRoot);
    for (const file of files) {
      if (!this.active.has(file.path) && now - file.mtimeMs > this.retentionMs) {
        await unlink(file.path).catch(() => undefined);
        file.size = 0;
      }
    }
    const current = files.filter((file) => file.size > 0).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    let total = current.reduce((sum, file) => sum + file.size, 0);
    for (const file of current) {
      if (total <= this.maxTotalBytes) break;
      if (this.active.has(file.path)) continue;
      await unlink(file.path).catch(() => undefined);
      total -= file.size;
    }
    return total;
  }

  async create(sessionId: string, executionId: string, secrets: string[] = []): Promise<ExecutionLogHandle> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) throw new Error("Invalid opaque execution log reference");
    const root = await realpath(this.rootPath);
    const macusDir = resolve(root, ".macus");
    const logsDir = resolve(macusDir, "logs");
    const directory = this.sessionDirectory(root, sessionId);
    await ensurePrivateDirectory(root, macusDir);
    await ensurePrivateDirectory(root, logsDir);
    await ensurePrivateDirectory(root, directory);
    const used = await this.cleanup(root, logsDir);
    const available = Math.min(this.maxExecutionBytes, this.maxTotalBytes - used);
    if (available < 1) throw new Error("Execution log aggregate retention limit is full");
    const path = resolve(directory, `${executionId}.log`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.active.add(path);
    return new ExecutionLogHandle(executionId, path, handle, available, secrets, () => { this.active.delete(path); });
  }

  async read(sessionId: string, executionId: string, startByte: number, maxBytes: number): Promise<{ text: string; nextByte: number | null; truncated: boolean }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) throw new Error("Invalid opaque execution log reference");
    if (!Number.isSafeInteger(startByte) || startByte < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) throw new Error(`read_log range must be between 1 and ${MAX_READ_BYTES} bytes`);
    const root = await realpath(this.rootPath);
    const path = resolve(this.sessionDirectory(root, sessionId), `${executionId}.log`);
    if (!inside(root, path)) throw new Error("Execution log reference is outside the authorized root");
    let file: FileHandle;
    try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Execution log is missing or expired");
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("Execution log reference is invalid");
      if (Date.now() - info.mtimeMs > this.retentionMs) {
        await file.close();
        await unlink(path).catch(() => undefined);
        throw new Error("Execution log is missing or expired");
      }
      if (startByte > info.size) throw new Error("read_log cursor exceeds the log size");
      const length = Math.min(maxBytes, info.size - startByte);
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, startByte);
      const nextByte = startByte + result.bytesRead;
      const truncated = nextByte < info.size;
      return { text: buffer.subarray(0, result.bytesRead).toString("utf8"), nextByte: truncated ? nextByte : null, truncated };
    } finally {
      await file.close().catch(() => undefined);
    }
  }
}

export class ExecutionLogHandle {
  private readonly decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  private readonly carry = { stdout: "", stderr: "" };
  private readonly secretHoldLength: number;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private finished = false;
  bytesWritten = 0;
  truncated = false;

  constructor(readonly logRef: string, private readonly path: string, private readonly handle: FileHandle, private readonly maxBytes: number, private readonly secrets: string[], private readonly onClose: () => void) {
    this.secretHoldLength = Math.max(64, ...secrets.map((secret) => secret.length));
  }

  get pendingBytes(): number { return this.queuedBytes; }

  append(stream: "stdout" | "stderr", chunk: Buffer): Promise<void> {
    if (this.finished) return Promise.reject(new Error("Execution log is already closed"));
    const decoded = this.decoders[stream].write(chunk);
    const combined = this.carry[stream] + decoded;
    const safeLength = Math.max(0, combined.length - this.secretHoldLength);
    const raw = combined.slice(0, safeLength);
    this.carry[stream] = combined.slice(safeLength);
    return this.enqueue(stream, raw);
  }

  private enqueue(stream: "stdout" | "stderr", raw: string): Promise<void> {
    if (!raw) return this.queue;
    let text = redact(raw, this.secrets);
    if (!text) return this.queue;
    const bytes = Buffer.from(`[${stream}] ${text}`, "utf8");
    this.queuedBytes += bytes.byteLength;
    this.queue = this.queue.then(async () => {
      this.queuedBytes -= bytes.byteLength;
      const remaining = this.maxBytes - this.bytesWritten;
      if (remaining <= 0) { this.truncated = true; return; }
      const bounded = bytes.subarray(0, remaining);
      let offset = 0;
      while (offset < bounded.byteLength) {
        const result = await this.handle.write(bounded, offset, bounded.byteLength - offset, null);
        if (!result.bytesWritten) throw new Error("Execution log write made no progress");
        offset += result.bytesWritten;
        this.bytesWritten += result.bytesWritten;
      }
      if (bounded.byteLength < bytes.byteLength) this.truncated = true;
    });
    return this.queue;
  }

  async finish(): Promise<void> {
    if (this.finished) return this.queue;
    for (const stream of ["stdout", "stderr"] as const) {
      const tail = this.carry[stream] + this.decoders[stream].end();
      this.carry[stream] = "";
      await this.enqueue(stream, tail);
    }
    this.finished = true;
    try { await this.queue; }
    finally {
      await this.handle.close();
      this.onClose();
    }
  }

  async abort(): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      await this.queue.catch(() => undefined);
      await this.handle.close().catch(() => undefined);
      this.onClose();
    }
    await unlink(this.path).catch(() => undefined);
  }
}
