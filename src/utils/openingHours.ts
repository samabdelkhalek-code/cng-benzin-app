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
    const m = part.match(/^([A-Za-z,\-]+)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const days = m[1].split(',').flatMap((s) => expandDayRange(s.trim()));
    if (!days.length) continue;
    rules.push({ days, open: toMins(m[2]), close: toMins(m[3]) });
  }

  return rules.length ? rules : null;
}

export function isOpenNow(openingHours: string | null): boolean | null {
  if (!openingHours) return null;
  const rules = parseRules(openingHours);
  if (!rules) return null;

  const now = new Date();
  const dow = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();

  for (const rule of rules) {
    if (rule.days.includes(dow)) return mins >= rule.open && mins < rule.close;
  }
  return null;
}

export function fmtOpeningHours(oh: string | null): string | null {
  if (!oh) return null;
  if (/24\/7/i.test(oh)) return '24/7 geöffnet';
  return oh.replace(/;\s*/g, ' | ');
}
