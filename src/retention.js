// Remove expired chat text without retracting awards earned from it. The caller
// runs this periodically and after a session is closed.
export function expireChatText(app, now = Date.now()) {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const sessions = app.all('SELECT id FROM sessions WHERE end IS NOT NULL AND end<=?', cutoff);
  if (!sessions.length) return 0;
  const protectedIds = new Set(app.all('SELECT source_ids FROM stickers WHERE approved=1').flatMap(s => JSON.parse(s.source_ids)));
  let count = 0;
  for (const session of sessions) {
    for (const message of app.all('SELECT id FROM messages WHERE session_id=? AND text IS NOT NULL', session.id)) {
      if (!protectedIds.has(message.id)) { app.run('UPDATE messages SET text=NULL WHERE id=?', message.id); count++; }
    }
  }
  if (count) app.summary = '';
  return count;
}
