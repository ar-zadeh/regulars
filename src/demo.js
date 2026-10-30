// Only seed an empty channel database. The caller supplies the database.
export const DEMO_PERSONAS=['Ana','Ben','Cy','Dee','Sam','Rae','Eli','Fay','Gio','Hana','Ivo','Jules'];
export function seedDemo(app,now=Date.now()) {
  const channelTables=['sessions','viewers','events','messages','rules','subjects','nudges','stickers','awards','first_messages','moderation_actions'];
  if(channelTables.some(table=>app.one(`SELECT 1 FROM ${table} LIMIT 1`))) return false;
  const subject='demo-history-subject';
  app.run('INSERT INTO subjects(id,name,description,last_active) VALUES (?,?,?,?)',subject,'Bridge jump','A playful discussion about a bridge jump.',new Date(now-86400000).toISOString());
  for(let i=0;i<6;i++){
    const start=now-(6-i)*86400000,session=app.startSession(new Date(start).toISOString());
    for(const name of DEMO_PERSONAS){
      if(name==='Rae' && i>=3) continue;
      app.sight({id:`demo-${name}`,name},session,{nudge:false});
    }
    for(let j=0;j<50;j++){
      const names=DEMO_PERSONAS.filter(name=>name!=='Sam' && !(name==='Rae' && i>=3));
      const name=names[j%names.length],timestamp=new Date(start+j*10000).toISOString();
      app.run("INSERT INTO messages(id,session_id,viewer_id,name,timestamp,text,moderation,organizer,category,subject_id) VALUES (?,?,?,?,?,?,'cleared','assigned','other',?)",`history-${i}-${j}`,session.id,`demo-${name}`,name,timestamp,'The bridge jump was a fun moment.',subject);
    }
    app.run('UPDATE sessions SET end=? WHERE id=?',new Date(start+3600000).toISOString(),session.id);
  }
  return true;
}
