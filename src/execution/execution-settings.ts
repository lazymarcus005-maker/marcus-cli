export interface ExecutionSettings {
  commandTimeoutMs: number;
  testBuildTimeoutMs: number;
  terminationGraceMs: number;
  maxOutputMemoryBytes: number;
  maxLogBytes: number;
  environmentAllowlist: string[];
}

export interface LogSettings {
  retentionDays: number;
  maxTotalBytes: number;
}

export const DEFAULT_EXECUTION_SETTINGS: Readonly<Omit<ExecutionSettings, "environmentAllowlist">> = Object.freeze({
  commandTimeoutMs: 120_000,
  testBuildTimeoutMs: 600_000,
  terminationGraceMs: 2_000,
  maxOutputMemoryBytes: 8 * 1024 * 1024,
  maxLogBytes: 100 * 1024 * 1024,
});

export const DEFAULT_ENVIRONMENT_ALLOWLIST = Object.freeze(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]);

export const EXECUTION_LIMIT_MAXIMUMS = Object.freeze({
  commandTimeoutSeconds: 600,
  testBuildTimeoutSeconds: 600,
  terminationGraceSeconds: 60,
  maxOutputMemoryBytes: 8 * 1024 * 1024,
  maxLogBytes: 100 * 1024 * 1024,
});

export const DEFAULT_LOG_SETTINGS: Readonly<LogSettings> = Object.freeze({
  retentionDays: 7,
  maxTotalBytes: 1024 * 1024 * 1024,
});

export const LOG_LIMIT_MAXIMUMS = Object.freeze({
  retentionDays: 7,
  maxTotalBytes: 1024 * 1024 * 1024,
});

export function defaultExecutionSettings(): ExecutionSettings {
  return { ...DEFAULT_EXECUTION_SETTINGS, environmentAllowlist: [...DEFAULT_ENVIRONMENT_ALLOWLIST] };
}

export function defaultLogSettings(): LogSettings {
  return { ...DEFAULT_LOG_SETTINGS };
}
