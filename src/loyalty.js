// Compare award dates in the broadcaster's selected IANA time zone.
function localParts(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
}

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function qualifies(message) {
  return Boolean(message.viewer_id && !message.bot && !message.shared &&
    !message.broadcaster && message.moderation === 'cleared' &&
    message.organizer !== 'reaction' && !message.repetitionOnly &&
    !message.repetition_only && !message.command &&
    !message.text?.startsWith('!'));
}

function clockMinutes(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid Night Owl time');
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function computeLoyalty({messages, timeZone = 'UTC', dayOneDate, followDates = {}, previousDayOne = [], nightOwlStart = '00:00', nightOwlEnd = '05:00'}) {
  if (dayOneDate !== undefined && !validCalendarDate(dayOneDate)) throw new Error('Invalid Day One date');
  const start = clockMinutes(nightOwlStart), end = clockMinutes(nightOwlEnd);
  if (start === end) throw new Error('Night Owl start and end must differ');
  const earned = new Set(previousDayOne);
  const grouped = new Map();
  for (const message of messages) {
    if (!qualifies(message)) continue;
    const rows = grouped.get(message.viewer_id) || [];
    rows.push(message);
    grouped.set(message.viewer_id, rows);
  }

  const awards = [];
  for (const [viewerId, rows] of grouped) {
    rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp) || String(a.id).localeCompare(String(b.id)));
    const night = rows.find(message => {
      const {hour, minute} = localParts(message.timestamp, timeZone);
      const time = Number(hour) * 60 + Number(minute);
      return start < end ? time >= start && time < end : time >= start || time < end;
    });
    if (night) awards.push({title: 'Night Owl', viewerId, evidence: [night.id]});

    if (dayOneDate && !earned.has(viewerId) && followDates[viewerId]) {
      const {year, month, day} = localParts(followDates[viewerId], timeZone);
      if (`${year}-${month}-${day}` <= dayOneDate) {
        awards.push({title: 'Day One', viewerId, evidence: [rows[0].id]});
      }
    }
  }
  return awards;
}
