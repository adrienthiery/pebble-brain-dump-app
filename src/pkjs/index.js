// Brain Dump — PebbleKit JS
// Routes voice notes to Google Tasks / Notion / AI agent / Custom Webhook
// Intent classification runs locally; no extra API call needed for routing.

var KEY_CONFIG  = 'brain_dump_cfg_v1';
var KEY_HISTORY = 'brain_dump_hist_v1';

var DEFAULT_SYSTEM_PROMPT =
    '/no_think You are a concise assistant displayed on a Pebble smartwatch ' +
    'with a very small screen. Reply in 1-2 short sentences only. ' +
    'No preamble, no lists, no markdown. Be direct.';

// In-memory AI conversation context (cleared on CLEAR_CONTEXT)
var s_ai_messages  = [];
var s_last_note    = '';
var s_clock_24h    = false;   // updated from watch on each note

// ============================================================================
// CONFIG HELPERS
// ============================================================================

function getConfig() {
    try { var r = localStorage.getItem(KEY_CONFIG); return r ? JSON.parse(r) : {}; }
    catch(e) { return {}; }
}
function saveConfig(cfg) {
    try { localStorage.setItem(KEY_CONFIG, JSON.stringify(cfg)); } catch(e) {}
}

// ============================================================================
// HISTORY HELPERS
// ============================================================================

function getHistory() {
    try { var r = localStorage.getItem(KEY_HISTORY); return r ? JSON.parse(r) : []; }
    catch(e) { return []; }
}
function addHistory(text, dest) {
    var h = getHistory();
    h.unshift({ text: text.substring(0, 200), dest: dest,
                ts: Math.floor(Date.now() / 1000) });
    if (h.length > 50) h = h.slice(0, 50);
    try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch(e) {}
}

// ============================================================================
// INTENT CLASSIFIER  (pure JS, zero latency)
// ============================================================================

function getEnabledDests(cfg) {
    var d = [];
    if (cfg.tasks_enabled)   d.push('tasks');
    if (cfg.notion_enabled)  d.push('notion');
    if (cfg.ai_enabled)      d.push('ai');
    if (cfg.webhook_enabled) d.push('webhook');
    return d;
}

var TASK_SIGNALS = ['remind me', 'add task', 'add a task', 'to do', 'todo',
                    "don't forget", "remember to", 'need to', 'have to',
                    'buy ', 'call ', 'email ', 'schedule', 'appointment',
                    'meeting', 'pick up', 'book '];

function isTaskLike(text) {
    var t = text.toLowerCase();
    for (var i = 0; i < TASK_SIGNALS.length; i++) {
        if (t.indexOf(TASK_SIGNALS[i]) >= 0) return true;
    }
    return false;
}

function classifyIntent(text, enabled, cfg) {
    if (enabled.length === 0) return null;
    // Don't shortcut when only AI is enabled — task-like text should go local instead
    if (enabled.length === 1 && enabled[0] !== 'ai') return enabled[0];

    var t = text.toLowerCase();
    var scores = {};
    enabled.forEach(function(d) { scores[d] = 0; });

    // AI signals
    if (scores['ai'] !== undefined) {
        var qw = ['what ','how ','why ','who ','where ','when ','is ','are ','can ',
                  'could ','should ','will ','would ',"what's","how's"];
        var phrases = ['explain','tell me','help me','define ','look up',
                       'search for','give me','translate'];
        if (t.charAt(t.length - 1) === '?') scores['ai'] += 3;
        if (t.indexOf('ask ') === 0) scores['ai'] += 2;  // "Ask what..." or "Ask AI..."
        qw.forEach(function(w) { if (t.indexOf(w) === 0) scores['ai'] += 2; });
        phrases.forEach(function(p) { if (t.indexOf(p) >= 0) scores['ai'] += 1; });
        // Explicit AI mentions — highest priority
        if (t.indexOf('a.i.') >= 0 ||
            t.indexOf(' ai ') >= 0 || t.indexOf('ai ') === 0 ||
            t.indexOf(' ai,') >= 0 || t.indexOf(' ai.') >= 0) {
            scores['ai'] += 4;
        }
    }

    // Task signals
    if (scores['tasks'] !== undefined) {
        var tw = ['tomorrow','tonight','today','monday','tuesday','wednesday',
                  'thursday','friday','saturday','sunday',
                  'next week','this week','next month','by '];
        TASK_SIGNALS.forEach(function(p) { if (t.indexOf(p) >= 0) scores['tasks'] += 2; });
        tw.forEach(function(w) { if (t.indexOf(w) >= 0) scores['tasks'] += 1; });
    }

    // Notion signals
    if (scores['notion'] !== undefined) {
        var np = ['note','write down','save this','document','jot',
                  'record that','add to my notes','log this',
                  'idea','memo','keep in mind'];
        np.forEach(function(p) { if (t.indexOf(p) >= 0) scores['notion'] += 2; });
    }

    // Webhook: user-configured trigger keywords (comma-separated in settings)
    if (scores['webhook'] !== undefined) {
        var kw = (cfg.webhook_keywords || '').toLowerCase().split(',');
        kw.forEach(function(k) {
            k = k.trim();
            if (k && t.indexOf(k) >= 0) scores['webhook'] += 3;
        });
    }

    // Pick highest-scoring enabled destination
    var best = null, bestScore = -1;
    enabled.forEach(function(d) {
        if (scores[d] > bestScore) { bestScore = scores[d]; best = d; }
    });

    // Tie or all-zero → use configured default
    if (bestScore <= 0) return cfg.default_dest || enabled[0];
    return best;
}

// ============================================================================
// GOOGLE TASKS
// ============================================================================

function extractDueDate(text) {
    var t = text.toLowerCase();
    var now = new Date(), d = null;

    if (t.indexOf('tomorrow') >= 0) {
        d = new Date(now); d.setDate(d.getDate() + 1);
    } else {
        var days = ['sunday','monday','tuesday','wednesday',
                    'thursday','friday','saturday'];
        for (var i = 0; i < days.length; i++) {
            if (t.indexOf(days[i]) >= 0) {
                d = new Date(now);
                var diff = (i - d.getDay() + 7) % 7 || 7;
                d.setDate(d.getDate() + diff);
                break;
            }
        }
    }
    return d ? d.toISOString().split('T')[0] + 'T00:00:00.000Z' : null;
}

function refreshGoogleToken(cfg, cb) {
    if (!cfg.tasks_refresh_token || !cfg.tasks_client_id) { cb(null); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://oauth2.googleapis.com/token');
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onload = function() {
        try { var r = JSON.parse(this.responseText); cb(r.access_token || null); }
        catch(e) { cb(null); }
    };
    xhr.onerror = function() { cb(null); };
    xhr.send(
        'grant_type=refresh_token' +
        '&refresh_token=' + encodeURIComponent(cfg.tasks_refresh_token) +
        '&client_id='     + encodeURIComponent(cfg.tasks_client_id) +
        '&client_secret=' + encodeURIComponent(cfg.tasks_client_secret || '')
    );
}

function sendToTasks(text, cfg, cb) {
    var token  = cfg.tasks_access_token;
    var listId = cfg.tasks_list_id || '@default';
    if (!token) { cb(false, 'Google not authenticated'); return; }

    var task = { title: text };
    var due = extractDueDate(text);
    if (due) task.due = due;

    function doPost(accessToken) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://tasks.googleapis.com/tasks/v1/lists/' +
                          encodeURIComponent(listId) + '/tasks');
        xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            if (this.status >= 200 && this.status < 300) {
                cb(true, 'tasks');
            } else if (this.status === 401) {
                // Token expired — try refresh
                refreshGoogleToken(cfg, function(newToken) {
                    if (newToken) {
                        cfg.tasks_access_token = newToken;
                        saveConfig(cfg);
                        doPost(newToken);
                    } else {
                        cb(false, 'Auth expired');
                    }
                });
            } else {
                cb(false, 'Tasks error ' + this.status);
            }
        };
        xhr.onerror = function() { cb(false, 'Network error'); };
        xhr.send(JSON.stringify(task));
    }

    doPost(token);
}

// ============================================================================
// NOTION
// ============================================================================

function sendToNotion(text, cfg, cb) {
    var token = cfg.notion_token;
    var dbId  = cfg.notion_db_id;
    if (!token || !dbId) { cb(false, 'Notion not configured'); return; }

    var body = {
        parent: { database_id: dbId },
        properties: {
            title: { title: [{ type: 'text',
                               text: { content: text.substring(0, 200) } }] }
        }
    };

    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.notion.com/v1/pages');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Notion-Version', '2022-06-28');
    xhr.onload = function() {
        cb(this.status >= 200 && this.status < 300, 'notion');
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    xhr.send(JSON.stringify(body));
}

// ============================================================================
// AI AGENT  (OpenAI-compatible)
// ============================================================================

var AI_PRESETS = {
    nvidia:    { url: 'https://integrate.api.nvidia.com/v1', model: 'minimaxai/minimax-m2.5', key: '' },
    ollama:    { url: 'http://localhost:11434/v1', model: 'llama3',           key: '' },
    lmstudio:  { url: 'http://localhost:1234/v1',  model: 'local-model',      key: '' },
    groq:      { url: 'https://api.groq.com/openai/v1', model: 'llama3-8b-8192', key: '' },
    openrouter:{ url: 'https://openrouter.ai/api/v1',   model: 'meta-llama/llama-3-8b-instruct:free', key: '' },
    mistral:   { url: 'https://api.mistral.ai/v1',      model: 'mistral-small-latest', key: '' },
    custom:    { url: '',                           model: '',                 key: '' }
};

function sendToAI(text, isFollowup, cfg, cb) {
    var preset  = AI_PRESETS[cfg.ai_preset] || AI_PRESETS.custom;
    var baseUrl = (cfg.ai_url   || preset.url  ).replace(/\/$/, '');
    var model   = cfg.ai_model  || preset.model || 'llama3';
    var apiKey  = cfg.ai_key    || preset.key;
    var basePrompt = DEFAULT_SYSTEM_PROMPT + (cfg.ai_system ? ' ' + cfg.ai_system : '');
    var prefs = 'User preferences: ' +
        (s_clock_24h ? '24-hour clock' : '12-hour clock') + ', ' +
        (cfg.metric_units !== false ? 'metric units' : 'imperial units') + '.';
    var sysPrompt = basePrompt + ' ' + prefs;

    if (!baseUrl) { cb(false, 'AI not configured'); return; }

    if (isFollowup && s_ai_messages.length > 0) {
        s_ai_messages.push({ role: 'user', content: text });
    } else {
        s_ai_messages = [
            { role: 'system', content: sysPrompt },
            { role: 'user',   content: text }
        ];
    }

    var body = {
        model:      model,
        messages:   s_ai_messages,
        max_tokens: 4096,
        temperature: 0.7
    };

    var endpoint = baseUrl + '/chat/completions';
    console.log('AI request → ' + endpoint + ' (model: ' + model + ')');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (apiKey) xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
    xhr.onload = function() {
        try {
            var r = JSON.parse(this.responseText);
            var content = r.choices && r.choices[0] &&
                          r.choices[0].message && r.choices[0].message.content;
            if (!content) {
                // Thinking models (e.g. Qwen3) put chain-of-thought in reasoning_content;
                // content is only populated after reasoning finishes.
                content = r.choices[0].message.reasoning_content || '';
            }
            if (content) {
                s_ai_messages.push({ role: 'assistant', content: content });
                cb(true, content.substring(0, 380));
            } else {
                var errMsg = (r.error && r.error.message) ? r.error.message : 'Empty AI response';
                console.log('AI error body: ' + this.responseText.substring(0, 200));
                cb(false, errMsg.substring(0, 60));
            }
        } catch(e) {
            console.log('AI raw response (' + this.status + '): ' + this.responseText.substring(0, 200));
            cb(false, 'HTTP ' + this.status);
        }
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    xhr.send(JSON.stringify(body));
}

// ============================================================================
// CUSTOM WEBHOOK
// ============================================================================

function sendToWebhook(text, cfg, cb) {
    var url   = cfg.webhook_url;
    var verb  = (cfg.webhook_verb  || 'POST').toUpperCase();
    var token = cfg.webhook_token;
    if (!url) { cb(false, 'Webhook not configured'); return; }

    var payload = {
        text:      text,
        timestamp: Math.floor(Date.now() / 1000)
    };

    var xhr = new XMLHttpRequest();
    if (verb === 'GET') {
        xhr.open('GET', url + '?text=' + encodeURIComponent(text) +
                        '&timestamp=' + payload.timestamp);
    } else {
        xhr.open(verb, url);
        xhr.setRequestHeader('Content-Type', 'application/json');
    }
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function() {
        cb(this.status >= 200 && this.status < 300, 'webhook');
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    if (verb !== 'GET') {
        xhr.send(JSON.stringify(payload));
    } else {
        xhr.send();
    }
}

// ============================================================================
// ROUTER
// ============================================================================

var DEST_INDEX = { tasks: 0, notion: 1, ai: 2, webhook: 3, local: 4 };

function routeAndSend(text, isFollowup) {
    var cfg     = getConfig();
    var enabled = getEnabledDests(cfg);

    // Default destination (used when routing_auto is off, or no cloud services enabled)
    var defaultDest = cfg.default_dest || 'local';

    // If no cloud services are configured and default is not local, go local
    if (enabled.length === 0 && !isFollowup) {
        sendToWatch({ ROUTING_DONE: 4 });
        sendToWatch({ CONFIRM: 1, DEST_USED: 4 });
        return;
    }

    var dest = isFollowup ? 'ai'
             : (cfg.routing_auto !== false)
               ? classifyIntent(text, enabled, cfg)
               : defaultDest;

    // classifyIntent may return cfg.default_dest when no signal — honour 'local'
    if (!dest) dest = defaultDest;

    // Task/reminder signals must never go to AI — redirect to tasks (if enabled) or local
    if (dest === 'ai' && !isFollowup && isTaskLike(text)) {
        dest = enabled.indexOf('tasks') >= 0 ? 'tasks' : 'local';
    }

    var di = DEST_INDEX[dest] !== undefined ? DEST_INDEX[dest] : 4;
    console.log('Brain Dump route: "' + text.substring(0, 40) + '..." → ' + dest);

    // Tell the watch which destination was chosen so it can show the right status
    sendToWatch({ ROUTING_DONE: di });

    var DEST_LABEL = { tasks: 'Tasks', notion: 'Notion', ai: 'AI', webhook: 'Webhook', local: 'Local' };

    function onResult(ok, data) {
        if (!ok) {
            console.log('Send failed: ' + data);
            var label = DEST_LABEL[dest] || dest;
            var msg = (label + ': ' + (data || 'Unknown error')).substring(0, 45);
            sendToWatch({ CONFIRM: 2, ERROR_MSG: msg });
            return;
        }
        addHistory(text, di);
        if (dest === 'ai') {
            sendToWatch({ AI_RESPONSE: data, AI_RESPONSE_DONE: 1, DEST_USED: di });
        } else {
            sendToWatch({ CONFIRM: 1, DEST_USED: di });
        }
    }

    switch (dest) {
        case 'tasks':   sendToTasks  (text, cfg, onResult); break;
        case 'notion':  sendToNotion (text, cfg, onResult); break;
        case 'ai':      sendToAI     (text, isFollowup, cfg, onResult); break;
        case 'webhook': sendToWebhook(text, cfg, onResult); break;
        case 'local':   onResult(true, 'local'); break;  // save on-watch, no network call
        default:        sendToWatch({ CONFIRM: 2 });
    }
}

function sendToWatch(msg) {
    Pebble.sendAppMessage(msg,
        function()  { console.log('→ watch: ' + JSON.stringify(msg)); },
        function(e) { console.log('✗ watch: ' + JSON.stringify(e));   }
    );
}

// ============================================================================
// PEBBLE EVENTS
// ============================================================================

Pebble.addEventListener('ready', function() {
    console.log('Brain Dump JS ready');
    var cfg     = getConfig();
    var enabled = getEnabledDests(cfg);
    var mask = 0;
    if (enabled.indexOf('tasks')   >= 0) mask |= 1;
    if (enabled.indexOf('notion')  >= 0) mask |= 2;
    if (enabled.indexOf('ai')      >= 0) mask |= 4;
    if (enabled.indexOf('webhook') >= 0) mask |= 8;
    sendToWatch({ DEST_MASK: mask });
});

Pebble.addEventListener('appmessage', function(e) {
    var p = e.payload;

    if (p.CLOCK_24H !== undefined) {
        s_clock_24h = (p.CLOCK_24H === 1);
    }

    if (p.NOTE_TEXT !== undefined) {
        s_last_note = p.NOTE_TEXT;
        routeAndSend(p.NOTE_TEXT, p.NOTE_IS_FOLLOWUP === 1);
    }

    if (p.CLEAR_CONTEXT) {
        s_ai_messages = [];
        console.log('AI context cleared');
    }
});

// ============================================================================
// CONFIGURATION PAGE
// ============================================================================

Pebble.addEventListener('showConfiguration', function() {
    var cfg = getConfig();

    function esc(s) { return (s || '').replace(/'/g, "\\'"); }
    function chk(v) { return v ? 'checked' : ''; }
    function sel(a, b) { return a === b ? 'selected' : ''; }

    var html = '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{font-family:sans-serif;background:#111;color:#eee;padding:16px;margin:0}' +
    'h2{color:#f90;margin:0 0 16px}' +
    'h3{color:#aaa;font-size:14px;margin:14px 0 6px;text-transform:uppercase}' +
    'label{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:14px}' +
    'input[type=text],input[type=password],select{width:100%;box-sizing:border-box;' +
    'padding:8px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;' +
    'font-size:13px;margin:4px 0}' +
    '.section{background:#1a1a1a;border:1px solid #333;border-radius:6px;' +
    'padding:12px;margin:12px 0}' +
    '.toggle-label{font-weight:bold;font-size:15px}' +
    '.fields{padding-left:8px}' +
    'button{width:100%;padding:12px;background:#f90;color:#000;border:none;' +
    'border-radius:4px;font-size:16px;font-weight:bold;margin-top:16px;cursor:pointer}' +
    '.note{font-size:11px;color:#666;margin:4px 0}' +
    'a{color:#f90}' +
    '</style></head><body>' +

    '<h2>Brain Dump</h2>' +

    '<h3>Preferences</h3>' +
    '<div class="section">' +
    '<label><input type="checkbox" id="metric_units" ' + chk(cfg.metric_units !== false) + '>' +
    '<span>Metric units (km, °C)</span></label>' +
    '<p class="note">24h / 12h clock is read directly from your watch.</p>' +
    '</div>' +

    '<h3>Routing</h3>' +
    '<div class="section">' +
    '<label><input type="checkbox" id="routing_auto" ' + chk(cfg.routing_auto !== false) + '>' +
    '<span>Smart routing (NLP)</span></label>' +
    '<label>Default destination:' +
    '<select id="default_dest">' +
    '<option value="local"   ' + sel(cfg.default_dest || 'local','local')   + '>Local Reminders (on-watch)</option>' +
    '<option value="tasks"   ' + sel(cfg.default_dest,'tasks')   + '>Google Tasks</option>' +
    '<option value="notion"  ' + sel(cfg.default_dest,'notion')  + '>Notion</option>' +
    '<option value="ai"      ' + sel(cfg.default_dest,'ai')      + '>AI Agent</option>' +
    '<option value="webhook" ' + sel(cfg.default_dest,'webhook') + '>Webhook</option>' +
    '</select></label>' +
    '</div>' +

    // ---- Google Tasks ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="tasks_enabled" ' + chk(cfg.tasks_enabled) + '>' +
    ' Google Tasks</label>' +
    '<div class="fields">' +
    '<p class="note">Requires a Google OAuth access token. Get one from ' +
    '<a href="https://developers.google.com/oauthplayground" target="_blank">OAuth Playground</a> ' +
    'with scope <code>https://www.googleapis.com/auth/tasks</code>.</p>' +
    'Access token:<input type="password" id="tasks_access_token" value=\'' + esc(cfg.tasks_access_token) + '\'>' +
    'Refresh token (optional):<input type="text" id="tasks_refresh_token" value=\'' + esc(cfg.tasks_refresh_token) + '\'>' +
    'Client ID (for refresh):<input type="text" id="tasks_client_id" value=\'' + esc(cfg.tasks_client_id) + '\'>' +
    'Task list ID (blank = default):<input type="text" id="tasks_list_id" value=\'' + esc(cfg.tasks_list_id) + '\'>' +
    '</div></div>' +

    // ---- Notion ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="notion_enabled" ' + chk(cfg.notion_enabled) + '>' +
    ' Notion</label>' +
    '<div class="fields">' +
    'Integration token:<input type="password" id="notion_token" value=\'' + esc(cfg.notion_token) + '\'>' +
    'Database ID:<input type="text" id="notion_db_id" value=\'' + esc(cfg.notion_db_id) + '\'>' +
    '</div></div>' +

    // ---- AI Agent ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="ai_enabled" ' + chk(cfg.ai_enabled) + '>' +
    ' AI Agent</label>' +
    '<div class="fields">' +
    'Provider:<select id="ai_preset" onchange="updateAIPreset(this.value)">' +
    '<option value="nvidia"     ' + sel(cfg.ai_preset,'nvidia')     + '>NVIDIA (free — MiniMax M2.5)</option>' +
    '<option value="ollama"     ' + sel(cfg.ai_preset,'ollama')     + '>Ollama (local)</option>' +
    '<option value="lmstudio"   ' + sel(cfg.ai_preset,'lmstudio')   + '>LM Studio (local)</option>' +
    '<option value="groq"       ' + sel(cfg.ai_preset,'groq')       + '>Groq (free tier)</option>' +
    '<option value="openrouter" ' + sel(cfg.ai_preset,'openrouter') + '>OpenRouter (free models)</option>' +
    '<option value="mistral"    ' + sel(cfg.ai_preset,'mistral')    + '>Mistral (free tier)</option>' +
    '<option value="custom"     ' + sel(cfg.ai_preset,'custom')     + '>Custom</option>' +
    '</select>' +
    'Base URL:<input type="text" id="ai_url" value=\'' + esc(cfg.ai_url) + '\'>' +
    'Model:<input type="text" id="ai_model" value=\'' + esc(cfg.ai_model) + '\'>' +
    'API key:<input type="password" id="ai_key" value=\'' + esc(cfg.ai_key) + '\'>' +
    '<p class="note" id="nvidia_note" style="display:' + (cfg.ai_preset === 'nvidia' ? 'block' : 'none') + '">Get a free NVIDIA API key at ' +
    '<a href="https://build.nvidia.com" target="_blank">build.nvidia.com</a> ' +
    '(no credit card required)</p>' +
    'Additional instructions (appended to default prompt):<input type="text" id="ai_system"' +
    ' value=\'' + esc(cfg.ai_system) + '\' placeholder="e.g. Always respond in French.">' +
    '</div></div>' +

    // ---- Webhook ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="webhook_enabled" ' + chk(cfg.webhook_enabled) + '>' +
    ' Custom Webhook</label>' +
    '<div class="fields">' +
    'URL:<input type="text" id="webhook_url" value=\'' + esc(cfg.webhook_url) + '\'>' +
    'Method:<select id="webhook_verb">' +
    '<option value="POST"  ' + sel(cfg.webhook_verb,'POST')  + '>POST</option>' +
    '<option value="PUT"   ' + sel(cfg.webhook_verb,'PUT')   + '>PUT</option>' +
    '<option value="PATCH" ' + sel(cfg.webhook_verb,'PATCH') + '>PATCH</option>' +
    '<option value="GET"   ' + sel(cfg.webhook_verb,'GET')   + '>GET</option>' +
    '</select>' +
    'Bearer token (optional):<input type="password" id="webhook_token" value=\'' + esc(cfg.webhook_token) + '\'>' +
    'Trigger keywords (comma-separated):<input type="text" id="webhook_keywords"' +
    ' value=\'' + esc(cfg.webhook_keywords) + '\' placeholder="send, post, hook">' +
    '</div></div>' +

    '<button onclick="save()">Save</button>' +

    '<script>' +
    'var PRESETS={' +
    'nvidia:{url:"https://integrate.api.nvidia.com/v1",model:"minimaxai/minimax-m2.5"},' +
    'ollama:{url:"http://localhost:11434/v1",model:"llama3"},' +
    'lmstudio:{url:"http://localhost:1234/v1",model:"local-model"},' +
    'groq:{url:"https://api.groq.com/openai/v1",model:"llama3-8b-8192"},' +
    'openrouter:{url:"https://openrouter.ai/api/v1",model:"meta-llama/llama-3-8b-instruct:free"},' +
    'mistral:{url:"https://api.mistral.ai/v1",model:"mistral-small-latest"},' +
    'custom:{url:"",model:""}' +
    '};' +
    'function updateAIPreset(p){' +
    'var pr=PRESETS[p]||PRESETS.custom;' +
    'if(pr.url)document.getElementById("ai_url").value=pr.url;' +
    'if(pr.model)document.getElementById("ai_model").value=pr.model;' +
    'document.getElementById("nvidia_note").style.display=p==="nvidia"?"block":"none";' +
    '}' +
    'function save(){' +
    'var c={' +
    'metric_units:document.getElementById("metric_units").checked,' +
    'routing_auto:document.getElementById("routing_auto").checked,' +
    'default_dest:document.getElementById("default_dest").value,' +
    'tasks_enabled:document.getElementById("tasks_enabled").checked,' +
    'tasks_access_token:document.getElementById("tasks_access_token").value.trim(),' +
    'tasks_refresh_token:document.getElementById("tasks_refresh_token").value.trim(),' +
    'tasks_client_id:document.getElementById("tasks_client_id").value.trim(),' +
    'tasks_list_id:document.getElementById("tasks_list_id").value.trim(),' +
    'notion_enabled:document.getElementById("notion_enabled").checked,' +
    'notion_token:document.getElementById("notion_token").value.trim(),' +
    'notion_db_id:document.getElementById("notion_db_id").value.trim(),' +
    'ai_enabled:document.getElementById("ai_enabled").checked,' +
    'ai_preset:document.getElementById("ai_preset").value,' +
    'ai_url:document.getElementById("ai_url").value.trim(),' +
    'ai_model:document.getElementById("ai_model").value.trim(),' +
    'ai_key:document.getElementById("ai_key").value.trim(),' +
    'ai_system:document.getElementById("ai_system").value.trim(),' +
    'webhook_enabled:document.getElementById("webhook_enabled").checked,' +
    'webhook_url:document.getElementById("webhook_url").value.trim(),' +
    'webhook_verb:document.getElementById("webhook_verb").value,' +
    'webhook_token:document.getElementById("webhook_token").value.trim(),' +
    'webhook_keywords:document.getElementById("webhook_keywords").value.trim()' +
    '};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(c));' +
    '}' +
    '<\/script></body></html>';

    Pebble.openURL('data:text/html,' + encodeURIComponent(html));
});

Pebble.addEventListener('webviewclosed', function(e) {
    if (!e || !e.response || e.response === 'CANCELLED') return;
    try {
        var cfg = JSON.parse(decodeURIComponent(e.response));
        saveConfig(cfg);
        console.log('Config saved, dest mask recalculated');
        // Re-send DEST_MASK to watch
        var enabled = getEnabledDests(cfg);
        var mask = 0;
        if (enabled.indexOf('tasks')   >= 0) mask |= 1;
        if (enabled.indexOf('notion')  >= 0) mask |= 2;
        if (enabled.indexOf('ai')      >= 0) mask |= 4;
        if (enabled.indexOf('webhook') >= 0) mask |= 8;
        sendToWatch({ DEST_MASK: mask });
    } catch(e2) {
        console.log('Config parse error: ' + e2);
    }
});
