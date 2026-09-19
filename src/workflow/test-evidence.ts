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

interface ParsedTestCounts {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  complete?: boolean;
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

function isValidXmlCharacter(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function hasValidXmlCharacters(value: string): boolean {
  return [...value].every((character) => isValidXmlCharacter(character.codePointAt(0)!));
}

function hasValidXmlData(value: string): boolean {
  for (let position = 0; position < value.length; position++) {
    const codePoint = value.codePointAt(position)!;
    if (!isValidXmlCharacter(codePoint)) return false;
    if (codePoint > 0xffff) position++;
    if (value[position] !== "&") continue;
    const entity = value.slice(position).match(/^&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/);
    if (!entity) return false;
    if (entity[0].startsWith("&#")) {
      const numeric = entity[0][2] === "x"
        ? Number.parseInt(entity[0].slice(3, -1), 16)
        : Number.parseInt(entity[0].slice(2, -1), 10);
      if (!Number.isSafeInteger(numeric) || !isValidXmlCharacter(numeric)) return false;
    }
    position += entity[0].length - 1;
  }
  return true;
}

function searchableXml(xml: string, allowedRootNames: readonly string[]): string | undefined {
  const stack: string[] = [];
  const visible: string[] = [];
  let roots = 0;
  let rootName: string | undefined;
  let position = 0;
  let xmlDeclarationSeen = false;
  while (position < xml.length) {
    const open = xml.indexOf("<", position);
    if (open < 0) {
      const trailing = xml.slice(position);
      if (trailing.trim() || stack.length !== 0 || roots !== 1 || !rootName || !allowedRootNames.includes(rootName)) return undefined;
      visible.push(trailing);
      return visible.join("");
    }
    const text = xml.slice(position, open);
    if ((!stack.length && text.trim()) || text.includes("]]>") || !hasValidXmlData(text)) return undefined;
    visible.push(text);
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) return undefined;
      const content = xml.slice(open + 4, end);
      if (content.includes("--") || content.endsWith("-") || !hasValidXmlCharacters(content)) return undefined;
      position = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) return undefined;
      const content = xml.slice(open + 2, end);
      const instruction = content.match(/^([A-Za-z_][\w:.-]*)(?:\s+[\s\S]*)?$/);
      if (!instruction || !hasValidXmlCharacters(content)) return undefined;
      if (instruction[1]!.toLowerCase() === "xml") {
        const startsDocument = open === 0 || (open === 1 && xml[0] === "\uFEFF");
        const declaration = /^xml\s+version=(['"])1\.0\1(?:\s+encoding=(['"])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone=(['"])(?:yes|no)\3)?$/;
        if (instruction[1] !== "xml" || !startsDocument || xmlDeclarationSeen || !declaration.test(content)) return undefined;
        xmlDeclarationSeen = true;
      }
      position = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open) && stack.length) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) return undefined;
      if (!hasValidXmlCharacters(xml.slice(open + 9, end))) return undefined;
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
    if (close === xml.length || quote) return undefined;
    const token = xml.slice(open, close + 1);
    const match = token.match(/^<(\/)?([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/);
    if (!match) return undefined;
    const closing = match[1] ?? "";
    const name = match[2];
    const rawAttributes = match[3] ?? "";
    const selfClosing = match[4] ?? "";
    if (!name || !hasValidXmlData(rawAttributes)) return undefined;
    if (closing) {
      if (rawAttributes.trim() || selfClosing || stack.pop() !== name) return undefined;
    } else {
      if (!stack.length) {
        if (++roots > 1) return undefined;
        rootName = name;
      }
      let rest = rawAttributes;
      const attributeNames = new Set<string>();
      while (rest.trim()) {
        const attribute = rest.match(/^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"[^"<>]*"|'[^'<>]*')/);
        const attributeName = attribute?.[1];
        if (!attribute || !attributeName || attributeNames.has(attributeName)) return undefined;
        attributeNames.add(attributeName);
        rest = rest.slice(attribute[0].length);
      }
      if (!selfClosing) stack.push(name);
    }
    visible.push(token);
    position = close + 1;
  }
  return stack.length === 0 && roots === 1 && rootName !== undefined && allowedRootNames.includes(rootName)
    ? visible.join("")
    : undefined;
}

function parseXmlReport(format: "junit" | "trx", report: string): ParsedTestCounts | undefined {
  const allowedRootNames = format === "junit" ? ["testsuite", "testsuites"] : ["TestRun"];
  const searchable = !/<!DOCTYPE|<!ENTITY/i.test(report) ? searchableXml(report, allowedRootNames) : undefined;
  if (!report.trim() || !searchable) return undefined;
  if (format === "junit") {
    const suiteTags = Array.from(searchable.matchAll(/<testsuite\b[^>]*>/g), (match) => xmlAttributes(match[0]));
    if (!suiteTags.length) return undefined;
    const values = suiteTags.map((attrs) => ({ tests: count(attrs, "tests"), failures: count(attrs, "failures"), errors: count(attrs, "errors"), skipped: count(attrs, "skipped") }));
    if (values.some((item) => item.tests === null || item.failures === null || item.errors === null)) return undefined;
    const tests = values.reduce((sum, item) => sum + item.tests!, 0);
    const failed = values.reduce((sum, item) => sum + item.failures! + item.errors!, 0);
    const skipped = values.reduce((sum, item) => sum + (item.skipped ?? 0), 0);
    return { tests, passed: Math.max(0, tests - failed - skipped), failed, skipped };
  }
  const summaries = [...searchable.matchAll(/<ResultSummary\b([^>]*)>([\s\S]*?)<\/ResultSummary>/g)];
  if (summaries.length !== 1) return undefined;
  const summaryTag = `<ResultSummary ${summaries[0]![1]}>`;
  const counters = [...summaries[0]![2]!.matchAll(/<Counters\b[^>]*\/?\s*>/g)];
  if (counters.length !== 1) return undefined;
  const attrs = xmlAttributes(counters[0]![0]);
  const outcome = xmlAttributes(summaryTag).outcome;
  const counterNames = ["total", "executed", "passed", "failed", "error", "timeout", "aborted", "inconclusive", "passedButRunAborted", "notRunnable", "notExecuted", "disconnected", "inProgress", "pending"] as const;
  const values = Object.fromEntries(counterNames.map((name) => [name, count(attrs, name)])) as Record<typeof counterNames[number], number | null>;
  if (counterNames.some((name) => values[name] === null)) return undefined;
  const tests = values.total!;
  const passed = values.passed!;
  const failed = values.failed! + values.error! + values.timeout!;
  const skipped = values.notExecuted! + values.inconclusive!;
  const outcomeTotal = passed + values.failed! + values.error! + values.timeout! + values.aborted! + values.inconclusive! + values.passedButRunAborted! + values.notRunnable! + values.notExecuted! + values.disconnected!;
  const completedTestOutcomes = passed + values.failed! + values.error! + values.timeout!;
  const unsupportedOutcome = outcome !== "Completed" && outcome !== "Failed";
  const incompleteCounters = outcomeTotal !== tests || values.executed! !== completedTestOutcomes || values.aborted! > 0 || values.inconclusive! > 0 || values.passedButRunAborted! > 0 || values.notRunnable! > 0 || values.disconnected! > 0 || values.inProgress! > 0 || values.pending! > 0;
  const contradictoryOutcome = outcome === "Failed" && failed === 0;
  return { tests, passed, failed, skipped, complete: !unsupportedOutcome && !incompleteCounters && !contradictoryOutcome };
}

function parseNodeJson(report: string): ParsedTestCounts | undefined {
  try {
    const parsed = JSON.parse(report) as { summary?: { counts?: { tests?: number; passed?: number; failed?: number; cancelled?: number; skipped?: number; todo?: number } } };
    const counts = parsed.summary?.counts;
    if (!counts || ![counts.tests, counts.passed, counts.failed].every((n) => Number.isSafeInteger(n) && n! >= 0)) return undefined;
    const optionalCounts = [counts.skipped, counts.todo, counts.cancelled];
    if (optionalCounts.some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) return undefined;
    const skipped = (counts.skipped ?? 0) + (counts.todo ?? 0) + (counts.cancelled ?? 0);
    const outcomes = counts.passed! + counts.failed! + skipped;
    if (!Number.isSafeInteger(outcomes) || outcomes !== counts.tests) return undefined;
    return { tests: counts.tests!, passed: counts.passed!, failed: counts.failed!, skipped, complete: (counts.cancelled ?? 0) === 0 };
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
  if (parsed.complete === false) return { ...base, status: "unknown", reason: "Test report contains incomplete or contradictory counters or outcomes" };
  if (parsed.tests === 0) return { ...base, status: "unknown", reason: "No tests were discovered" };
  if (parsed.passed === 0 && parsed.failed === 0) return { ...base, status: "unknown", reason: "No test completed with a pass or failure result" };
  if (input.snapshotValid === false) return { ...base, status: "unknown", reason: "A trustworthy Git working snapshot is unavailable" };
  if (stale) return { ...base, status: "unknown", reason: "Workspace changed while tests were running; evidence is stale" };
  if (input.execution.cancelled || input.execution.timedOut || !input.execution.outputComplete || input.execution.exitCode === null) {
    return { ...base, status: "unknown", reason: "Execution was cancelled, timed out, incomplete, or had an unknown exit outcome" };
  }
  const failed = parsed.failed > 0 || input.execution.exitCode !== 0;
  return { ...base, status: failed ? "failed" : "passed", ...(failed ? { reason: "Test failures or non-zero command exit" } : {}) };
}
