// Time formatting shared by the popup, the blocked page and the toolbar badge.

const minutesLeft = (ms) => Math.max(0, Math.ceil(ms / 60000));

/** "4:30 PM", "midnight", "tomorrow 9:00 AM", "Tue 9:00 AM" */
export function formatClock(ts, now = new Date()) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.toDateString() === tomorrow.toDateString()) {
    return "midnight";
  }
  if (d.toDateString() === now.toDateString()) return time;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "12 min left", "1 h 5 min left", "4 h left" */
export function formatLeft(ms) {
  const mins = minutesLeft(ms);
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

/** Four characters or fewer, for the toolbar badge: "12m", "4h" */
export function badgeLeft(ms) {
  const mins = minutesLeft(ms);
  return mins < 60 ? `${mins}m` : `${Math.ceil(mins / 60)}h`;
}
