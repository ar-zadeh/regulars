import {randomBytes,timingSafeEqual} from 'node:crypto';
import {authorizationUrl, parseOAuthCallback, exchangeCode, refreshAccessToken, validateAccessToken} from './twitch.js';

// Twitch user tokens and refresh tokens stay in memory and only reach onToken.
// The caller must protect begin() with its local dashboard authorization and
// must not serialize the callback arguments into HTTP responses or logs.
export class TwitchOAuth {
  constructor({clientId,clientSecret,redirectUri,fetchImpl=fetch,now=()=>Date.now(),
    stateTtlMs=300000,refreshMarginMs=300000,requestTimeoutMs=10000,
    setTimer=setTimeout,clearTimer=clearTimeout,onToken=async()=>{},onStatus=()=>{}}={}) {
    if(typeof clientId!=='string' || !clientId.trim() || typeof clientSecret!=='string' || !clientSecret.trim()) throw new Error('Twitch application credentials are required');
    let redirect;try{redirect=new URL(redirectUri);}catch{throw new Error('A valid local Twitch redirect URI is required');}
    if(redirect.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(redirect.hostname) || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('A valid local Twitch redirect URI is required');
    if(typeof fetchImpl!=='function' || typeof onToken!=='function' || typeof onStatus!=='function' || ![stateTtlMs,refreshMarginMs,requestTimeoutMs].every(Number.isFinite) || stateTtlMs<=0 || refreshMarginMs<0 || requestTimeoutMs<=0) throw new Error('Invalid OAuth options');
    Object.assign(this,{clientId:clientId.trim(),clientSecret:clientSecret.trim(),redirectUri:redirect.href,fetchImpl,now,stateTtlMs,refreshMarginMs,requestTimeoutMs,setTimer,clearTimer,onToken,onStatus});
    this.pendingState=null;this.attempt=0;this.session=null;this.timer=null;this.timerEpoch=0;this.refreshing=null;this.installing=null;this.closed=false;
  }
  begin(){
    if(this.closed) throw new Error('OAuth helper is closed');
    this.installing?.controller.abort();
    const state=randomBytes(32).toString('hex');
    this.pendingState={state,expiresAt:this.now()+this.stateTtlMs,attempt:++this.attempt};
    return authorizationUrl({clientId:this.clientId,redirectUri:this.redirectUri,state});
  }
  async request(callback){
    const controller=new AbortController();let timer;
    const fetchImpl=(url,options={})=>this.fetchImpl(url,{...options,signal:controller.signal});
    try{
      return await Promise.race([callback(fetchImpl),new Promise((_,reject)=>{timer=this.setTimer(()=>{controller.abort();reject(new Error('Twitch authorization request timed out'));},this.requestTimeoutMs);timer.unref?.();})]);
    }finally{if(timer) this.clearTimer(timer);}
  }
  async complete(callbackUrl){
    if(this.closed) throw new Error('OAuth helper is closed');
    let url;try{url=new URL(callbackUrl,this.redirectUri);}catch{throw new Error('Invalid OAuth callback');}
    const redirect=new URL(this.redirectUri);
    if(url.origin!==redirect.origin || url.pathname!==redirect.pathname || url.username || url.password || url.hash) throw new Error('Invalid OAuth callback');
    const pending=this.pendingState;
    if(!pending || this.now()>=pending.expiresAt){this.pendingState=null;throw new Error('OAuth state expired or already used');}
    const actual=Buffer.from(url.searchParams.get('state') || ''),expected=Buffer.from(pending.state);
    if(url.searchParams.getAll('state').length!==1 || actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new Error('OAuth state mismatch');
    this.pendingState=null;
    if(url.searchParams.getAll('code').length>1 || url.searchParams.getAll('error').length>1) throw new Error('Invalid OAuth callback');
    const code=parseOAuthCallback(url.href,pending.state);
    const tokens=await this.request(fetchImpl=>exchangeCode({clientId:this.clientId,clientSecret:this.clientSecret,redirectUri:this.redirectUri,code,fetchImpl}));
    if(this.closed || pending.attempt!==this.attempt) throw new Error('OAuth attempt was superseded');
    const metadata=await this.validateTokens(tokens);
    if(this.closed || pending.attempt!==this.attempt) throw new Error('OAuth attempt was superseded');
    const session={accessToken:tokens.access_token,refreshToken:tokens.refresh_token,userId:metadata.user_id,login:metadata.login || '',expiresAt:this.now()+tokens.expires_in*1000};
    await this.install(session,'authorized');
    return {userId:session.userId,login:session.login,expiresAt:session.expiresAt};
  }
  async validateTokens(tokens,userId){
    if(typeof tokens?.access_token!=='string' || !tokens.access_token || typeof tokens.refresh_token!=='string' || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in<=0) throw new Error('Invalid Twitch token response');
    return this.request(fetchImpl=>validateAccessToken({accessToken:tokens.access_token,clientId:this.clientId,userId,fetchImpl}));
  }
  async install(session,state){
    if(this.closed) throw new Error('OAuth helper is closed');
    this.installing?.controller.abort();
    const prior=this.session,installing={controller:new AbortController()};this.session=session;this.installing=installing;
    try{await this.onToken({accessToken:session.accessToken,userId:session.userId,login:session.login,expiresAt:session.expiresAt,signal:installing.controller.signal});}
    catch{if(this.session===session)this.session=prior;throw new Error('Could not connect the Twitch account');}
    finally{if(this.installing===installing)this.installing=null;}
    if(this.closed || installing.controller.signal.aborted || this.session!==session){if(this.session===session)this.session=prior;throw new Error('OAuth session was superseded');}
    this.schedule();this.onStatus({state,userId:session.userId});
  }
  schedule(){
    if(this.timer) this.clearTimer(this.timer);this.timer=null;const epoch=++this.timerEpoch;
    if(this.closed || !this.session) return;
    const remaining=Math.max(1,this.session.expiresAt-this.now());
    const delay=Math.max(1,remaining-Math.min(this.refreshMarginMs,remaining/2));
    this.timer=this.setTimer(()=>{if(epoch!==this.timerEpoch || this.closed) return;this.timer=null;void this.refresh().catch(()=>{});},Math.min(delay,2147483647));
    this.timer.unref?.();
  }
  async refresh(){
    if(this.closed || !this.session) throw new Error('No Twitch authorization');
    const session=this.session;
    if(this.refreshing?.session===session) return this.refreshing.promise;
    const work=(async()=>{
      try{
        const tokens=await this.request(fetchImpl=>refreshAccessToken({clientId:this.clientId,clientSecret:this.clientSecret,refreshToken:session.refreshToken,fetchImpl}));
        const metadata=await this.validateTokens(tokens,session.userId);
        if(this.closed || this.session!==session) return;
        await this.install({accessToken:tokens.access_token,refreshToken:tokens.refresh_token,userId:metadata.user_id,login:metadata.login || session.login,expiresAt:this.now()+tokens.expires_in*1000},'refreshed');
      }catch{
        if(!this.closed && this.session===session){this.session=null;if(this.timer)this.clearTimer(this.timer);this.timer=null;this.onStatus({state:'reauthorize'});}
        throw new Error('Twitch authorization could not be refreshed');
      }
    })();
    const refreshing={session,promise:work};this.refreshing=refreshing;
    try{return await work;}finally{if(this.refreshing===refreshing)this.refreshing=null;}
  }
  disconnect(){
    this.attempt++;this.timerEpoch++;this.pendingState=null;this.session=null;this.refreshing=null;this.installing?.controller.abort();
    if(this.timer)this.clearTimer(this.timer);this.timer=null;
  }
  close(){if(this.closed)return;this.closed=true;this.disconnect();}
}
