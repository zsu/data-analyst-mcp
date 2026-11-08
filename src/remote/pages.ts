/**
 * The few HTML pages remote mode serves: OAuth consent, the new-account code, the keys page and the upload page.
 * Self-contained (no scripts from elsewhere), escaped, and never showing a stored key.
 *
 * The keys and upload pages are opened as /keys#<token> and /upload#<token>: the token is in the fragment, which a
 * browser never sends to a server, so it is in no access log and no Referer. The page's own script reads it, takes
 * it out of the address bar, and sends it in an Authorization header to /keys/api or /upload/api. Each script
 * carries the response's CSP nonce (app.ts).
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fafafa;--muted:#666;--line:#ddd;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#aaa;--line:#333;--accent:#7aa2ff}}
body{font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:42rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}label{display:block;margin:.6rem 0 .2rem;font-weight:600}input{width:100%;padding:.5rem;border:1px solid var(--line);
border-radius:6px;background:transparent;color:inherit;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1.2rem;border:0;
border-radius:6px;background:var(--accent);color:#fff;font-size:1rem;cursor:pointer}.muted{color:var(--muted);font-size:.9rem}
code{background:rgba(127,127,127,.15);padding:.1rem .3rem;border-radius:4px}.set{color:#2a8a3e}table{width:100%;border-collapse:collapse}
td{padding:.35rem .2rem;border-bottom:1px solid var(--line);vertical-align:top}</style></head><body>${body}</body></html>`;
}

export function consentPage(client: string, pending: string, redirectHost = ""): string {
  const to = redirectHost ? ` It sends you back to <code>${esc(redirectHost)}</code> afterwards: connect only if that is your ` +
    "assistant's address." : "";
  return page("Connect data-analyst", `<h1>Connect ${esc(client)} to data-analyst</h1>
<p>data-analyst fetches official U.S. government data for your assistant. Connecting lets you store your own API keys
for the sources that need one (FRED, BEA, Census and others). Your keys stay on this server, encrypted; the assistant
never sees them.${to}</p>
<form method="post" action="/oauth/consent"><input type="hidden" name="pending" value="${esc(pending)}">
<label for="code">Account code (only to reconnect an account you made before)</label>
<input id="code" name="account_code" autocomplete="off" placeholder="leave empty to create a new account">
<button type="submit">Connect</button></form>
<p class="muted">An account here is only a key ring: no email, no password, no profile.</p>`);
}

export function newAccountPage(code: string, next: string): string {
  return page("Your account code", `<h1>Save your account code</h1>
<p>This is the only time it is shown. Use it to reconnect this account (and its stored keys) later, for example from
another assistant or after removing the connector.</p><p><code style="font-size:1.2rem">${esc(code)}</code></p>
<p><a href="${esc(next)}" rel="noreferrer">Continue to your assistant</a></p>`);
}

/** The script both token pages start with: the token from the fragment, then out of the address bar and history. */
const TOKEN_JS = `const tok=location.hash.slice(1);if(tok)history.replaceState(null,"",location.pathname);
const H={Authorization:"Bearer "+tok};const expired="This link expired: ask your assistant for a new one.";`;

export function keysPage(nonce: string): string {
  return page("Your API keys", `<h1>Your API keys</h1>
<p id="msg" class="muted">Loading…</p>
<form id="f" hidden><p>Type a key to store or replace it, or a single space to remove it. Stored keys are encrypted and
never shown again, here or to the assistant.</p><table id="t"></table><button type="submit">Save</button></form>
<script nonce="${esc(nonce)}">(()=>{${TOKEN_JS}
const msg=document.getElementById("msg"),form=document.getElementById("f"),tbl=document.getElementById("t");
if(!tok){msg.textContent=expired;return}
const api=(o)=>fetch("/keys/api",Object.assign({cache:"no-store",headers:Object.assign({"Content-Type":"application/json"},H)},o||{}))
  .then((r)=>r.ok?r.json():Promise.reject(r.status));
function render(d,saved){tbl.textContent="";
for(const v of d.vars){const tr=tbl.insertRow(),a=tr.insertCell(),b=tr.insertCell();
const l=document.createElement("label");l.htmlFor=v.env;l.textContent=v.env;a.append(l);
const s=document.createElement("span");s.className="muted";s.textContent=v.sources.join(", ");
if(v.signup&&/^https:\\/\\//.test(v.signup)){const g=document.createElement("a");g.href=v.signup;g.target="_blank";
g.rel="noopener noreferrer";g.textContent="get a free key";s.append(" · ",g)}a.append(s);b.style.width="45%";
const i=document.createElement("input");i.id=i.name=v.env;i.type="password";i.autocomplete="new-password";
i.placeholder=d.set.includes(v.env)?"stored (type to replace)":"not set";b.append(i)}
msg.className=saved?"set":"muted";msg.textContent=saved?"Saved. Stored now: "+(d.set.length?d.set.join(", "):"none")+".":"";
form.hidden=false}
api().then((d)=>render(d,false),()=>{msg.textContent=expired});
form.onsubmit=(e)=>{e.preventDefault();const keys={};for(const i of form.querySelectorAll("input"))if(i.value!=="")keys[i.name]=i.value;
api({method:"POST",body:JSON.stringify({keys})}).then((d)=>render(d,true),(s)=>{msg.className="muted";
msg.textContent=s===403?expired:"Could not save (HTTP "+s+")."})}})();</script>`);
}

export function uploadPage(nonce: string): string {
  return page("Upload files", `<h1>Upload the downloaded files</h1>
<p>Choose every file the download script saved (or that you saved from the agency's site). They go into this
analysis session only.</p><input id="f" type="file" multiple><button id="b">Upload</button><p id="s" class="muted"></p>
<p id="have" class="muted"></p>
<script nonce="${esc(nonce)}">(()=>{${TOKEN_JS}
const s=document.getElementById("s"),have=document.getElementById("have");
if(!tok){s.textContent=expired;return}
fetch("/upload/api",{headers:H,cache:"no-store"}).then((r)=>r.ok?r.json():Promise.reject(r.status))
  .then((d)=>{if(d.files.length)have.textContent="Already here: "+d.files.join(", ")},()=>{s.textContent=expired});
document.getElementById("b").onclick=async()=>{const fs=document.getElementById("f").files;
for(const f of fs){s.textContent="Uploading "+f.name+"…";
const r=await fetch("/upload/api?name="+encodeURIComponent(f.name),{method:"PUT",headers:H,body:f});
if(!r.ok){s.textContent="Failed: "+f.name+" (HTTP "+r.status+")";return}}
s.textContent="Done: "+fs.length+" file(s). Tell your assistant they are uploaded.";};})();</script>`);
}
