export const DEFAULT_BOT_NAMES=Object.freeze(['nightbot','streamelements','streamlabs','moobot','commanderroot','sery_bot']);
const bots=new Set(DEFAULT_BOT_NAMES);
export const isKnownBot=(login,name)=>[login,name].some(value=>bots.has(String(value || '').trim().toLowerCase()));
