const DAY_IDX: Record<string, number> = {
  Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 0,
};

function expandDayRange(seg: string): number[] {
  if (seg.includes('-')) {
    const [from, to] = seg.split('-');
    const start = DAY_IDX[from];
    const end = DAY_IDX[to];
    if (start == null || end == null) return [];
    const days: number[] = [];
    let d = start;
    for (let i = 0; i < 8; i++) {
      days.push(d);
      if (d === end) break;
      d = d === 6 ? 0 : d + 1;
    }
    return days;
  }
  const d = DAY_IDX[seg];
  return d != null ? [d] : [];
}

function toMins(t: string): number {
  const [h, m = '0'] = t.split(':');
  return Number(h) * 60 + Number(m);
}

interface Rule { days: number[]; open: number; close: number }

function parseRules(oh: string): Rule[] | null {
  if (!oh.trim()) return null;
  if (/24\/7/i.test(oh)) return [{ days: [0, 1, 2, 3, 4, 5, 6], open: 0, close: 24 * 60 }];

  const rules: Rule[] = [];
  for (const part of oh.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z,\-]+)\s+(.+)$/);
    if (!m) continue;
    const days = m[1].split(',').flatMap((s) => expandDayRange(s.trim()));
    if (!days.length) continue;
    // A segment may carry several spans, e.g. "Mo-Fr 08:00-12:00,14:00-18:00"
    for (const span of m[2].split(',')) {
      const t = span.trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      if (!t) continue;
      rules.push({ days, open: toMins(t[1]), close: toMins(t[2]) });
    }
  }

  return rules.length ? rules : null;
}

/** `now` is injectable so the clock-dependent branches stay testable. */
export function isOpenNow(openingHours: string | null, now: Date = new Date()): boolean | null {
  if (!openingHours) return null;
  const rules = parseRules(openingHours);
  if (!rules) return null;

  const dow = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const prevDow = dow === 0 ? 6 : dow - 1;

  // Check every rule: a day can carry several spans (e.g. a lunch break), so we
  // may only answer "closed" after none of them matched.
  let dayCovered = false;
  for (const rule of rules) {
    const overnight = rule.close <= rule.open;
    if (overnight && rule.days.includes(prevDow) && mins < rule.close) return true;
    if (!rule.days.includes(dow)) continue;
    dayCovered = true;
    if (overnight ? mins >= rule.open : mins >= rule.open && mins < rule.close) return true;
  }
  // No rule mentions today: the string may be only partially parsed, so we say
  // "unknown" rather than wrongly badging the station as closed.
  return dayCovered ? false : null;
}

export function fmtOpeningHours(oh: string | null): string | null {
  if (!oh) return null;
  if (/24\/7/i.test(oh)) return '24/7 geöffnet';
  return oh.replace(/;\s*/g, ' | ');
}
