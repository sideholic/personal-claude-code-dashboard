import fs from 'node:fs';
import path from 'node:path';
import { agentInfo, type Card, type Column, type TimelineItem } from '@/lib/events';
import { fmArray, fmString, parseFrontmatter } from '@/lib/frontmatter';

// Read-only: build the board straight from the ticket folder (directory = status).
// This is the source of truth — the plugin moves files between tickets/<status>/
// on every transition, whereas events.jsonl can lag. The client polls this.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENTS_LOG =
  process.env.EVENTS_LOG ||
  path.resolve(process.cwd(), '../personal-claude-code-v2/.claude-team/events.jsonl');
const TEAM_ROOT = path.dirname(EVENTS_LOG);

// dir name (under tickets/) → board column
const DIR_TO_COLUMN: Record<string, Column> = {
  queue: 'queue',
  'in-progress': 'in-progress',
  'in-review': 'in-review',
  done: 'done',
  cancelled: 'cancelled',
  hold: 'in-progress', // paused work still belongs with active
};
// Historical columns can be huge — show only the most recent N (by id desc).
const RECENT_CAP: Partial<Record<Column, number>> = { done: 50, cancelled: 20 };
const FM_BYTES = 4096; // enough to cover frontmatter without reading whole bodies

// An in-progress card is "stale" if its last_activity_at is older than this.
// Override with STALE_HOURS (e.g. STALE_HOURS=4).
const STALE_HOURS = Number(process.env.STALE_HOURS) || 2;
const STALE_MS = STALE_HOURS * 3600_000;

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
type Priority = 'high' | 'medium' | 'low';
function normPriority(v: string | undefined): Priority {
  return v === 'high' || v === 'low' ? v : 'medium'; // missing/unknown = medium
}

/** Read just the leading chunk of a file (frontmatter lives at the top). */
function readHead(file: string, bytes = FM_BYTES): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const firstTs = (...vals: Array<string | undefined>) => vals.find((v) => !!v);

function buildTimeline(c: {
  createdTs: string;
  startedTs?: string;
  doneTs?: string;
  updatedTs: string;
  column: Column;
}): TimelineItem[] {
  const tl: TimelineItem[] = [];
  let seq = 0;
  const add = (ts: string | undefined, label: string, tone: TimelineItem['tone']) => {
    if (ts) tl.push({ seq: seq++, ts, event: 'fs', actor: '', label, tone });
  };
  add(c.createdTs, '생성 (queue)', 'info');
  if (c.startedTs && c.startedTs !== c.createdTs) add(c.startedTs, '작업 시작', 'active');
  const finishTs = c.doneTs || c.updatedTs;
  if (c.column === 'done') add(finishTs, '완료', 'good');
  else if (c.column === 'cancelled') add(finishTs, '취소', 'bad');
  else if (c.updatedTs !== c.createdTs && c.updatedTs !== c.startedTs)
    add(c.updatedTs, '마지막 업데이트', 'info');
  return tl;
}

function toCard(file: string, column: Column): Card | null {
  const mtime = fs.statSync(file).mtime.toISOString();
  const { frontmatter: fm } = parseFrontmatter(readHead(file));
  const id = fmString(fm.id) || path.basename(file).replace(/\.md$/, '');
  if (!id) return null;

  const assignee = fmString(fm.assignee);
  const target = fmString(fm.target);
  const agent = agentInfo(assignee, target);

  const createdTs = fmString(fm.created) || '';
  // Staleness clock: last_activity_at is canonical; last_update_at kept as a
  // fallback for old tickets. Also feeds updatedTs below.
  const lastActivityTs = fmString(fm.last_activity_at) || fmString(fm.last_update_at);
  const rawUpdated = fmString(fm.updated);
  // `done` frontmatter is the real completion stamp; fall back to file mtime.
  const doneFm = fmString(fm.done);
  const updatedTs =
    lastActivityTs ||
    (rawUpdated && rawUpdated !== createdTs ? rawUpdated : null) ||
    (column === 'done' || column === 'cancelled' ? mtime : createdTs);
  const startedTs = firstTs(fmString(fm.started), fmString(fm.claimed_at));
  const doneTs =
    column === 'done' || column === 'cancelled' ? doneFm || updatedTs : undefined;
  const active = column === 'in-progress';

  const priority = normPriority(fmString(fm.priority));
  const progressNote = fmString(fm.progress_note);
  const rescueCount = Number(fmString(fm.rescue_count)) || 0;
  const reviewRounds = Number(fmString(fm.review_rounds)) || 0;

  // Staleness only matters for active (in-progress) work.
  let stale: boolean | undefined;
  let stalenessUnknown: boolean | undefined;
  if (active) {
    if (lastActivityTs) {
      const ms = new Date(lastActivityTs).getTime();
      stale = Number.isFinite(ms) ? Date.now() - ms > STALE_MS : undefined;
      if (stale === undefined) stalenessUnknown = true;
    } else {
      stalenessUnknown = true; // no last_activity_at → unknown, not an error
    }
  }

  const prUrl = fmString(fm.pr_url) || fmString(fm.pr);
  const prNum = prUrl ? Number(prUrl.match(/(\d+)\s*$/)?.[1]) : NaN;

  return {
    id,
    title: fmString(fm.title) || id,
    column,
    squad: agent.squad,
    assignee: agent.skill ?? assignee,
    complexity: fmString(fm.complexity),
    feature: fmString(fm.parent_feature) || null,
    priority,
    progressNote: progressNote || undefined,
    rescueCount: rescueCount > 0 ? rescueCount : undefined,
    reviewRounds: reviewRounds > 0 ? reviewRounds : undefined,
    lastActivityTs,
    stale,
    stalenessUnknown,
    filesInScope: fmArray(fm.files_in_scope),
    dependsOn: fmArray(fm.depends_on),
    branch: fmString(fm.branch),
    pr: Number.isFinite(prNum) ? prNum : undefined,
    stages: [],
    createdTs,
    claimedTs: startedTs,
    doneTs,
    updatedTs,
    activeSkill: active ? agent.skill ?? assignee : undefined,
    activeAgentName: active ? agent.name : undefined,
    activeSince: active ? firstTs(startedTs, createdTs) : undefined,
    timeline: buildTimeline({ createdTs, startedTs, doneTs, updatedTs, column }),
  };
}

function scanColumn(dir: string, column: Column): { cards: Card[]; total: number } {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return { cards: [], total: 0 };
  }
  names.sort((a, b) => (a < b ? 1 : -1)); // id desc → newest first
  const total = names.length;
  const cap = RECENT_CAP[column];
  const slice = cap ? names.slice(0, cap) : names;
  const cards = slice
    .map((n) => {
      try {
        return toCard(path.join(dir, n), column);
      } catch {
        return null;
      }
    })
    .filter((c): c is Card => !!c);
  return { cards, total };
}

export function GET() {
  const ticketsDir = path.join(TEAM_ROOT, 'tickets');
  const cards: Card[] = [];
  const totals: Record<string, number> = {};

  for (const [dir, column] of Object.entries(DIR_TO_COLUMN)) {
    const { cards: cc, total } = scanColumn(path.join(ticketsDir, dir), column);
    cards.push(...cc);
    totals[dir] = total;
  }

  cards.sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first

  // Queue readiness: a dependency is satisfied only once it sits in `done`.
  // Resolve ids across every column (join by id), then sort queue by priority.
  const doneIds = new Set(cards.filter((c) => c.column === 'done').map((c) => c.id));
  for (const c of cards) {
    if (c.column !== 'queue') continue;
    const deps = c.dependsOn ?? [];
    c.ready = deps.every((d) => doneIds.has(d)); // no deps → ready
  }
  // priority high→medium→low, ready before blocked, then id desc (newest first)
  const queue = cards.filter((c) => c.column === 'queue');
  queue.sort((a, b) => {
    const pa = PRIORITY_RANK[normPriority(a.priority)];
    const pb = PRIORITY_RANK[normPriority(b.priority)];
    if (pa !== pb) return pa - pb;
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  });
  // re-emit cards with the queue in its sorted order (other columns unchanged)
  const others = cards.filter((c) => c.column !== 'queue');
  const ordered = [...queue, ...others];

  // Feature rollup: group every card by parent_feature; count done vs total.
  const featureMap = new Map<string, { feature: string; total: number; done: number }>();
  for (const c of cards) {
    const key = c.feature || 'standalone';
    const f = featureMap.get(key) ?? { feature: key, total: 0, done: 0 };
    f.total += 1;
    if (c.column === 'done') f.done += 1;
    featureMap.set(key, f);
  }
  const features = [...featureMap.values()].sort((a, b) => {
    if ((a.feature === 'standalone') !== (b.feature === 'standalone'))
      return a.feature === 'standalone' ? 1 : -1; // standalone last
    return b.total - a.total || (a.feature < b.feature ? -1 : 1);
  });

  return new Response(
    JSON.stringify({
      root: TEAM_ROOT,
      totals,
      count: ordered.length,
      cards: ordered,
      features,
      staleHours: STALE_HOURS,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
