export const DEFAULT_SETTINGS=Object.freeze({
  regularMode:'rolling',regularMinimum:3,regularWindow:5,
  returnMinPrevious:2,returnMissedSessions:3,repetitionWindowSeconds:10,discussionGapSeconds:60,
  hypeMinContributors:3,hypeMaxContributors:10,nightOwlStart:'00:00',nightOwlEnd:'05:00',
  nudgeCooldownSeconds:60,maxOpenNudges:3,messageNudgeExpirySeconds:180,arrivalNudgeExpirySeconds:600,
  matchThreshold:0.7,maybeThreshold:0.3,summaryIntervalSeconds:10,summaryWindowSeconds:30,chatterPollSeconds:30,
  stickerViewerCooldownSeconds:60,stickerChannelCooldownSeconds:10,
});
const ranges={
  regularMinimum:[1,100],regularWindow:[1,100],returnMinPrevious:[1,100],returnMissedSessions:[1,100],
  repetitionWindowSeconds:[1,120],discussionGapSeconds:[1,3600],hypeMinContributors:[2,100],hypeMaxContributors:[1,50],
  nudgeCooldownSeconds:[0,3600],maxOpenNudges:[1,20],messageNudgeExpirySeconds:[1,3600],arrivalNudgeExpirySeconds:[1,86400],
  matchThreshold:[0,1],maybeThreshold:[0,1],summaryIntervalSeconds:[1,300],summaryWindowSeconds:[1,3600],
  chatterPollSeconds:[10,300],stickerViewerCooldownSeconds:[0,3600],stickerChannelCooldownSeconds:[0,3600],
};
const scoreFields=new Set(['matchThreshold','maybeThreshold']);
export function validateSettings(patch,base=DEFAULT_SETTINGS){
  if(!patch || typeof patch!=='object' || Array.isArray(patch)) throw new Error('Settings must be an object.');
  for(const key of Object.keys(patch)) if(!Object.hasOwn(DEFAULT_SETTINGS,key)) throw new Error(`Unknown setting: ${key}.`);
  const settings={...base,...patch};
  if(!['rolling','consecutive'].includes(settings.regularMode)) throw new Error('regularMode must be rolling or consecutive.');
  for(const [key,[min,max]] of Object.entries(ranges)){
    const value=settings[key];
    if(typeof value!=='number' || !Number.isFinite(value) || (!scoreFields.has(key) && !Number.isInteger(value)) || value<min || value>max)
      throw new Error(`${key} must be ${scoreFields.has(key)?'a number':'an integer'} between ${min} and ${max}.`);
  }
  for(const key of ['nightOwlStart','nightOwlEnd']) if(typeof settings[key]!=='string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings[key])) throw new Error(`${key} must be a time in HH:mm format.`);
  if(settings.nightOwlStart===settings.nightOwlEnd) throw new Error('Night owl start and end must differ.');
  if(settings.regularMode==='rolling' && settings.regularMinimum>settings.regularWindow) throw new Error('regularMinimum cannot exceed regularWindow in rolling mode.');
  if(settings.maybeThreshold>=settings.matchThreshold) throw new Error('maybeThreshold must be less than matchThreshold.');
  return settings;
}
const SETTINGS_KEY='dashboardConfig';
export function readSettings(db){
  const row=db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY);
  if(!row) return {...DEFAULT_SETTINGS};
  try{return validateSettings(JSON.parse(row.value));}catch{return {...DEFAULT_SETTINGS};}
}
export function writeSettings(db,settings){
  const validated=validateSettings(settings);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SETTINGS_KEY,JSON.stringify(validated));
  return validated;
}
