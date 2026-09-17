/**
 * Cycle commit message from the _commits manifest — the label source is the
 * attributed _history edit-event rollup (manifest lines carry pre-rolled
 * summaries), NOT the frontmatter provenance records; ADR-0006 wording carried
 * from the pre-M4 riders. Mirror of server/commits.ts summaryLine — keep in
 * lockstep.
 */
import { existsSync, readFileSync } from 'fs';

export function cycleMessage(
  commitsPath: string,
  fromTs: number,
  untilTs: number,
  stamp: { at: string; sessionId: string; model: string },
): string {
  const byActor: Record<string, { added: number; edited: number; removed: number }> = {};
  if (existsSync(commitsPath)) {
    for (const line of readFileSync(commitsPath, 'utf-8').split('\n')) {
      if (!line) continue;
      let c: any;
      try { c = JSON.parse(line); } catch { continue; }
      if (!c || typeof c.ts !== 'number' || c.ts <= fromTs || c.ts > untilTs) continue;
      for (const [actor, t] of Object.entries(c.summary?.byActor ?? {}) as [string, any][]) {
        const tally = byActor[actor] ?? { added: 0, edited: 0, removed: 0 };
        tally.added += t.added ?? 0;
        tally.edited += t.edited ?? 0;
        tally.removed += t.removed ?? 0;
        byActor[actor] = tally;
      }
    }
  }
  const line = summaryLine(byActor);
  const head = line ? `article: ${line}` : 'article: submitted';
  return `${head} — session ${stamp.sessionId} (${stamp.model}), submitted ${stamp.at}`;
}

function summaryLine(byActor: Record<string, { added: number; edited: number; removed: number }>): string {
  const parts: string[] = [];
  for (const actor of Object.keys(byActor)) {
    const t = byActor[actor];
    const bits: string[] = [];
    if (t.added) bits.push(`+${t.added}`);
    if (t.edited) bits.push(`~${t.edited}`);
    if (t.removed) bits.push(`-${t.removed}`);
    if (bits.length) parts.push(`${bits.join(' ')} ${actor === 'human' ? 'you' : actor}`);
  }
  return parts.join(' · ');
}
