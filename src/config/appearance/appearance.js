import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Joi from 'joi';

const hex=Joi.string().pattern(/^#[0-9a-fA-F]{6}$/);
const colorNames=['primary','primaryHover','button','buttonHover','background','surface','text','muted','border','soft','header','headerText','sidebar','sidebarText','sidebarMuted','sidebarActive','sidebarActiveText'];
const colors=Joi.object(Object.fromEntries(colorNames.map(key=>[key,hex]))).unknown(false);
const typography=Joi.object({bodyFont:Joi.string().valid('manrope','dmSans','system'),headingFont:Joi.string().valid('manrope','dmSans','system'),fontSize:Joi.number().min(14).max(20),fontStyle:Joi.string().valid('normal','italic'),lineHeight:Joi.number().min(1.3).max(2),bodyWeight:Joi.number().valid(400,500,600,700),headingWeight:Joi.number().valid(400,500,600,700,800)}).unknown(false);
const layer=Joi.object({mode:Joi.string().valid('light','dark','system'),typography,effects:Joi.object({cornerScale:Joi.number().min(0).max(2),shadow:Joi.string().valid('existing','none','soft','medium')}).unknown(false),colors:Joi.object({light:colors,dark:colors}).unknown(false)}).unknown(false);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const schema=Joi.object({schemaVersion:Joi.number().valid(1).required(),defaults:Joi.object({admin:layer.required(),storefront:layer.required()}).required().unknown(false),tenants:Joi.object().pattern(uuid,Joi.object({label:Joi.string().max(190),admin:layer,storefront:layer,stores:Joi.object().pattern(uuid,Joi.object({label:Joi.string().max(190),storefront:layer}).unknown(false))}).unknown(false)).required()}).unknown(false);
const raw=JSON.parse(readFileSync(new URL('./themes.json',import.meta.url),'utf8'));
const checked=schema.validate(raw,{abortEarly:false});
if(checked.error)throw new Error(`Invalid appearance/themes.json: ${checked.error.details.map(detail=>detail.path.join('.')+': '+detail.message).join('; ')}`);
const configuration=checked.value;

function luminance(hex){const rgb=hex.slice(1).match(/../g).map(c=>{const v=parseInt(c,16)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a,b){const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (values[0]+.05)/(values[1]+.05);}
const onColor=hex=>contrast(hex,'#000000')>=contrast(hex,'#ffffff')?'#000000':'#ffffff';
const rgba=(hex,alpha)=>`rgba(${hex.slice(1).match(/../g).map(v=>parseInt(v,16)).join(',')},${alpha})`;
const mix=(a,b,amount)=>'#'+a.slice(1).match(/../g).map((v,i)=>Math.round(parseInt(v,16)*(1-amount)+parseInt(b.slice(1+i*2,3+i*2),16)*amount).toString(16).padStart(2,'0')).join('');

function merge(base,override={}){
 const next={...base,...override,typography:{...base.typography,...override.typography},effects:{...base.effects,...override.effects},colors:{}};
 for(const mode of ['light','dark']){
  const delta=override.colors?.[mode]||{};next.colors[mode]={...base.colors[mode],...delta};
  // Changing a brand colour should not leave green buttons/soft fills behind.
  if(delta.primary){if(!delta.button)next.colors[mode].button=delta.primary;if(!delta.primaryHover)next.colors[mode].primaryHover=mix(delta.primary,next.colors[mode].text,.15);if(!delta.buttonHover)next.colors[mode].buttonHover=next.colors[mode].primaryHover;if(!delta.soft)next.colors[mode].soft=mix(next.colors[mode].surface,delta.primary,.12);if(!delta.sidebarActive)next.colors[mode].sidebarActive=delta.primary;if(!delta.sidebarActiveText)next.colors[mode].sidebarActiveText=onColor(next.colors[mode].sidebarActive);}
 }
 return next;
}
function validateResolved(theme,label){
 if(!theme.typography.bodyFont||!theme.typography.headingFont||!theme.typography.fontSize||!theme.typography.lineHeight||!theme.typography.fontStyle||theme.effects?.cornerScale===undefined||!theme.effects?.shadow||!theme.mode)throw Error(`Appearance ${label} must inherit complete typography/effects/mode defaults.`);
 for(const mode of ['light','dark']){
  const c=theme.colors[mode];if(colorNames.some(key=>!c[key]))throw Error(`Appearance ${label}.${mode} must inherit every palette field.`);
  for(const [fg,bg] of [['text','background'],['text','surface'],['muted','surface'],['muted','background'],['primary','background'],['primaryHover','background'],['headerText','header'],['sidebarText','sidebar'],['sidebarMuted','sidebar'],['sidebarActiveText','sidebarActive']])if(contrast(c[fg],c[bg])<4.5)throw Error(`Appearance ${label}.${mode}: ${fg}/${bg} contrast must be at least 4.5:1.`);
  if(contrast(onColor(c.button),c.buttonHover)<4.5)throw Error(`Appearance ${label}.${mode}: button hover must keep its automatically selected text colour readable (4.5:1).`);
  if(contrast(onColor(c.primary),c.primaryHover)<4.5)throw Error(`Appearance ${label}.${mode}: primary hover must keep its automatically selected text colour readable (4.5:1).`);
 }
 return theme;
}
function variables(c,kind){
 const common={'--ink':c.text,'--muted':c.muted,'--line':c.border,'--theme-primary':c.primary,'--theme-primary-hover':c.primaryHover,'--theme-primary-ink':onColor(c.primary),'--theme-button-ink':onColor(c.button),'--theme-surface':c.surface,'--theme-header-bg':c.header,'--theme-header-ink':c.headerText};
 if(kind==='storefront')return {...common,'--paper':c.background,'--cream':c.surface,'--olive':c.primary,'--soft':c.soft,'--theme-button':c.button,'--theme-button-hover':c.buttonHover};
 return {...common,'--canvas':c.background,'--surface':c.surface,'--faint':c.muted,'--line-strong':mix(c.border,c.text,.18),'--accent':c.primary,'--accent-strong':c.primaryHover,'--accent-soft':c.soft,'--action':c.button,'--action-hover':c.buttonHover,'--action-ink':onColor(c.button),'--action-shadow':rgba(c.button,.2),'--sidebar':c.sidebar,'--sidebar-surface':mix(c.sidebar,c.surface,.6),'--sidebar-ink':c.sidebarText,'--sidebar-muted':c.sidebarMuted,'--sidebar-line':c.border,'--sidebar-hover':mix(c.sidebar,c.primary,.10),'--sidebar-active':c.sidebarActive,'--sidebar-active-ink':c.sidebarActiveText,'--sidebar-menu':c.surface,'--glass-surface':rgba(c.surface,.88),'--glass-surface-strong':rgba(c.surface,.96),'--glass-border':rgba(c.border,.8),'--glass-depth-green':rgba(c.primary,.13),'--scene-line':rgba(c.primary,.13),'--scene-line-strong':rgba(c.primary,.24),'--scene-node':c.primary,'--scene-glow':rgba(c.primary,.2),'--nav-green':c.primary,'--shadow-focus':`0 0 0 3px ${rgba(c.primary,.3)}`};
}
const families={admin:{manrope:'"Manrope Variable",Manrope,sans-serif',dmSans:'"Commerce DM Sans",sans-serif',system:'system-ui,-apple-system,"Segoe UI",sans-serif'},storefront:{manrope:'Manrope,sans-serif',dmSans:'"DM Sans",sans-serif',system:'system-ui,-apple-system,"Segoe UI",sans-serif'}};
const declarations=values=>Object.entries(values).map(([key,value])=>`${key}:${value}`).join(';');
function compile(theme,kind,scope){
 const t=theme.typography,common={'--theme-body-font':families[kind][t.bodyFont],'--theme-heading-font':families[kind][t.headingFont],'--theme-text-scale':String(t.fontSize/14),'--theme-radius-scale':String(theme.effects.cornerScale),'--theme-font-style':t.fontStyle,'--theme-body-weight':String(t.bodyWeight||400),'--theme-line-height':String(t.lineHeight)};
 const light=variables(theme.colors.light,kind),dark=variables(theme.colors.dark,kind),selector='html[data-config-appearance]';
 const shadow={none:'none',soft:'0 12px 32px rgba(0,0,0,.12)',medium:'0 20px 52px rgba(0,0,0,.22)'}[theme.effects.shadow];
 if(kind==='admin')common['--radius']=`${10*theme.effects.cornerScale}px`;
 if(shadow){common['--glass-shadow']=shadow;common['--glass-shadow-hover']=shadow;}
 let cssText=`${selector}{${declarations({...common,...light})};color-scheme:light}${selector}[data-theme="dark"]{${declarations(dark)};color-scheme:dark}@media(prefers-color-scheme:dark){${selector}[data-theme="system"]{${declarations(dark)};color-scheme:dark}}`;
 if(t.headingWeight)cssText+=`${selector} :is(h1,h2,h3,h4,h5,h6){font-weight:${t.headingWeight}!important}`;
 const value={schemaVersion:1,scope,mode:theme.mode,cssText};
 return {...value,revision:createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16)};
}
// Validate all configured scopes at startup, including inherited store overrides.
for(const kind of ['admin','storefront'])validateResolved(merge(configuration.defaults[kind]),`defaults.${kind}`);
for(const [tenantId,tenant]of Object.entries(configuration.tenants)){
 validateResolved(merge(configuration.defaults.admin,tenant.admin),`${tenantId}.admin`);
 const storefront=validateResolved(merge(configuration.defaults.storefront,tenant.storefront),`${tenantId}.storefront`);
 for(const [storeId,store]of Object.entries(tenant.stores||{}))validateResolved(merge(storefront,store.storefront),`${tenantId}.${storeId}`);
}
export function resolveAppearance(kind,tenantId=null,storeId=null){
 if(!['admin','storefront'].includes(kind))throw Error('Unsupported appearance target');
 const tenant=tenantId?configuration.tenants[tenantId]:null;
 let theme=merge(configuration.defaults[kind],tenant?.[kind]);
 if(kind==='storefront'&&storeId)theme=merge(theme,tenant?.stores?.[storeId]?.storefront);
 return compile(theme,kind,{kind,tenantId:tenantId||null,storeId:kind==='storefront'?storeId||null:null});
}
