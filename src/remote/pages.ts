/**
 * The few HTML pages remote mode serves: OAuth consent, the new-account code, the keys page and the upload page.
 * Self-contained (no scripts from elsewhere), escaped, and never showing a stored key.
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fafafa;--muted:#666;--line:#ddd;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#aaa;--line:#333;--accent:#7aa2ff}}
body{font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:42rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}label{display:block;margin:.6rem 0 .2rem;font-weight:600}input{width:100%;padding:.5rem;border:1px solid var(--line);
border-radius:6px;background:transparent;color:inherit;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1.2rem;border:0;
border-radius:6px;background:var(--accent);color:#fff;font-size:1rem;cursor:pointer}.muted{color:var(--muted);font-size:.9rem}
code{background:rgba(127,127,127,.15);padding:.1rem .3rem;border-radius:4px}.set{color:#2a8a3e}table{width:100%;border-collapse:collapse}
td{padding:.35rem .2rem;border-bottom:1px solid var(--line);vertical-align:top}</style></head><body>${body}</body></html>`;
}

export function consentPage(client: string, pending: string): string {
  return page("Connect data-analyst", `<h1>Connect ${esc(client)} to data-analyst</h1>
<p>data-analyst fetches official U.S. government data for your assistant. Connecting lets you store your own API keys
for the sources that need one (FRED, BEA, Census and others). Your keys stay on this server, encrypted; the assistant
never sees them.</p>
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
<p><a href="${esc(next)}">Continue to your assistant</a></p>`);
}

export function keysPage(vars: { env: string; sources: string[]; signup?: string | null }[], set: string[],
  action: string, saved?: string[]): string {
  const rows = vars.map((v) => `<tr><td><label for="${esc(v.env)}">${esc(v.env)}</label><span class="muted">${esc(v.sources.join(", "))}` +
    (v.signup ? ` · <a href="${esc(v.signup)}" target="_blank" rel="noopener">get a free key</a>` : "") + `</span></td>
<td style="width:45%"><input id="${esc(v.env)}" name="${esc(v.env)}" type="password" autocomplete="off"
placeholder="${set.includes(v.env) ? "stored (type to replace)" : "not set"}"></td></tr>`).join("\n");
  return page("Your API keys", `<h1>Your API keys</h1>
${saved ? `<p class="set">Saved. Stored now: ${saved.length ? esc(saved.join(", ")) : "none"}.</p>` : ""}
<p>Type a key to store or replace it, or a single space to remove it. Stored keys are encrypted and never shown again,
here or to the assistant.</p><form method="post" action="${esc(action)}"><table>${rows}</table>
<button type="submit">Save</button></form>`);
}

export function uploadPage(action: string, files: string[]): string {
  return page("Upload files", `<h1>Upload the downloaded files</h1>
<p>Choose every file the download script saved (or that you saved from the agency's site). They go into this
analysis session only.</p><input id="f" type="file" multiple><button id="b">Upload</button><p id="s" class="muted"></p>
${files.length ? `<p class="muted">Already here: ${esc(files.join(", "))}</p>` : ""}
<script>document.getElementById("b").onclick=async()=>{const s=document.getElementById("s"),fs=document.getElementById("f").files;
for(const f of fs){s.textContent="Uploading "+f.name+"…";const r=await fetch(${JSON.stringify(action)}+"&name="+encodeURIComponent(f.name),
{method:"PUT",body:f});if(!r.ok){s.textContent="Failed: "+f.name+" ("+r.status+")";return}}
s.textContent="Done: "+fs.length+" file(s). Tell your assistant they are uploaded.";};</script>`);
}
