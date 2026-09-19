export type TestReportFormat = "junit" | "trx" | "node-json" | "unknown";
export interface TestExecutionObservation {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputComplete: boolean;
}
export interface TestEvidenceResult {
  status: "passed" | "failed" | "unknown";
  parserStatus: "parsed" | "failed";
  tests: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  snapshotDigest: string;
  stale: boolean;
  reason?: string;
}

function xmlAttributes(tag: string): Record<string, string> {
  return Object.fromEntries(Array.from(tag.matchAll(/([A-Za-z][\w:-]*)\s*=\s*["']([^"']*)["']/g), (match) => [match[1]!, match[2]!]));
}
function count(attrs: Record<string, string>, key: string): number | null {
  const value = attrs[key];
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isWellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  let roots = 0;
  let position = 0;
  while (position < xml.length) {
    const open = xml.indexOf("<", position);
    if (open < 0) return !xml.slice(position).trim() && stack.length === 0 && roots === 1;
    if (!stack.length && xml.slice(position, open).trim()) return false;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) return false;
      position = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) return false;
      position = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open) && stack.length) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) return false;
      position = end + 3;
      continue;
    }
    let close = open + 1;
    let quote = "";
    for (; close < xml.length; close++) {
      const character = xml[close]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (close === xml.length || quote) return false;
    const token = xml.slice(open, close + 1);
    const match = token.match(/^<(\/)?([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/);
    if (!match) return false;
    const closing = match[1] ?? "";
    const name = match[2];
    const rawAttributes = match[3] ?? "";
    const selfClosing = match[4] ?? "";
    if (!name) return false;
    if (closing) {
      if (rawAttributes.trim() || selfClosing || stack.pop() !== name) return false;
    } else {
      if (!stack.length && ++roots > 1) return false;
      let rest = rawAttributes;
      while (rest.trim()) {
        const attribute = rest.match(/^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"[^"<>]*"|'[^'<>]*')/);
        if (!attribute) return false;
        rest = rest.slice(attribute[0].length);
      }
      if (!selfClosing) stack.push(name);
    }
    position = close + 1;
  }
  return stack.length === 0 && roots === 1;
}

function parseXmlReport(format: "junit" | "trx", report: string): { tests: number; passed: number; failed: number; skipped: number } | undefined {
  if (!report.trim() || /<!DOCTYPE|<!ENTITY/i.test(report) || !isWellFormedXml(report)) return undefined;
  if (format === "junit") {
    const suiteTags = Array.from(report.matchAll(/<testsuite\b[^>]*>/g), (match) => xmlAttributes(match[0]));
    if (!suiteTags.length) return undefined;
    const values = suiteTags.map((attrs) => ({ tests: count(attrs, "tests"), failures: count(attrs, "failures"), errors: count(attrs, "errors"), skipped: count(attrs, "skipped") }));
    if (values.some((item) => item.tests === null || item.failures === null || item.errors === null)) return undefined;
    const tests = values.reduce((sum, item) => sum + item.tests!, 0);
    const failed = values.reduce((sum, item) => sum + item.failures! + item.errors!, 0);
    const skipped = values.reduce((sum, item) => sum + (item.skipped ?? 0), 0);
    return { tests, passed: Math.max(0, tests - failed - skipped), failed, skipped };
  }
  const summary = report.match(/<ResultSummary\b[^>]*>([\s\S]*?)<\/ResultSummary>/i);
  const counters = summary?.[1]?.match(/<Counters\b[^>]*\/?\s*>/i)?.[0];
  if (!counters) return undefined;
  const attrs = xmlAttributes(counters);
  const tests = count(attrs, "total");
  const failed = count(attrs, "failed");
  const passed = count(attrs, "passed");
  const skipped = count(attrs, "notExecuted");
  if (tests === null || failed === null || passed === null || skipped === null) return undefined;
  return { tests, passed, failed, skipped };
}

function parseNodeJson(report: string): { tests: number; passed: number; failed: number; skipped: number } | undefined {
  try {
    const parsed = JSON.parse(report) as { summary?: { counts?: { tests?: number; passed?: number; failed?: number; cancelled?: number; skipped?: number; todo?: number } } };
    const counts = parsed.summary?.counts;
    if (!counts || ![counts.tests, counts.passed, counts.failed].every((n) => Number.isSafeInteger(n) && n! >= 0)) return undefined;
    const skipped = (counts.skipped ?? 0) + (counts.todo ?? 0) + (counts.cancelled ?? 0);
    return { tests: counts.tests!, passed: counts.passed!, failed: counts.failed!, skipped };
  } catch { return undefined; }
}

export function evaluateTestEvidence(input: {
  format: TestReportFormat;
  report: string;
  execution: TestExecutionObservation;
  snapshotBefore: string;
  snapshotAfter: string;
  snapshotValid?: boolean;
  reportFresh?: boolean;
}): TestEvidenceResult {
  const parsed = input.format === "node-json" ? parseNodeJson(input.report) : input.format === "unknown" ? undefined : parseXmlReport(input.format, input.report);
  const stale = input.snapshotBefore !== input.snapshotAfter;
  const base = {
    parserStatus: parsed ? "parsed" as const : "failed" as const,
    tests: parsed?.tests ?? null,
    passed: parsed?.passed ?? null,
    failed: parsed?.failed ?? null,
    skipped: parsed?.skipped ?? null,
    snapshotDigest: input.snapshotBefore,
    stale,
  };
  if (input.reportFresh === false) return { ...base, status: "unknown", reason: "Test report was missing or unchanged from before this execution" };
  if (!parsed) return { ...base, status: "unknown", reason: input.format === "unknown" ? "Test runner or report format is unsupported; execution was recorded without a pass claim" : "Test report could not be parsed" };
  if (parsed.tests === 0) return { ...base, status: "unknown", reason: "No tests were discovered" };
  if (input.snapshotValid === false) return { ...base, status: "unknown", reason: "A trustworthy Git working snapshot is unavailable" };
  if (stale) return { ...base, status: "unknown", reason: "Workspace changed while tests were running; evidence is stale" };
  if (input.execution.cancelled || input.execution.timedOut || !input.execution.outputComplete || input.execution.exitCode === null) {
    return { ...base, status: "unknown", reason: "Execution was cancelled, timed out, incomplete, or had an unknown exit outcome" };
  }
  const failed = parsed.failed > 0 || input.execution.exitCode !== 0;
  return { ...base, status: failed ? "failed" : "passed", ...(failed ? { reason: "Test failures or non-zero command exit" } : {}) };
}
