import { createHash } from "node:crypto";

export type WorkingStatus = "ACTIVE" | "RELATED" | "DISCOVERED" | "STALE";
export type ContextTier = "HOT" | "WARM" | "COLD";
export interface ContextCandidate {
  path: string;
  sourceSha256: string | null;
  startLine: number;
  endLine: number;
  content: string;
  status: WorkingStatus;
  tier: ContextTier;
  reason: string;
  freshness: "verified" | "stale" | "unknown";
  lastAccessedAt: string;
  symbolId?: string;
}
export interface SelectedContextFragment extends ContextCandidate {
  fragmentId: string;
  estimatedTokens: number;
  score: number;
}
export interface ContextOmission {
  path: string;
  reason: "duplicate" | "stale" | "not-verified" | "budget" | "invalid-source" | "retained-history";
  detail: string;
}
export interface ContextSelection {
  included: SelectedContextFragment[];
  omitted: ContextOmission[];
  estimatedBytes: number;
}
export type ContextWorkflowStage = "discovery" | "implementation" | "failure";

function fragmentKey(candidate: ContextCandidate): string {
  return `${candidate.path}\0${candidate.sourceSha256}\0${candidate.startLine}\0${candidate.endLine}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TIER_RANK: Record<ContextTier, number> = { HOT: 3, WARM: 2, COLD: 1 };
const STATUS_RANK: Record<WorkingStatus, number> = { ACTIVE: 4, RELATED: 3, DISCOVERED: 2, STALE: 1 };

function compareCandidates(a: ContextCandidate, b: ContextCandidate): number {
  return compareText(fragmentKey(a), fragmentKey(b)) ||
    (TIER_RANK[b.tier] - TIER_RANK[a.tier]) ||
    (STATUS_RANK[b.status] - STATUS_RANK[a.status]) ||
    compareText(b.lastAccessedAt, a.lastAccessedAt) ||
    compareText(a.reason, b.reason) ||
    compareText(a.content, b.content);
}

function relevance(candidate: ContextCandidate, intent: string): number {
  const normalized = intent.toLowerCase();
  const exactPath = normalized.includes(candidate.path.toLowerCase()) ? 1000 : 0;
  const words = normalized.match(/[a-z0-9_./-]{3,}/g) ?? [];
  const terms = new Set(words);
  const pathTerms = candidate.path.toLowerCase().split(/[^a-z0-9_]+/).filter((part) => part.length >= 3);
  const pathOverlap = pathTerms.reduce((score, term) => score + (terms.has(term) ? 8 : 0), 0);
  const contentTerms = candidate.content.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const contentOverlap = [...new Set(contentTerms)].reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0);
  return exactPath + pathOverlap + Math.min(contentOverlap, 20);
}

function score(candidate: ContextCandidate, intent: string, newestAccess: number, stage: ContextWorkflowStage, relatedPaths: Set<string>): number {
  const tierScore: Record<ContextWorkflowStage, Record<ContextTier, number>> = {
    discovery: { HOT: 120, WARM: 150, COLD: 140 },
    implementation: { HOT: 300, WARM: 200, COLD: 100 },
    failure: { HOT: 240, WARM: 190, COLD: 130 },
  };
  const statusScore: Record<ContextWorkflowStage, Record<WorkingStatus, number>> = {
    discovery: { ACTIVE: 40, RELATED: 70, DISCOVERED: 0, STALE: 0 },
    implementation: { ACTIVE: 80, RELATED: 50, DISCOVERED: 0, STALE: 0 },
    failure: { ACTIVE: 70, RELATED: 60, DISCOVERED: 0, STALE: 0 },
  };
  const accessed = Date.parse(candidate.lastAccessedAt);
  const ageDays = Number.isFinite(accessed) ? Math.max(0, (newestAccess - accessed) / 86_400_000) : 30;
  const recency = Math.max(0, 30 - ageDays);
  const taskRelevance = relatedPaths.has(candidate.path) ? 400 : 0;
  const testRelevance = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$|_test\.[^.]+$/i.test(candidate.path) ? 150 : 0;
  const intentRelevance = relevance(candidate, intent) * (stage === "discovery" ? 1.5 : stage === "failure" ? 0.9 : 1);
  return tierScore[stage][candidate.tier] + statusScore[stage][candidate.status] + taskRelevance + (stage === "failure" ? testRelevance : 0) + intentRelevance + recency;
}

export function selectContextFragments(input: {
  candidates: ContextCandidate[];
  currentIntent: string;
  maxBytes: number;
  stage?: ContextWorkflowStage;
  relatedPaths?: string[];
}): ContextSelection {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) throw new Error("Context selection budget must be a non-negative integer");
  const omitted: ContextOmission[] = [];
  const eligible: ContextCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...input.candidates].sort(compareCandidates)) {
    if (candidate.freshness !== "verified" || candidate.status === "STALE") {
      omitted.push({ path: candidate.path, reason: "stale", detail: "Source freshness is not verified" });
      continue;
    }
    if (candidate.status === "DISCOVERED" || !candidate.sourceSha256) {
      omitted.push({ path: candidate.path, reason: "not-verified", detail: "Source has not been read and hash-verified" });
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(candidate.sourceSha256) || !Number.isSafeInteger(candidate.startLine) || candidate.startLine < 1 || candidate.endLine < candidate.startLine) {
      omitted.push({ path: candidate.path, reason: "invalid-source", detail: "Source identity or range is invalid" });
      continue;
    }
    const key = fragmentKey(candidate);
    if (seen.has(key)) {
      omitted.push({ path: candidate.path, reason: "duplicate", detail: "An identical source range is already selected" });
      continue;
    }
    seen.add(key);
    eligible.push(candidate);
  }

  const accessTimes = eligible.map((candidate) => Date.parse(candidate.lastAccessedAt)).filter(Number.isFinite);
  const newestAccess = accessTimes.length ? Math.max(...accessTimes) : 0;
  const stage = input.stage ?? "implementation";
  const relatedPaths = new Set((input.relatedPaths ?? []).map((path) => path.replaceAll("\\", "/")));
  const ranked = eligible.map((candidate) => ({ candidate, score: score(candidate, input.currentIntent, newestAccess, stage, relatedPaths) }))
    .sort((a, b) => b.score - a.score || compareText(a.candidate.path, b.candidate.path) || a.candidate.startLine - b.candidate.startLine || a.candidate.endLine - b.candidate.endLine || compareText(a.candidate.sourceSha256 ?? "", b.candidate.sourceSha256 ?? ""));
  const included: SelectedContextFragment[] = [];
  let estimatedBytes = 0;
  for (const { candidate, score: candidateScore } of ranked) {
    const estimatedTokens = Buffer.byteLength(candidate.content, "utf8");
    if (estimatedBytes + estimatedTokens > input.maxBytes) {
      omitted.push({ path: candidate.path, reason: "budget", detail: `Fragment needs ${estimatedTokens} estimated tokens; ${input.maxBytes - estimatedBytes} remain` });
      continue;
    }
    const fragmentId = createHash("sha256").update(fragmentKey(candidate)).digest("hex").slice(0, 24);
    included.push({ ...candidate, fragmentId, estimatedTokens, score: candidateScore });
    estimatedBytes += estimatedTokens;
  }
  return { included, omitted, estimatedBytes };
}
