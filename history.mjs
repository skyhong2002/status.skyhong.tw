const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_BINS = 48;

// Rolling 24-hour history, kept as raw {t, up} points per monitor for persistence,
// but published to the browser only as a fixed 48-bin summary: the raw form is
// ~1,440 points per monitor and dwarfed the rest of the status payload.
export function recordHistory(history, items, now = Date.now(), maxPoints = 24 * 60) {
  for (const item of items) {
    const points = history[item.id] || [];
    points.push({ t: now, up: item.up });
    history[item.id] = points.filter((point) => point.t > now - DAY_MS).slice(-maxPoints);
  }
  return history;
}

// Drop monitors that have not produced a point in 24 hours, so renamed or retired
// ids do not accumulate forever in the persisted file.
export function pruneHistory(history, now = Date.now()) {
  for (const [id, points] of Object.entries(history)) {
    if (!points.some((point) => point.t > now - DAY_MS)) delete history[id];
  }
  return history;
}

export function summarizeHistory(history, now = Date.now(), bins = HISTORY_BINS) {
  const start = now - DAY_MS;
  const summary = {};
  for (const [id, allPoints] of Object.entries(history)) {
    const points = allPoints.filter((point) => point.t >= start && point.t <= now);
    if (!points.length) continue;
    // 0 = no data, 1 = all up, 2 = at least one failure, encoded as a compact string.
    const states = new Array(bins).fill(0);
    let up = 0;
    for (const point of points) {
      const index = Math.min(bins - 1, Math.max(0, Math.floor(((point.t - start) / DAY_MS) * bins)));
      if (point.up) up += 1;
      states[index] = point.up ? Math.max(states[index], 1) : 2;
    }
    summary[id] = { bars: states.join(''), uptime: (up / points.length) * 100, checks: points.length };
  }
  return summary;
}
