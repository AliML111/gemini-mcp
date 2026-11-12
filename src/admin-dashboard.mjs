import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemini MCP Gateway</title>
<style nonce="@@CSP_NONCE@@">
:root{color-scheme:dark;--bg:#0d1117;--panel:#151b23;--panel2:#10161e;--line:#303946;--text:#e7edf5;--muted:#aab5c3;--accent:#9cd4ff;--good:#61d095;--warn:#f4c75e;--bad:#ff8787}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,"Segoe UI",sans-serif}
header{padding:22px max(calc((100vw - 1160px)/2),24px);border-bottom:1px solid var(--line);background:#111720}
header h1{margin:0;font-size:24px}header p{margin:5px 0 0;color:var(--muted)}
main{max-width:1160px;margin:24px auto;padding:0 20px 64px}.hidden{display:none!important}
.auth{max-width:460px;margin:12vh auto}.auth .card{padding:24px}
.tabs{display:flex;gap:7px;overflow:auto;border-bottom:1px solid var(--line);margin:22px 0 18px}.tabs button{white-space:nowrap;border:0;background:none;color:var(--muted);padding:11px 16px;border-radius:9px 9px 0 0;cursor:pointer;font:inherit}.tabs button.active{color:var(--text);background:var(--panel);border:1px solid var(--line);border-bottom-color:var(--panel);font-weight:650}
section.panel{display:none}section.panel.active{display:block}.section-head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:14px}.section-head h2{margin:0;font-size:22px}.section-head p{margin:4px 0 0;color:var(--muted);max-width:760px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin:12px 0}.card h2,.card h3,.card h4{margin:0 0 8px}.card h3{font-size:18px}
.notice{padding:13px 15px;border:1px solid #3b536b;border-radius:10px;background:#13202c;color:#d4e7f5;margin:12px 0}.notice.warn{border-color:#6c5730;background:#211d12;color:#f7e5b6}.muted,small{color:var(--muted)}.hint{font-size:13px;color:var(--muted)}
label{display:block;font-weight:600;margin:10px 0 4px}input,textarea,select{width:100%;padding:10px 11px;border:1px solid #465363;border-radius:7px;background:#0c1117;color:var(--text);font:inherit}input:focus,textarea:focus,select:focus,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input[type=checkbox]{width:auto;margin:0 8px 0 0;transform:scale(1.08)}textarea{min-height:90px;resize:vertical;font:13px/1.45 ui-monospace,Consolas,monospace}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}.card-head p{margin:2px 0;color:var(--muted)}
.cap{display:flex;align-items:center;gap:6px;font-weight:500;margin:7px 0}.button{display:inline-flex;width:auto;align-items:center;justify-content:center;padding:9px 14px;border:1px solid #506177;border-radius:8px;background:#223247;color:var(--text);font:inherit;font-weight:650;cursor:pointer}.button.primary{background:#23629b;border-color:#3785c5}.button.danger{background:#542b30;border-color:#81464c}.button.subtle{background:transparent}.button:disabled{opacity:.5;cursor:wait}
.badge{display:inline-flex;border:1px solid var(--line);border-radius:20px;padding:3px 10px;color:var(--muted);font-size:12px;white-space:nowrap}.badge.connected{color:var(--good);border-color:#27684a}.badge.error{color:var(--bad);border-color:#793636}
.module-meta{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.module-meta span{padding:4px 9px;border:1px solid var(--line);border-radius:20px;color:var(--muted);font-size:13px}
details.advanced,details.tool-server,details.skill-content{border:1px solid var(--line);border-radius:9px;background:var(--panel2);margin-top:14px}details>summary{cursor:pointer;padding:12px 14px;font-weight:650}details.advanced[open]>summary,details.tool-server[open]>summary,details.skill-content[open]>summary{border-bottom:1px solid var(--line)}.details-body{padding:14px}
.tool-server{overflow:hidden}.tool-server>summary{display:flex;justify-content:space-between;align-items:center;gap:12px;list-style:none}.tool-server>summary::-webkit-details-marker{display:none}.tool-server>summary:after{content:"Open";color:var(--accent);font-size:13px}.tool-server[open]>summary:after{content:"Close"}
.tool-row{display:grid;grid-template-columns:minmax(200px,1fr) minmax(160px,.7fr);gap:12px;align-items:center;padding:12px 4px;border-top:1px solid #29313b}.tool-row:first-child{border-top:0}.tool-name{font-weight:650}.tool-name code{display:block;font:12px ui-monospace,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}.tool-desc{display:block;color:var(--muted);font-size:13px}.tool-row select{margin:0}.tool-row .cap{margin:0}
.search{max-width:520px;margin:12px 0 16px}.actions{display:flex;gap:10px;justify-content:flex-end;align-items:center;margin:20px 0}.feedback{margin-right:auto}.feedback.good{color:var(--good)}.feedback.bad,.danger-text{color:var(--bad)}
.sticky-actions{position:sticky;bottom:0;z-index:4;padding:10px 12px;background:#0d1117ed;border:1px solid var(--line);border-radius:10px;backdrop-filter:blur(8px)}
.skill-preview{margin:8px 0;color:var(--muted);font-size:14px;white-space:pre-line}.skill-content textarea{min-height:240px}
@media(max-width:760px){.tool-row{grid-template-columns:1fr;gap:6px}.section-head,.card-head{align-items:flex-start;flex-direction:column}.sticky-actions{position:static}}
</style></head><body>
<header><h1>Gemini MCP Gateway</h1></header>
<main>
<section id="login" class="auth"><div class="card"><h2>Admin sign-in</h2><label for="password">Gateway password</label><input id="password" type="password" autocomplete="current-password"><div class="actions"><button id="login-button" class="button primary">Open dashboard</button></div><div id="login-error" class="danger-text"></div></div></section>
<section id="dashboard" class="hidden">
<nav class="tabs" aria-label="Dashboard sections"><button class="active" data-tab="tools">Tools</button><button data-tab="servers">MCP servers</button><button data-tab="skills">Skills</button></nav>
<section id="servers" class="panel"><div class="section-head"><div><h2>MCP servers</h2></div><button id="add-module" class="button primary">Add MCP server</button></div><div id="module-list"></div></section>
<section id="tools" class="panel active"><div class="section-head"><div><h2>Tools</h2></div><button id="refresh" class="button">Refresh connections</button></div>
<label class="search" for="tool-search">Find a tool</label><input class="search" id="tool-search" type="search" placeholder="Search by tool name or description">
<div id="tool-list"></div></section>
<section id="skills" class="panel"><div class="section-head"><div><h2>Skills</h2></div><button id="add-skill" class="button primary">Add skill</button></div><div id="skill-list"></div></section>
<div class="actions sticky-actions"><span id="feedback" class="feedback" aria-live="polite"></span><button id="save" class="button primary">Save changes</button><button id="logout" class="button subtle">Log out</button></div>
</section></main>
<script nonce="@@CSP_NONCE@@">
const storageKey='gemini-mcp-admin-password';let state=null;let password=sessionStorage.getItem(storageKey)||'';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const platformName=id=>({win32:'Windows',linux:'Linux',darwin:'macOS',all:'All platforms'}[id]||id);
const capabilityLabel=(module,id)=>module.capabilities?.[id]?.label||id||'Choose a permission group';
function authHeader() {
  const bytes = new TextEncoder().encode('admin:' + password);
  return 'Basic ' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{authorization:authHeader(),...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});if(response.status===401)throw new Error('That gateway password was rejected. Check the current password file.');const body=await response.json();if(!response.ok)throw new Error(body.error||'Request failed.');return body}
function feedback(message,type=''){const node=$('feedback');node.className='feedback '+type;node.textContent=message}
function moduleStatus(id){return state.modules.find(module=>module.id===id)||{state:'inactive',tools:[]}}
function render(){renderModules();renderToolAccess();renderSkills()}
function renderModules(){const root=$('module-list');root.replaceChildren();for(const module of state.config.modules){const status=moduleStatus(module.id);const card=document.createElement('article');card.className='card';card.dataset.moduleId=module.id;const platforms=(module.platforms||[]).join(', ');const enabledCount=Object.values(module.toolPolicies||{}).filter(policy=>policy.enabled).length;
card.innerHTML='<div class="card-head"><div><h3>'+esc(module.name||'Unnamed MCP server')+'</h3><p>'+esc(status.state==='connected'?'Connected and ready':status.state==='error'?'Connection needs attention':'Not connected on this platform')+'</p></div><div class="row"><span class="badge '+(status.state==='connected'?'connected':status.state==='error'?'error':'')+'">'+esc(status.state||'inactive')+'</span><label class="cap"><input data-field="enabled" type="checkbox" '+(module.enabled?'checked':'')+'>Enabled</label></div></div>'+
'<div class="module-meta"><span>'+esc((module.platforms||[]).map(platformName).join(', ')||'No platform selected')+'</span><span>'+status.tools.length+' tools found</span><span>'+enabledCount+' tools allowed</span></div>'+
(status.error?'<p class="danger-text">'+esc(status.error)+'</p>':'')+
'<details class="advanced"><summary>Advanced connection settings</summary><div class="details-body"><p class="hint">Change these only when you know the MCP server command and its configuration. Blank environment values keep saved secrets.</p><div class="grid"><div><label>Server name</label><input data-field="name" value="'+esc(module.name)+'"><label>Platforms (win32, linux, darwin, all)</label><input data-field="platforms" value="'+esc(platforms)+'"><label>Command</label><input data-field="command" value="'+esc(module.command)+'"></div><div><label>Module ID</label><input data-field="id" value="'+esc(module.id)+'"><label>Command arguments (JSON array)</label><textarea data-field="args">'+esc(JSON.stringify(module.args||[],null,2))+'</textarea></div></div><label>Permission group definitions (advanced JSON)</label><textarea data-field="capabilities">'+esc(JSON.stringify(module.capabilities||{},null,2))+'</textarea><label>Environment variables (advanced JSON)</label><textarea data-field="env">'+esc(JSON.stringify(module.env||{},null,2))+'</textarea><button class="button danger remove-module">Remove this MCP server</button></div></details>';
card.querySelector('.remove-module').addEventListener('click',()=>{if(!confirm('Remove '+module.name+' from this gateway? Save changes to apply it.'))return;state.config.modules=state.config.modules.filter(item=>item.id!==module.id);render()});root.append(card)}}
function renderToolAccess() {
  const root = $('tool-list');
  root.replaceChildren();
  for (const module of state.config.modules) {
    const status = moduleStatus(module.id);
    if (status.state !== 'connected' || !status.tools.length) continue;
    const tools = status.tools;
    const details = document.createElement('details');
    details.className = 'tool-server';
    details.open = !root.children.length;
    const summary = document.createElement('summary');
    const enabledCount = tools.filter(tool => module.toolPolicies?.[tool.name]?.enabled).length;
    summary.textContent = module.name + ' · ' + enabledCount + ' of ' + tools.length + ' enabled';
    details.append(summary);
    const body = document.createElement('div');
    body.className = 'details-body';
    for (const tool of tools) {
      const policy = module.toolPolicies?.[tool.name] || {};
      const row = document.createElement('div');
      row.className = 'tool-row';
      row.dataset.moduleId = module.id;
      row.dataset.toolName = tool.name;
      row.dataset.search = [tool.name, tool.title, tool.description].filter(Boolean).join(' ').toLowerCase();
      const label = document.createElement('label');
      label.className = 'cap';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'tool-enabled';
      checkbox.checked = Boolean(policy.enabled);
      label.append(checkbox, tool.title || tool.name);
      if (tool.description) label.title = tool.description;
      const select = document.createElement('select');
      select.className = 'tool-capability';
      select.setAttribute('aria-label', 'Permission group for ' + (tool.title || tool.name));
      for (const [id, definition] of Object.entries(module.capabilities || {})) {
        select.add(new Option(definition.label || id, id));
      }
      if (policy.capability) select.value = policy.capability;
      if (!select.value && select.options.length) select.selectedIndex = 0;
      row.append(label, select);
      body.append(row);
    }
    details.append(body);
    root.append(details);
  }
  if (!root.children.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Connect an MCP server to choose its tools.';
    root.append(empty);
  }
}
function renderSkills(){const root=$('skill-list');root.replaceChildren();for(const skill of state.config.skills){const card=document.createElement('article');card.className='card';card.dataset.skillId=skill.id;const platforms=(skill.platforms||[]).join(', ');const preview=(skill.content||'').trim().slice(0,220);
card.innerHTML='<div class="card-head"><div><h3>'+esc(skill.name||'Untitled skill')+'</h3><p>'+esc(skill.description||'No description yet')+'</p></div><div class="row"><label class="cap"><input data-field="enabled" type="checkbox" '+(skill.enabled?'checked':'')+'>Enabled</label><button class="button danger remove-skill">Remove</button></div></div><div class="module-meta"><span>'+esc((skill.platforms||[]).map(platformName).join(', ')||'No platform selected')+'</span></div><p class="skill-preview">'+esc(preview)+(skill.content?.length>220?'…':'')+'</p><div class="grid"><div><label>Skill name</label><input data-field="name" value="'+esc(skill.name)+'"><label>What this skill helps Gemini do</label><input data-field="description" value="'+esc(skill.description||'')+'"></div><div><label>Platforms (win32, linux, darwin, all)</label><input data-field="platforms" value="'+esc(platforms)+'"><label>Skill ID</label><input data-field="id" value="'+esc(skill.id)+'"></div></div><details class="skill-content"><summary>Edit skill instructions</summary><div class="details-body"><label>Instructions in Markdown</label><textarea data-field="content">'+esc(skill.content||'')+'</textarea></div></details>';
card.querySelector('.remove-skill').addEventListener('click',()=>{if(!confirm('Remove the skill '+skill.name+'? Save changes to apply it.'))return;state.config.skills=state.config.skills.filter(item=>item.id!==skill.id);renderSkills()});root.append(card)}}
function collectConfig(){const modules=[];for(const card of document.querySelectorAll('#module-list [data-module-id]')){const original=state.config.modules.find(item=>item.id===card.dataset.moduleId);const field=name=>card.querySelector('[data-field="'+name+'"]');let args,capabilities,env;try{args=JSON.parse(field('args').value);capabilities=JSON.parse(field('capabilities').value);env=JSON.parse(field('env').value)}catch(error){throw new Error('Invalid advanced JSON in '+original.name+': '+error.message)}const toolPolicies=Object.assign(Object.create(null),original.toolPolicies);for(const row of document.querySelectorAll('.tool-row'))if(row.dataset.moduleId===card.dataset.moduleId)toolPolicies[row.dataset.toolName]={enabled:row.querySelector('.tool-enabled').checked,capability:row.querySelector('.tool-capability').value};modules.push({id:field('id').value.trim(),name:field('name').value.trim(),enabled:field('enabled').checked,command:field('command').value.trim(),args,env,platforms:field('platforms').value.split(',').map(item=>item.trim()).filter(Boolean),capabilities,toolPolicies,cwd:original.cwd})}
const skills=[];for(const card of document.querySelectorAll('#skill-list [data-skill-id]')){const field=name=>card.querySelector('[data-field="'+name+'"]');skills.push({id:field('id').value.trim(),name:field('name').value.trim(),description:field('description').value,enabled:field('enabled').checked,platforms:field('platforms').value.split(',').map(item=>item.trim()).filter(Boolean),content:field('content').value})}return{version:1,modules,skills}}
function openTab(id){document.querySelectorAll('.tabs button').forEach(button=>button.classList.toggle('active',button.dataset.tab===id));document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===id))}
document.querySelectorAll('.tabs button').forEach(button=>button.addEventListener('click',()=>openTab(button.dataset.tab)));
$('tool-search').addEventListener('input',()=>{const query=$('tool-search').value.toLowerCase().trim();for(const row of document.querySelectorAll('.tool-row'))row.classList.toggle('hidden',!!query&&!row.dataset.search.includes(query))});
$('login-button').addEventListener('click',async()=>{password=$('password').value;sessionStorage.setItem(storageKey,password);$('login-error').textContent='';try{state=await api('/api/state');$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');render()}catch(error){sessionStorage.removeItem(storageKey);password='';$('login-error').textContent=error.message}});
$('password').addEventListener('keydown',event=>{if(event.key==='Enter')$('login-button').click()});
$('refresh').addEventListener('click',async()=>{const button=$('refresh');button.disabled=true;feedback('Refreshing MCP connections…');try{state=await api('/api/reload',{method:'POST',body:'{}'});render();feedback('Connection status refreshed.','good')}catch(error){feedback(error.message,'bad')}finally{button.disabled=false}});
$('save').addEventListener('click',async()=>{const button=$('save');button.disabled=true;feedback('Saving and applying changes…');try{const config=collectConfig();state=await api('/api/save',{method:'POST',body:JSON.stringify(config)});render();feedback('Saved. Reconnect Gemini to apply changed tools and permissions.','good')}catch(error){feedback(error.message,'bad')}finally{button.disabled=false}});
$('add-module').addEventListener('click',()=>{state.config.modules.push({id:'mcp-'+Date.now().toString().slice(-7),name:'New MCP server',enabled:false,platforms:[state.platform],command:'',args:[],env:{},capabilities:{'module:use':{label:'Use this MCP'}},toolPolicies:{}});render();openTab('servers')});
$('add-skill').addEventListener('click',()=>{state.config.skills.push({id:'skill-'+Date.now().toString().slice(-7),name:'New skill',description:'',enabled:false,platforms:[state.platform],content:'# New skill'+String.fromCharCode(10,10)+'Describe the guidance for this platform.'});renderSkills()});
$('logout').addEventListener('click',()=>{password='';sessionStorage.removeItem(storageKey);location.reload()});if(password){api('/api/state').then(result=>{state=result;$('login').classList.add('hidden');$('dashboard').classList.remove('hidden');render()}).catch(()=>{sessionStorage.removeItem(storageKey);password='';$('login').classList.remove('hidden');$('dashboard').classList.add('hidden')})}
</script></body></html>`;

export function createAdminDashboard({ manager, password, port = 8788, getRuntimeState = () => ({}) }) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 32) {
    throw new Error('MCP_ADMIN_PASSWORD must contain at least 32 UTF-8 bytes.');
  }
  const app = express();
  const secretDigest = createHash('sha256').update(password, 'utf8').digest();
  const getState = () => ({ ...manager.snapshot(), ...getRuntimeState() });
  app.disable('x-powered-by');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.use((req, res, next) => {
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) return res.sendStatus(404);
    const nonce = randomBytes(18).toString('base64');
    res.locals.cspNonce = nonce;
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.get('/', (_req, res) => res.type('html').send(page.replaceAll('@@CSP_NONCE@@', res.locals.cspNonce)));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'gemini-mcp-admin', localOnly: true }));
  app.use('/api', (req, res, next) => {
    const address = req.socket.remoteAddress ?? '';
    if (!(address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')) return res.sendStatus(404);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin dashboard changes are not allowed.' });
    }
    const encoded = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!encoded) return res.status(401).set('WWW-Authenticate', 'Basic realm="Gemini MCP local admin", charset="UTF-8"').json({ error: 'Administrator authentication required.' });
    let supplied = '';
    try {
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') === encoded) supplied = decoded.toString('utf8').split(':').slice(1).join(':');
    } catch { /* reject below */ }
    const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
    if (!supplied || !timingSafeEqual(suppliedDigest, secretDigest)) return res.status(401).json({ error: 'Administrator password was rejected.' });
    next();
  });
  app.use('/api', express.json({ limit: '1mb' }));
  app.get('/api/state', (_req, res) => res.json(getState()));
  app.post('/api/reload', async (_req, res) => {
    try {
      await manager.activate();
      res.json(getState());
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post('/api/save', async (req, res) => {
    try {
      const state = await manager.saveAndApply(req.body);
      res.json({ ...state, ...getRuntimeState() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save module registry.' });
    }
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error?.status === 413 ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
    if (status === 500) console.error('Admin dashboard request failed:', error instanceof Error ? error.message : 'unknown error');
    res.status(status).json({ error: status === 413 ? 'Request body exceeds the 1 MiB limit.' : status === 400 ? 'Request body must contain valid JSON.' : 'The dashboard could not complete this request.' });
  });
  return { app, port };
}
