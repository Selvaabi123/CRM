// ============================================================
// Website Chat widget — the embeddable client.
//
// The customer pastes a snippet on their site:
//
//   <script>
//     (function(w,d,s,o){w.__wacrmCfg={accountId:'<ACCOUNT_ID>',base:'<CRM_ORIGIN>'};
//     s=d.createElement('script');s.async=1;s.src=w.__wacrmCfg.base+
//     '/api/webchat/widget.js?account='+w.__wacrmCfg.accountId+'&base='+encodeURIComponent(w.__wacrmCfg.base);
//     d.body.appendChild(s);})(window,document);
//   </script>
//
// The script renders a floating launcher + chat panel on the page,
// creates a session (token persisted in localStorage per account), and
// polls the unified inbox's messages endpoint so agent replies appear
// live. All chat data lives in the SAME messages/conversations tables the
// CRM inbox renders — there is no separate chat store.
// ============================================================

const CSS = `
#wacrm-widget-root{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
#wacrm-launcher{width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;color:#fff;font-size:28px;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:transform .15s ease}
#wacrm-launcher:hover{transform:scale(1.05)}
#wacrm-panel{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);display:none;flex-direction:column;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.25);background:#fff;color:#111}
#wacrm-panel.open{display:flex}
#wacrm-header{padding:14px 16px;color:#fff;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}
#wacrm-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer}
#wacrm-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f6f7f9}
.wacrm-msg{max-width:78%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word}
.wacrm-msg.customer{align-self:flex-start;background:#eaecef;color:#111;border-bottom-left-radius:4px}
.wacrm-msg.agent{align-self:flex-end;background:#4f46e5;color:#fff;border-bottom-right-radius:4px}
#wacrm-input-row{display:flex;padding:10px;gap:8px;border-top:1px solid #e5e7eb;background:#fff}
#wacrm-input{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:9px 11px;font-size:14px;outline:none}
#wacrm-send{background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:0 16px;font-size:14px;cursor:pointer}
#wacrm-start{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;text-align:center;padding:20px;color:#555;font-size:14px}
`;

export function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account') ?? ''
  const base = searchParams.get('base') ?? ''

  const script = `
(function(){
  if (window.__wacrmInjected) return; window.__wacrmInjected = true;
  var accountId = ${JSON.stringify(accountId)};
  var base = ${JSON.stringify(base)};

  // Inject CSS
  var style = document.createElement('style');
  style.textContent = ${JSON.stringify(CSS)};
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.id = 'wacrm-widget-root';
  root.innerHTML =
    '<div id="wacrm-panel">' +
      '<div id="wacrm-header">Live chat <button id="wacrm-close">&times;</button></div>' +
      '<div id="wacrm-start"><div style="font-size:34px;margin-bottom:8px">💬</div><div>We typically reply within minutes.</div></div>' +
      '<div id="wacrm-messages" style="display:none"></div>' +
      '<div id="wacrm-input-row">' +
        '<input id="wacrm-input" type="text" placeholder="Type a message..." />' +
        '<button id="wacrm-send">Send</button>' +
      '</div>' +
    '</div>' +
    '<button id="wacrm-launcher" title="Chat with us">💬</button>';
  document.body.appendChild(root);

  var panel = document.getElementById('wacrm-panel');
  var messagesEl = document.getElementById('wacrm-messages');
  var input = document.getElementById('wacrm-input');
  var storageKey = 'wacrm:session:' + accountId;
  var lastSince = new Date().toISOString();

  function setStatus(text){
    var s = document.getElementById('wacrm-start');
    if (s) s.innerHTML = '<div>' + text + '</div>';
  }

  function appendMessage(m){
    var el = document.createElement('div');
    el.className = 'wacrm-msg ' + (m.sender_type === 'agent' ? 'agent' : 'customer');
    el.textContent = m.content_text || '[media]';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function ensureSession(){
    var token = localStorage.getItem(storageKey);
    try {
      var res = await fetch(base + '/api/webchat/session?account=' + encodeURIComponent(accountId), {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: token ? JSON.stringify({token: token}) : JSON.stringify({})
      });
      var data = await res.json();
      if (data && data.token) {
        localStorage.setItem(storageKey, data.token);
        loadHistory(data.token);
        poll(data.token);
      }
    } catch(e){ setStatus('Unable to reach chat server.'); }
  }

  async function loadHistory(token){
    var res = await fetch(base + '/api/webchat/messages?token=' + encodeURIComponent(token));
    var data = await res.json();
    var start = document.getElementById('wacrm-start');
    if (start) start.style.display = 'none';
    messagesEl.style.display = 'flex';
    (data.messages || []).forEach(function(m){ appendMessage(m); lastSince = m.created_at || lastSince; });
  }

  async function poll(token){
    try {
      var res = await fetch(base + '/api/webchat/messages?token=' + encodeURIComponent(token) + '&since=' + encodeURIComponent(lastSince));
      var data = await res.json();
      (data.messages || []).forEach(function(m){
        appendMessage(m);
        lastSince = m.created_at || lastSince;
      });
    } catch(e){}
    setTimeout(function(){ poll(token); }, 2000);
  }

  async function send(){
    var text = input.value.trim();
    if (!text) return;
    var token = localStorage.getItem(storageKey);
    input.value = '';
    appendMessage({sender_type:'customer', content_text:text});
    try {
      await fetch(base + '/api/webchat/messages?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ text: text, clientId: 'c' + Date.now() })
      });
    } catch(e){}
  }

  document.getElementById('wacrm-launcher').addEventListener('click', function(){
    var open = panel.classList.toggle('open');
    if (open && !localStorage.getItem(storageKey)) ensureSession();
  });
  document.getElementById('wacrm-close').addEventListener('click', function(){
    panel.classList.remove('open');
  });
  document.getElementById('wacrm-send').addEventListener('click', send);
  input.addEventListener('keydown', function(e){ if (e.key === 'Enter') send(); });

  // If the panel is already open on load, start.
  if (localStorage.getItem(storageKey)) poll(localStorage.getItem(storageKey));
})();
`;

  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
