// Brain Dump — PebbleKit JS
// Routes voice notes to Google Tasks / Notion / AI agent / Custom Webhook
// Intent classification runs locally; no extra API call needed for routing.

var KEY_CONFIG  = 'brain_dump_cfg_v1';
var KEY_HISTORY = 'brain_dump_hist_v1';

var TASKS_CLIENT_ID = '122599459809-1egpb0mrc97lpeh6fshnfv1i1drnvnkd.apps.googleusercontent.com';
// secrets.js is gitignored; secrets.example.js is the committed placeholder.
var TASKS_CLIENT_SECRET = '';
try { TASKS_CLIENT_SECRET = require('./secrets') || ''; } catch(e) {}

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
    if (cfg.todoist_enabled) d.push('todoist');
    if (cfg.notion_enabled)  d.push('notion');
    if (cfg.ai_enabled)      d.push('ai');
    if (cfg.webhook_enabled)   d.push('webhook');
    if (cfg.nextcloud_enabled) d.push('nextcloud');
    if (cfg.nextcloud_tasks_enabled) d.push('nextcloud_tasks');
    return d;
}

var TASK_SIGNALS = [
    // English
    'remind me', 'add task', 'add a task', 'to do', 'todo',
    "don't forget", "remember to", 'need to', 'have to',
    'buy ', 'call ', 'email ', 'schedule', 'appointment', 'meeting', 'pick up', 'book ',
    // German
    'erinner', 'aufgabe', 'erinnerung', 'kaufen', 'anrufen', 'nicht vergessen',
    'muss ', 'termin', 'treffen', 'buchen', 'schick',
    // French
    'rappelle', 'tâche', 'tache', "n'oublie pas", 'rappel',
    'acheter', 'appeler', 'rendez-vous', 'réunion', 'reunion', 'réserver',
    // Spanish
    'recuérdame', 'recuerdame', 'tarea', 'no olvides', 'no te olvides',
    'comprar', 'llamar', 'cita ', 'reunión', 'reunion', 'reservar'
];

function getCustomKeywords(cfg, dest) {
    var raw = (cfg[dest + '_keywords'] || '').toLowerCase().split(',');
    return raw.map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
}

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
        var qw = [
            // English
            'what ','how ','why ','who ','where ','when ','is ','are ','can ',
            'could ','should ','will ','would ',"what's","how's",
            // German
            'was ','wie ','warum ','wer ','wo ','wann ','ist ','sind ','kann ',
            'k\xf6nnte ','sollte ','wird ','w\xfcrde ',
            // French
            'quoi ','comment ','pourquoi ','qui ','o\xf9 ','quand ',
            "qu'est","c'est quoi",'dis-moi',
            // Spanish
            'qu\xe9 ','c\xf3mo ','por qu\xe9 ','qui\xe9n ','d\xf3nde ','cu\xe1ndo ','cu\xe1l '
        ];
        var phrases = [
            // English
            'explain','tell me','help me','define ','look up','search for','give me','translate',
            // German
            'erkl\xe4r','sag mir','hilf mir','\xfcbersetze',
            // French
            'explique','dis-moi','aide-moi','traduis',
            // Spanish
            'explica','d\xedme','ay\xfadame','traduce'
        ];
        if (t.charAt(t.length - 1) === '?') scores['ai'] += 3;
        if (t.indexOf('ask ') === 0) scores['ai'] += 2;
        qw.forEach(function(w) { if (t.indexOf(w) === 0) scores['ai'] += 2; });
        phrases.forEach(function(p) { if (t.indexOf(p) >= 0) scores['ai'] += 1; });
        if (t.indexOf('a.i.') >= 0 ||
            t.indexOf(' ai ') >= 0 || t.indexOf('ai ') === 0 ||
            t.indexOf(' ai,') >= 0 || t.indexOf(' ai.') >= 0) {
            scores['ai'] += 4;
        }
        getCustomKeywords(cfg, 'ai').forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['ai'] += 2;
        });
    }

    // Shared date/time modifiers (used by both tasks and todoist)
    var tw = [
        'tomorrow','tonight','today','monday','tuesday','wednesday',
        'thursday','friday','saturday','sunday',
        'next week','this week','next month','by ','noon','midnight',"o'clock",' am',' pm',
        'morgen ','heute ','montag','dienstag','mittwoch','donnerstag',
        'freitag','samstag','sonntag','n\xe4chste woche','diesen monat',
        'demain','aujourd','lundi','mardi','mercredi','jeudi',
        'vendredi','samedi','dimanche','semaine prochaine',
        'ma\xf1ana','hoy ','lunes','martes','mi\xe9rcoles','jueves',
        'viernes','s\xe1bado','domingo','la semana que viene'
    ];

    // Task signals — Google Tasks
    if (scores['tasks'] !== undefined) {
        TASK_SIGNALS.forEach(function(p) { if (t.indexOf(p) >= 0) scores['tasks'] += 2; });
        tw.forEach(function(w) { if (t.indexOf(w) >= 0) scores['tasks'] += 1; });
        // Google Tasks–specific keywords (disambiguate when Todoist is also enabled)
        ['google task', 'google tasks', 'add to google', 'gtask'].forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['tasks'] += 4;
        });
        getCustomKeywords(cfg, 'tasks').forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['tasks'] += 2;
        });
    }

    // Task signals — Todoist
    if (scores['todoist'] !== undefined) {
        TASK_SIGNALS.forEach(function(p) { if (t.indexOf(p) >= 0) scores['todoist'] += 2; });
        tw.forEach(function(w) { if (t.indexOf(w) >= 0) scores['todoist'] += 1; });
        // Todoist-specific keywords
        ['todoist', 'add to todoist', 'in todoist', 'to-do', 'todo', 'to do'].forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['todoist'] += 4;
        });
        getCustomKeywords(cfg, 'todoist').forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['todoist'] += 2;
        });
    }

    // Shared note-taking signals (used by both Notion and Nextcloud)
    var noteSignals = [
        'note','write down','save this','document','jot',
        'record that','add to my notes','log this','idea','memo','keep in mind',
        'notiz','aufschreiben','speichern','idee','festhalten',
        'noter','sauvegarder','id\xe9e','conserver',
        'nota','anotar','guardar','apuntar'
    ];

    // Notion signals
    if (scores['notion'] !== undefined) {
        noteSignals.forEach(function(p) { if (t.indexOf(p) >= 0) scores['notion'] += 2; });
        ['notion', 'add to notion', 'save to notion'].forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['notion'] += 4;
        });
        getCustomKeywords(cfg, 'notion').forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['notion'] += 2;
        });
    }

    // Nextcloud signals
    if (scores['nextcloud'] !== undefined) {
        noteSignals.forEach(function(p) { if (t.indexOf(p) >= 0) scores['nextcloud'] += 2; });
        ['nextcloud', 'add to nextcloud', 'save to nextcloud'].forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['nextcloud'] += 4;
        });
        getCustomKeywords(cfg, 'nextcloud').forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['nextcloud'] += 2;
        });
    }

    // Task signals — Nextcloud Tasks (CalDAV)
    if (scores['nextcloud_tasks'] !== undefined) {
        TASK_SIGNALS.forEach(function(p) { if (t.indexOf(p) >= 0) scores['nextcloud_tasks'] += 2; });
        tw.forEach(function(w) { if (t.indexOf(w) >= 0) scores['nextcloud_tasks'] += 1; });
        ['nextcloud task', 'nextcloud tasks', 'add to nextcloud tasks'].forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['nextcloud_tasks'] += 4;
        });
        getCustomKeywords(cfg, 'nextcloud_tasks').forEach(function(k) {
            if (t.indexOf(k) >= 0) scores['nextcloud_tasks'] += 2;
        });
    }

    // Webhook: configured trigger keywords
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

// Number words (English, German, French, Spanish) used in time expressions
var _NUM_WORDS = {
    // English
    'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,
    'seven':7,'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,
    // German (accented + plain-ASCII variants for voice-to-text)
    'eins':1,'zwei':2,'drei':3,'vier':4,'f\xfcnf':5,'funf':5,
    'sechs':6,'sieben':7,'acht':8,'neun':9,'zehn':10,'elf':11,'zw\xf6lf':12,'zwolf':12,
    // French ('six' already covered by English entry)
    'une':1,'deux':2,'trois':3,'quatre':4,'cinq':5,
    'sept':7,'huit':8,'neuf':9,'dix':10,'onze':11,'douze':12,
    // Spanish ('seis' = 6, same as English 'six' — both map to 6)
    'dos':2,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,
    'nueve':9,'diez':10,'once':11,'doce':12
};
// Alternation pattern — longer words before any that are their prefix
var _NUM_PAT = [
    'eleven','twelve','seven','eight','three','four','five','nine','six','ten','two','one',
    'sieben','sechs','neun','zehn','vier','acht','elf','f\xfcnf','funf','zwei','drei',
    'eins','zw\xf6lf','zwolf',
    'quatre','trois','onze','douze','deux','cinq','sept','huit','neuf','dix','une',
    'cuatro','cinco','siete','ocho','nueve','diez','seis','once','doce','dos'
].join('|');

// Pick the next occurrence of an ambiguous 12h hour given the current hour.
// If both AM and PM are still future, prefer the nearer one.
function disambiguate(h, min, nowHour) {
    if (h === 0 || h > 12) return { h: h, m: min };
    var asAM = (h === 12) ? 0  : h;
    var asPM = (h === 12) ? 12 : h + 12;
    if (nowHour >= asPM) return { h: asAM, m: min }; // past PM  → next is AM
    if (nowHour >= asAM) return { h: asPM, m: min }; // past AM  → next is PM
    return ((asPM - nowHour) <= (asAM - nowHour))    // both future → nearer
        ? { h: asPM, m: min } : { h: asAM, m: min };
}

// "a.m." / "a. m." / "am" → "am";  "p.m." → "pm"
function _normAP(s) { return s.replace(/[\s.]/g, ''); }

// Detect AM/PM intent from qualifier words in the text (e.g. "du matin", "abends").
// Returns 'am', 'pm', or null.
function _inlineAP(t) {
    if (t.indexOf('du matin')  >= 0 || t.indexOf('am morgen')  >= 0 ||
        t.indexOf('de manana') >= 0 || t.indexOf('de ma\xf1ana') >= 0 ||
        /\b(matin|morgens|morning|ma\xf1ana|manana|madrugada)\b/.test(t))
        return 'am';
    if (t.indexOf('du soir')       >= 0 || t.indexOf('de la tarde')  >= 0 ||
        t.indexOf('de la noche')   >= 0 || t.indexOf('am abend')     >= 0 ||
        /\b(soir|abend|abends|evening|noche|tarde|nachmittag)\b/.test(t))
        return 'pm';
    return null;
}

// Apply AM/PM to an ambiguous hour h: use inline qualifier first, then clock context.
function _withAP(h, min, t, nowHour) {
    if (h >= 13) return { h: h, m: min };
    var ap = _inlineAP(t);
    if (ap === 'am') return { h: (h === 12 ? 0  : h),     m: min };
    if (ap === 'pm') return { h: (h <  12 ? h + 12 : h),  m: min };
    return disambiguate(h, min, nowHour);
}

function extractTime(text, nowHour) {
    var t = text.toLowerCase();
    // nowHour 0-23: callers pass new Date().getHours(); tests pass a fixed value.
    if (nowHour === undefined) nowHour = new Date().getHours();

    // Plain-substring helper — avoids regex word-boundary issues with accented chars.
    function has() {
        for (var i = 0; i < arguments.length; i++)
            if (t.indexOf(arguments[i]) >= 0) return true;
        return false;
    }

    // ── Numeric patterns first ──────────────────────────────────────────────
    // Checked before named expressions so "6 heures du matin" → 06:00, not 09:00.

    // AM/PM explicit — digits; handles am/pm/a.m./p.m./a. m. with any spacing
    var m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)(?!\w)/);
    if (m) {
        var h = parseInt(m[1], 10), min = m[2] ? parseInt(m[2], 10) : 0;
        var ap = _normAP(m[3]);
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return { h: h, m: min };
    }

    // AM/PM — number words: "six pm", "six a.m."
    m = t.match(new RegExp('\\b(' + _NUM_PAT + ')\\s+([ap]\\.?\\s?m\\.?)(?!\\w)'));
    if (m) {
        var h = _NUM_WORDS[m[1]], ap = _normAP(m[2]);
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return { h: h, m: 0 };
    }

    // French/Spanish compact: "16h", "6h30", "6h 30"
    // (digit immediately before 'h' — "6 heures" is caught by the next pattern)
    m = t.match(/\b(\d{1,2})h\s?(\d{2})?\b/);
    if (m) return _withAP(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, t, nowHour);

    // French long form:  "6 heures [30]", "16 heures"
    // German:            "6 Uhr [30]",    "16 Uhr"
    m = t.match(/\b(\d{1,2})\s+(?:heures?|uhr)\b(?:\s+(\d{1,2}))?\b/);
    if (m) return _withAP(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, t, nowHour);

    // Same but with number words: "six heures", "six uhr"
    m = t.match(new RegExp('\\b(' + _NUM_PAT + ')\\s+(?:heures?|uhr)\\b'));
    if (m) return _withAP(_NUM_WORDS[m[1]], 0, t, nowHour);

    // Spanish: "las 6", "las 6 y media" (+30), "las 6 y cuarto" (+15)
    m = t.match(/\blas\s+(\d{1,2})\b/);
    if (m) {
        var extra = t.indexOf('y media') >= 0 ? 30 : t.indexOf('y cuarto') >= 0 ? 15 : 0;
        return _withAP(parseInt(m[1], 10), extra, t, nowHour);
    }
    m = t.match(new RegExp('\\blas\\s+(' + _NUM_PAT + ')\\b'));
    if (m) {
        var extra = t.indexOf('y media') >= 0 ? 30 : t.indexOf('y cuarto') >= 0 ? 15 : 0;
        return _withAP(_NUM_WORDS[m[1]], extra, t, nowHour);
    }

    // 24-hour HH:MM — unambiguous when hour ≥ 13 or leading zero present ("09:30")
    m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m) {
        var h24 = parseInt(m[1], 10), m24 = parseInt(m[2], 10);
        if (h24 >= 13 || m[1].length === 2) return { h: h24, m: m24 };
        return disambiguate(h24, m24, nowHour);
    }

    // o'clock — digits, then number words
    m = t.match(/\b(\d{1,2})\s*o'?clock\b/);
    if (m) return disambiguate(parseInt(m[1], 10), 0, nowHour);
    m = t.match(new RegExp('\\b(' + _NUM_PAT + ")\\s*o'?clock\\b"));
    if (m) return disambiguate(_NUM_WORDS[m[1]], 0, nowHour);

    // Bare "at <n>" — context-disambiguated
    m = t.match(/\bat\s+(\d{1,2})\b(?!\s*[:\d])/);
    if (m) return disambiguate(parseInt(m[1], 10), 0, nowHour);
    m = t.match(new RegExp('\\bat\\s+(' + _NUM_PAT + ')\\b'));
    if (m) return disambiguate(_NUM_WORDS[m[1]], 0, nowHour);

    // ── Named time expressions (fallback when no numeric time found) ─────────
    // ORDERING: more-specific phrases before any shorter phrase they contain:
    //   "afternoon" ⊃ "noon",  "nachmittag" ⊃ "mittag",  "après-midi" ⊃ "midi"
    //   "esta noche temprano" ⊃ "esta noche"

    // Breakfast (~08:00)
    if (has('at breakfast', 'for breakfast',
            'beim fr\xfchst\xfcck', 'zum fr\xfchst\xfcck', 'beim fruhstuck', 'zum fruhstuck',
            'au petit-d\xe9jeuner', 'au petit dejeuner',
            'en el desayuno', 'para el desayuno'))
        return { h: 8, m: 0 };

    // Morning (~09:00)
    if (has('this morning', 'in the morning', 'early morning',
            'heute morgen', 'am morgen', 'morgens', 'fr\xfchmorgens', 'fruhmorgens',
            'ce matin', 'le matin', 'du matin',
            'esta ma\xf1ana', 'esta manana', 'por la ma\xf1ana', 'por la manana'))
        return { h: 9, m: 0 };

    // Afternoon (~14:00) — before noon
    if (has('this afternoon', 'in the afternoon',
            'heute nachmittag', 'am nachmittag', 'nachmittags',
            'cet apr\xe8s-midi', 'cet apres-midi', "l'apr\xe8s-midi", "l'apres-midi",
            'esta tarde', 'por la tarde', 'de tarde'))
        return { h: 14, m: 0 };

    // Evening (~18:00) — before tonight
    if (has('this evening', 'in the evening',
            'heute abend', 'am abend', 'abends',
            'ce soir', 'le soir', 'du soir',
            'esta noche temprano'))
        return { h: 18, m: 0 };

    // Noon / lunch (~12:00)
    if (has('noon', 'lunchtime', 'at lunch',
            'mittag', 'mittagessen', 'zu mittag', 'zum mittagessen',
            'midi', 'au d\xe9jeuner', 'au dejeuner',
            'mediod\xeda', 'mediodia', 'al mediod\xeda', 'al mediodia', 'almuerzo'))
        return { h: 12, m: 0 };

    // Midnight (~00:00)
    if (has('midnight', 'mitternacht', 'minuit', 'medianoche'))
        return { h: 0, m: 0 };

    // Tonight / at night (~20:00)
    if (has('tonight', 'at night',
            'heute nacht', 'in der nacht', 'nachts',
            'cette nuit', 'la nuit',
            'esta noche', 'por la noche', 'de noche'))
        return { h: 20, m: 0 };

    // Dinner (~19:00)
    if (has('at dinner', 'at dinnertime', 'for dinner',
            'beim abendessen', 'zum abendessen',
            'au d\xeener', 'au diner',
            'en la cena', 'para cenar', 'a cenar'))
        return { h: 19, m: 0 };

    return null;
}

function extractDueDate(text) {
    var t = text.toLowerCase();
    var now = new Date(), d = null;

    // Day-after-tomorrow — checked before "tomorrow" so it isn't shadowed.
    if (/(day after tomorrow|[\xfcu]bermorgen|apr[e\xe8]s-demain|pasado\s+ma[n\xf1]ana)/.test(t)) {
        d = new Date(now); d.setDate(d.getDate() + 2);
    }
    // Tomorrow — EN/FR + DE "morgen" (but not "heute/am morgen" = this morning)
    // + ES "mañana" (but not "(esta|por la|de la) mañana" = this morning).
    else if (/\b(tomorrow|demain)\b/.test(t) ||
             (/\bmorgen\b/.test(t)    && !/\b(?:heute|am)\s+morgen\b/.test(t)) ||
             (/\bma[n\xf1]ana\b/.test(t) && !/(?:esta|por\s+la|de\s+la|la)\s+ma[n\xf1]ana/.test(t))) {
        d = new Date(now); d.setDate(d.getDate() + 1);
    }
    else if (/\b(today|tonight|heute|aujourd|hoy)\b/.test(t)) {
        d = new Date(now);
    }
    else {
        // Weekday names EN/DE/FR/ES → index 0=Sun .. 6=Sat.
        var WD = [
            ['sunday','sonntag','dimanche','domingo'],
            ['monday','montag','lundi','lunes'],
            ['tuesday','dienstag','mardi','martes'],
            ['wednesday','mittwoch','mercredi','mi\xe9rcoles','miercoles'],
            ['thursday','donnerstag','jeudi','jueves'],
            ['friday','freitag','vendredi','viernes'],
            ['saturday','samstag','sonnabend','samedi','s\xe1bado','sabado']
        ];
        for (var i = 0; i < 7 && !d; i++) {
            for (var j = 0; j < WD[i].length; j++) {
                if (t.indexOf(WD[i][j]) >= 0) {
                    d = new Date(now);
                    var diff = (i - d.getDay() + 7) % 7 || 7;
                    d.setDate(d.getDate() + diff);
                    break;
                }
            }
        }
    }
    // If only a time is mentioned (no date), default to today
    if (!d && extractTime(text)) d = new Date(now);
    return d ? d.toISOString().split('T')[0] + 'T00:00:00.000Z' : null;
}

// cb(newToken, invalidGrant)
// newToken: string on success, null on failure
// invalidGrant: true when Google says the refresh token is revoked/expired → user must reconnect
function refreshGoogleToken(cfg, cb) {
    if (!cfg.tasks_refresh_token) { cb(null, false); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://oauth2.googleapis.com/token');
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onload = function() {
        try {
            var r = JSON.parse(this.responseText);
            if (r.access_token) { cb(r.access_token, false); }
            else { cb(null, r.error === 'invalid_grant'); }
        }
        catch(e) { cb(null, false); }
    };
    xhr.onerror = function() { cb(null, false); };
    xhr.send(
        'grant_type=refresh_token' +
        '&refresh_token=' + encodeURIComponent(cfg.tasks_refresh_token) +
        '&client_id='     + encodeURIComponent(TASKS_CLIENT_ID) +
        '&client_secret=' + encodeURIComponent(TASKS_CLIENT_SECRET)
    );
}

function sendToTasks(text, cfg, cb) {
    var token  = cfg.tasks_access_token;
    var listId = cfg.tasks_list_id || '@default';
    if (!token) { cb(false, 'Google not authenticated'); return; }

    var due  = extractDueDate(text);
    var time = extractTime(text);
    var task = { title: due ? stripDateTimeFromText(text) : text };
    if (due) task.due = due;
    if (time) {
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        task.notes = 'Due at ' + pad(time.h) + ':' + pad(time.m);
    }

    function doPost(accessToken) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://tasks.googleapis.com/tasks/v1/lists/' +
                          encodeURIComponent(listId) + '/tasks');
        xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            if (this.status >= 200 && this.status < 300) {
                var taskId = null;
                try {
                    var created = JSON.parse(this.responseText);
                    if (created && created.id) taskId = created.id;
                } catch (e) {}
                cb(true, taskId ? { taskId: taskId } : 'tasks');
            } else if (this.status === 401) {
                // Token expired — try refresh
                refreshGoogleToken(cfg, function(newToken, invalidGrant) {
                    if (newToken) {
                        cfg.tasks_access_token = newToken;
                        saveConfig(cfg);
                        doPost(newToken);
                    } else {
                        cb(false, invalidGrant
                            ? 'Token revoked — reconnect in settings'
                            : 'Auth error — try again');
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

function completeGoogleTask(taskId, cfg, cb) {
    var token  = cfg.tasks_access_token;
    var listId = cfg.tasks_list_id || '@default';
    if (!token || !taskId) { cb(false, 'Google not authenticated'); return; }

    function doPatch(accessToken) {
        var xhr = new XMLHttpRequest();
        xhr.open('PATCH', 'https://tasks.googleapis.com/tasks/v1/lists/' +
                          encodeURIComponent(listId) + '/tasks/' +
                          encodeURIComponent(taskId));
        xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            if (this.status >= 200 && this.status < 300) {
                cb(true);
            } else if (this.status === 401) {
                refreshGoogleToken(cfg, function(newToken, invalidGrant) {
                    if (newToken) {
                        cfg.tasks_access_token = newToken;
                        saveConfig(cfg);
                        doPatch(newToken);
                    } else {
                        cb(false, invalidGrant
                            ? 'Token revoked — reconnect in settings'
                            : 'Auth error — try again');
                    }
                });
            } else {
                cb(false, 'Tasks error ' + this.status);
            }
        };
        xhr.onerror = function() { cb(false, 'Network error'); };
        xhr.send(JSON.stringify({ status: 'completed' }));
    }

    doPatch(token);
}

// ============================================================================
// NOTION
// ============================================================================

function extractNotionPageId(urlOrId) {
    if (!urlOrId) return '';
    urlOrId = urlOrId.trim();
    // UUID format (with dashes): xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    var m = urlOrId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) return m[1];
    // Plain 32-char hex (Notion URL suffix)
    m = urlOrId.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i);
    if (m) return m[1];
    return urlOrId; // already an ID or unknown — pass through
}

function sendToNotion(text, cfg, cb) {
    var token = cfg.notion_token;
    var id    = extractNotionPageId(cfg.notion_page_id);
    if (!token || !id) { cb(false, 'Notion not configured'); return; }

    var override = (cfg.notion_title_prop || '').trim();

    // Auto-detect the target's nature so the user just pastes a URL/ID: GET the
    // database endpoint — 2xx means it's a database (and the same response
    // carries its schema, so we also learn the title-property name); anything
    // else means treat it as a page and append a block. One probe, no toggle.
    var q = new XMLHttpRequest();
    q.open('GET', 'https://api.notion.com/v1/databases/' + id);
    q.setRequestHeader('Authorization', 'Bearer ' + token);
    q.setRequestHeader('Notion-Version', '2022-06-28');
    q.onload = function() {
        if (this.status >= 200 && this.status < 300) {
            // Database → create a new row with the note as its title.
            var titleProp = override || 'Name';
            if (!override) {
                try {
                    var db = JSON.parse(this.responseText);
                    for (var k in db.properties) {
                        if (db.properties[k] && db.properties[k].type === 'title') { titleProp = k; break; }
                    }
                } catch (e) {}
            }
            createNotionDbPage(text, token, id, titleProp, cb);
        } else if (this.status === 401) {
            cb(false, 'Invalid Notion token');
        } else {
            // Not a database (a page, or not shared) → append as a block.
            // appendNotionBlock surfaces its own not-found/not-shared error.
            appendNotionBlock(text, token, id, cb);
        }
    };
    q.onerror = function() { cb(false, 'Network error'); };
    q.send();
}

function appendNotionBlock(text, token, pageId, cb) {
    var body = {
        children: [{
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: text.substring(0, 2000) } }]
            }
        }]
    };
    var xhr = new XMLHttpRequest();
    xhr.open('PATCH', 'https://api.notion.com/v1/blocks/' + pageId + '/children');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Notion-Version', '2022-06-28');
    xhr.onload = function() {
        if (this.status >= 200 && this.status < 300) { cb(true, 'notion'); }
        else if (this.status === 401) { cb(false, 'Invalid Notion token'); }
        else if (this.status === 404) { cb(false, 'Page not found / not shared'); }
        else { cb(false, 'Notion error ' + this.status); }
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    xhr.send(JSON.stringify(body));
}

// Create a new page (row) inside a Notion database, with the note as its title.
// titleProp is the database's title-column name (auto-detected by the caller).
function createNotionDbPage(text, token, dbId, titleProp, cb) {
    var props = {};
    props[titleProp] = { title: [{ text: { content: text.substring(0, 2000) } }] };
    var body = { parent: { database_id: dbId }, properties: props };
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.notion.com/v1/pages');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Notion-Version', '2022-06-28');
    xhr.onload = function() {
        if (this.status >= 200 && this.status < 300) { cb(true, 'notion'); }
        else if (this.status === 401) { cb(false, 'Invalid Notion token'); }
        else if (this.status === 404) { cb(false, 'Database not found / not shared'); }
        else if (this.status === 400) {
            console.log('Notion DB 400: ' + this.responseText);
            cb(false, 'Check title property "' + titleProp + '"');
        }
        else { cb(false, 'Notion error ' + this.status); }
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

function buildWebhookPayload(text) {
    return {
        text:      text,
        timestamp: Math.floor(Date.now() / 1000)
    };
}

// Substitute {text}/{timestamp}/{json} placeholders in a webhook URL. Returns
// the URL unchanged when it has no placeholders.
function applyWebhookTemplate(url, payload) {
    var json = encodeURIComponent(JSON.stringify(payload));
    return url
        .replace(/\{text\}/g, encodeURIComponent(payload.text))
        .replace(/\{timestamp\}/g, String(payload.timestamp))
        .replace(/\{json\}/g, json);
}

// Templated URL wins; else for GET append text/timestamp query params as before.
function buildWebhookUrl(url, verb, payload) {
    var templatedUrl = applyWebhookTemplate(url, payload);
    if (templatedUrl !== url) return templatedUrl;
    if (verb !== 'GET') return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') +
        'text=' + encodeURIComponent(payload.text) +
        '&timestamp=' + payload.timestamp;
}

function sendToWebhook(text, cfg, cb) {
    var url   = cfg.webhook_url;
    var verb  = (cfg.webhook_verb  || 'POST').toUpperCase();
    var token = cfg.webhook_token;
    if (!url) { cb(false, 'Webhook not configured'); return; }

    var payload  = buildWebhookPayload(text);
    var finalUrl = buildWebhookUrl(url, verb, payload);

    var xhr = new XMLHttpRequest();
    if (verb === 'GET') {
        xhr.open('GET', finalUrl);
    } else {
        xhr.open(verb, finalUrl);
        xhr.setRequestHeader('Content-Type', 'application/json');
    }
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function() {
        var isOk = this.status >= 200 && this.status < 300;
        // Surface the webhook's response body to the watch when present, so the
        // endpoint can reply back (e.g. confirmation text). Falls back to 'webhook'.
        var data = 'webhook';
        if (isOk && this.responseText) {
            var rt = this.responseText.trim();
            if (rt.length > 0) data = rt;
        }
        cb(isOk, data);
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    if (verb !== 'GET') {
        xhr.send(JSON.stringify(payload));
    } else {
        xhr.send();
    }
}

// ============================================================================
// TODOIST
// ============================================================================

function guessPriority(text) {
    var t = text.toLowerCase();
    if (/\b(urgent|urgently|asap|immediately|critical|emergency|right now|right away|top priority)\b/.test(t))
        return 4; // urgent (red)
    if (/\b(important|high priority|must|crucial|vital|definitely|priority)\b/.test(t))
        return 3; // high (orange)
    if (/\b(soon|medium priority|when possible|should)\b/.test(t))
        return 2; // medium (blue)
    return 1;     // normal
}

function sendToTodoist(text, cfg, cb) {
    var token = cfg.todoist_token;
    if (!token) { cb(false, 'Todoist not authenticated'); return; }

    var dueDate = extractDueDate(text);
    var body = { content: dueDate ? stripDateTimeFromText(text) : text };
    if (cfg.todoist_project_id) body.project_id = cfg.todoist_project_id;

    // Build ISO due date/time
    if (dueDate) {
        var dueTime = extractTime(text);
        if (dueTime) {
            function pad(n) { return n < 10 ? '0' + n : '' + n; }
            body.due_datetime = dueDate.substring(0, 10) + 'T' +
                                pad(dueTime.h) + ':' + pad(dueTime.m) + ':00';
        } else {
            body.due_date = dueDate.substring(0, 10);
        }
    }

    var priority = guessPriority(text);
    if (priority > 1) body.priority = priority;

    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.todoist.com/api/v1/tasks');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
        if (this.status >= 200 && this.status < 300) {
            cb(true, 'todoist');
        } else if (this.status === 401) {
            cb(false, 'Invalid API key');
        } else {
            cb(false, 'Error ' + this.status);
        }
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    xhr.send(JSON.stringify(body));
}

// ============================================================================
// NEXTCLOUD NOTES
// ============================================================================

function btoa64(str) {
    var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var r = '';
    for (var i = 0; i < str.length; i += 3) {
        var b0 = str.charCodeAt(i);
        var b1 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        var b2 = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
        r += c[b0 >> 2];
        r += c[((b0 & 3) << 4) | (b1 >> 4)];
        r += i + 1 < str.length ? c[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        r += i + 2 < str.length ? c[b2 & 63] : '=';
    }
    return r;
}

function sendToNextcloud(text, cfg, cb) {
    var instance = (cfg.nextcloud_url || '').replace(/\/$/, '');
    var user     = cfg.nextcloud_user;
    var pass     = cfg.nextcloud_pass;
    if (!instance || !user || !pass) { cb(false, 'Nextcloud Notes not configured'); return; }

    var body = {
        title:    text.substring(0, 80),
        content:  text,
        category: cfg.nextcloud_category || ''
    };

    var xhr = new XMLHttpRequest();
    xhr.open('POST', instance + '/index.php/apps/notes/api/v1/notes');
    xhr.setRequestHeader('Authorization', 'Basic ' + btoa64(user + ':' + pass));
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('OCS-APIREQUEST', 'true');
    xhr.onload = function() {
        if (this.status >= 200 && this.status < 300) {
            cb(true, 'nextcloud');
        } else if (this.status === 401) {
            cb(false, 'Invalid credentials');
        } else {
            cb(false, 'Error ' + this.status);
        }
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    xhr.send(JSON.stringify(body));
}

// ============================================================================
// NEXTCLOUD TASKS  (CalDAV / VTODO)
// ============================================================================

// Pull the human-readable reason out of a Sabre/DAV XML error body, if present.
function sabreError(body) {
    if (!body) return '';
    var m = body.match(/<s:message>([\s\S]*?)<\/s:message>/i) ||
            body.match(/<s:exception>([\s\S]*?)<\/s:exception>/i);
    return m ? m[1].replace(/^Sabre\\[\w\\]*\\/, '').trim() : '';
}

// Escape a string for an iCalendar TEXT value (RFC 5545 §3.3.11).
function icalEscape(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

function sendToNextcloudTasks(text, cfg, cb) {
    var instance = (cfg.nextcloud_tasks_url || '').replace(/\/$/, '');
    var user     = cfg.nextcloud_tasks_user;
    var pass     = cfg.nextcloud_tasks_pass;
    var list     = (cfg.nextcloud_tasks_list || 'personal').replace(/^\/|\/$/g, '');
    if (!instance || !user || !pass) { cb(false, 'Nextcloud Tasks not configured'); return; }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    var dueDate = extractDueDate(text);
    var summary = dueDate ? stripDateTimeFromText(text) : text;

    var dueLine = '';
    if (dueDate) {
        var ymd = dueDate.substring(0, 10).replace(/-/g, '');
        var dueTime = extractTime(text);
        dueLine = dueTime
            ? 'DUE:' + ymd + 'T' + pad(dueTime.h) + pad(dueTime.m) + '00'
            : 'DUE;VALUE=DATE:' + ymd;
    }

    var gp = guessPriority(text);
    var prio = gp === 4 ? 1 : gp === 3 ? 3 : gp === 2 ? 5 : 0;

    var now = new Date();
    var dtstamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
                  'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
    var slug = 'braindump-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    var uid  = slug + '@pebble';

    var lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Brain Dump//Pebble//EN',
        'BEGIN:VTODO',
        'UID:' + uid,
        'DTSTAMP:' + dtstamp,
        'SUMMARY:' + icalEscape(summary),
        'STATUS:NEEDS-ACTION'
    ];
    if (prio > 0) lines.push('PRIORITY:' + prio);
    if (dueLine)  lines.push(dueLine);
    lines.push('END:VTODO');
    lines.push('END:VCALENDAR');
    var ics = lines.join('\r\n') + '\r\n';

    var url = instance + '/remote.php/dav/calendars/' +
              encodeURIComponent(user) + '/' + encodeURIComponent(list) + '/' + slug + '.ics';

    var xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', 'Basic ' + btoa64(user + ':' + pass));
    xhr.setRequestHeader('Content-Type', 'text/calendar; charset=utf-8');
    xhr.onload = function() {
        if (this.status >= 200 && this.status < 300) {
            cb(true, 'nextcloud_tasks');
        } else if (this.status === 401) {
            cb(false, 'Invalid credentials');
        } else if (this.status === 403) {
            console.log('Nextcloud Tasks 403 body: ' + this.responseText);
            var why = sabreError(this.responseText);
            cb(false, why ? '403: ' + why : 'Forbidden: list "' + list + '" rejects tasks?');
        } else if (this.status === 404) {
            cb(false, 'List not found: ' + list);
        } else {
            cb(false, 'Error ' + this.status);
        }
    };
    xhr.onerror = function() { cb(false, 'Network error'); };
    xhr.send(ics);
}

// ============================================================================
// TEXT CLEANING
// ============================================================================

// Strip common command prefix/suffix preambles before sending note to destination.
// EN/DE/FR/ES patterns. Falls back to original if result is trivially short.
function cleanNoteText(text) {
    var t = text.trim();
    var original = t;

    // ── Prefix (first match wins) ──────────────────────────────────────────
    var prefixRe = [
        // EN — politeness header
        /^(?:can\s+you\s+)?please\s+(?=\S)/i,
        // EN — reminder / task verbs
        /^(?:please\s+)?remind\s+(?:me\s+)?(?:to\s+|that\s+|about\s+)?/i,
        /^(?:don'?t|do\s+not)\s+forget\s+(?:to\s+|that\s+|about\s+)?/i,
        /^remember\s+(?:to\s+|that\s+)?/i,
        /^i\s+(?:need|have|must|should|want)\s+to\s+/i,
        /^(?:add|put|write\s+down)\s+/i,
        // EN — note/idea labels
        /^(?:quick\s+)?note(?:\s+to\s+(?:my)?self)?[: ]\s*/i,
        /^ideas?[: ]\s*/i,
        /^memo[: ]\s*/i,
        /^task[: ]\s*/i,
        /^(?:add|save|send|log)(?:\s+(?:this|it))?(?:\s+to|\s+in)\s+(?:notion|todoist|nextcloud|google\s+tasks?|my\s+(?:notes?|list|tasks?)|(?:my\s+)?to-?do\s+list)[: ,]\s*/i,
        /^ask(?:\s+the)?\s+(?:ai|claude|gpt|assistant)[: ]\s*/i,
        // DE
        /^(?:kannst\s+du\s+mich\s+)?erinn?er(?:e)?\s+mich(?:\s+daran)?\s*(?:,\s*)?(?:zu\s+)?/i,
        /^vergiss?\s+(?:es\s+)?nicht\s*(?:,\s*)?(?:zu\s+)?/i,
        /^denk(?:e)?\s+daran\s*(?:,\s*)?(?:zu\s+)?/i,
        /^ich\s+(?:muss|soll|brauche|will|m\xf6chte|mochte)\s+/i,
        /^notiz(?:\s+f\xfcr\s+mich)?[: ]\s*/i,
        /^idee[: ]\s*/i,
        /^aufgabe[: ]\s*/i,
        /^(?:f\xfcg\s+hinzu|hinzuf\xfcgen|speichern?)\s*(?:in|zu)?\s*(?:notion|todoist|nextcloud)?[: ]\s*/i,
        // FR
        /^rappelle[- ](?:moi\s+(?:de\s+|d')?)?\s*/i,
        /^n'?oublie\s+pas\s+(?:de\s+|d')?\s*/i,
        /^pense(?:z)?\s+\xe0\s+/i,
        /^je\s+(?:dois|veux|devrais|voudrais)\s+/i,
        /^il\s+faut\s+(?:que\s+je\s+)?/i,
        /^note(?:\s+(?:pour\s+moi|\xe0\s+moi[-\s]m\xeame))?[: ]\s*/i,
        /^id\xe9e[: ]\s*/i,
        /^m\xe9mo[: ]\s*/i,
        /^t\xe2che[: ]\s*/i,
        /^(?:ajouter?|sauvegarder?|envoyer?)(?:\s+(?:\xe0|dans))?\s+(?:notion|todoist|nextcloud)[: ]\s*/i,
        // ES
        /^rec?u\xe9rd?a(?:me\s+(?:de\s+|que\s+)?)?\s*/i,
        /^no\s+(?:te\s+)?olvides\s+(?:de\s+)?\s*/i,
        /^acu\xe9rdate\s+(?:de\s+)?\s*/i,
        /^(?:necesito|tengo\s+que|debo|hay\s+que)\s+/i,
        /^nota(?:\s+para\s+m\xed)?[: ]\s*/i,
        /^tarea[: ]\s*/i,
        /^(?:agregar?|a\xf1adir?|guardar?|enviar?)(?:\s+(?:a|en))?\s+(?:notion|todoist|nextcloud)[: ]\s*/i,
    ];
    for (var i = 0; i < prefixRe.length; i++) {
        var m = t.match(prefixRe[i]);
        if (m) { t = t.slice(m[0].length).trim(); break; }
    }

    // ── Suffix (first match wins) ──────────────────────────────────────────
    var suffixRe = [
        // EN
        /[,.]?\s+(?:to|in|on)\s+(?:my\s+)?(?:todo|to-?do|shopping|task|reminder|grocery|groceries)\s+list\.?$/i,
        /[,.]?\s+(?:to|in)\s+(?:todoist|notion|nextcloud|google\s+tasks?|my\s+notes?|tasks?)\.?$/i,
        /[,.]?\s+(?:to|on)\s+my\s+list\.?$/i,
        // DE
        /[,.]?\s+(?:zu|in|auf)\s+(?:mein(?:er|e)?\s+)?(?:todo|aufgaben?|einkaufs?|erinnerungs?)(?:\s*-?\s*liste?)?\.?$/i,
        /[,.]?\s+(?:in|zu)\s+(?:todoist|notion|nextcloud)\.?$/i,
        // FR
        /[,.]?\s+(?:\xe0|dans)\s+(?:ma\s+)?(?:liste\s+(?:de\s+)?(?:t\xe2ches?|courses?|rappels?))?\.?$/i,
        /[,.]?\s+(?:dans|\xe0)\s+(?:todoist|notion|nextcloud|ma\s+liste)\.?$/i,
        // ES
        /[,.]?\s+(?:a|en)\s+(?:mi\s+)?(?:lista\s+(?:de\s+)?(?:tareas?|compras?|pendientes?))?\.?$/i,
        /[,.]?\s+(?:en|a)\s+(?:todoist|notion|nextcloud|mi\s+lista)\.?$/i,
    ];
    for (var j = 0; j < suffixRe.length; j++) {
        var s = t.replace(suffixRe[j], '');
        if (s !== t) { t = s.trim(); break; }
    }

    // ── Capitalize + validate ──────────────────────────────────────────────
    if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1);
    var trivial = /^(this|it|that|these|those|eso|esto|ello|[çc]a|cela|ceci|das|es|dies(?:es?)?)\.?$/i;
    if (t.length < 3 || trivial.test(t)) return original;
    return t;
}

// Strip trailing date/time expressions from task titles (content captured in due field).
// Only used for task-manager destinations (Google Tasks, Todoist) — notes keep full text.
// Remove a trailing due-date / time tail from a task title, so "Buy milk due
// Saturday at 3 pm" becomes "Buy milk". Multilingual (EN/DE/FR/ES).
//
// SAFETY MODEL — this only ever trims a trailing date/time tail:
//   1. Callers only invoke it when extractDueDate() actually found a date.
//   2. Every pattern is anchored to end-of-string ($): mid-sentence text is
//      never touched.
//   3. A connector word (due / by / fällig / pour / para …) is baked into each
//      date pattern as an OPTIONAL lead-in, so it is only removed together with
//      the date token it introduces — a bare "on"/"for" with no date after it
//      survives ("turn the heater on" keeps "on").
//   4. If the result would be shorter than 3 chars, the original is kept.
function stripDateTimeFromText(text) {
    var original = text.trim();

    // Optional connector introducing a trailing date, per language.
    var DL =
        '(?:due\\s+|by\\s+|on\\s+|for\\s+|before\\s+|until\\s+|till\\s+|no\\s+later\\s+than\\s+|' + // EN
        'f[\\xe4a]llig\\s+am\\s+|f[\\xe4a]llig\\s+|bis\\s+zum\\s+|bis\\s+|am\\s+|n[\\xe4a]chste[rn]?\\s+|' + // DE
        'pour\\s+le\\s+|pour\\s+|avant\\s+le\\s+|avant\\s+|d\'ici\\s+|le\\s+|' + // FR
        'para\\s+el\\s+|para\\s+|antes\\s+del?\\s+|hasta\\s+el\\s+|hasta\\s+|el\\s+|' + // ES
        'next\\s+|this\\s+)?';
    // Optional connector before a trailing time ("at 3", "um 15 Uhr", "à 15h", "a las 3").
    var TL = '(?:at\\s+|um\\s+|gegen\\s+|\\xe0\\s+|a\\s+las\\s+|a\\s+)?';

    function R(body) { return new RegExp('[,.]?\\s+' + body + '$', 'i'); }

    function stripTrailing(s) {
        return s
            // ── Trailing time ──
            .replace(R(TL + '\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?\\s?m\\.?'), '')          // 3 pm / at 3:30 p.m.
            .replace(R(TL + '(?:[01]?\\d|2[0-3]):[0-5]\\d'), '')                        // 15:00 / at 15:00
            .replace(R(TL + '\\d{1,2}h\\s?\\d{0,2}'), '')                               // 15h / à 6h30
            .replace(R(TL + '\\d{1,2}\\s+(?:heures?|uhr)(?:\\s+\\d{1,2})?'), '')        // um 15 Uhr / à 6 heures
            .replace(R(TL + '(?:noon|midnight|lunchtime)'), '')
            .replace(R('(?:in\\s+the\\s+)?(?:this\\s+)?(?:morning|afternoon|evening)'), '')
            .replace(R('(?:at\\s+)?(?:tonight|midnight|noon|lunchtime)'), '')
            .replace(R('(?:at\\s+)?(?:dinner|breakfast|lunch)(?:time)?'), '')
            .replace(R('(?:heute\\s+(?:morgen|abend|nacht|nachmittag)|morgens|abends)'), '')
            .replace(R('(?:um\\s+)?(?:mittag|mitternacht)'), '')
            .replace(R('(?:ce\\s+matin|cet?\\s+apr[e\\xe8]s-midi|ce\\s+soir)'), '')
            .replace(R('(?:esta\\s+(?:ma[n\\xf1]ana|tarde|noche)|por\\s+la\\s+(?:ma[n\\xf1]ana|tarde|noche))'), '')
            // ── Trailing date ──
            .replace(R(DL + 'tomorrow'), '')
            .replace(R(DL + 'today'), '')
            .replace(R(DL + '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'), '')
            .replace(R('(?:by\\s+)?(?:end\\s+of\\s+)?(?:this\\s+week|this\\s+month|next\\s+week|next\\s+month)'), '')
            .replace(R(DL + '(?:morgen|[\\xfcu]bermorgen)'), '')
            .replace(R(DL + '(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag)'), '')
            .replace(R('n[\\xe4a]chste[rn]?\\s+(?:woche|monat)'), '')
            .replace(R(DL + 'demain'), '')
            .replace(R(DL + '(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)'), '')
            .replace(R('la\\s+semaine\\s+prochaine'), '')
            .replace(R(DL + 'ma[n\\xf1]ana'), '')
            .replace(R(DL + '(?:lunes|martes|mi[e\\xe9]rcoles|jueves|viernes|s[a\\xe1]bado|domingo)'), '')
            .trim();
    }

    // Loop until stable — handles any order of interleaved date/time/connector
    // tokens, e.g. "due Saturday at 3pm" or "fällig am Samstag um 15 Uhr".
    var t = original, prev;
    for (var k = 0; k < 4; k++) { prev = t; t = stripTrailing(t); if (t === prev) break; }
    return (t.length >= 3) ? t : original;
}

// ============================================================================
// ROUTER
// ============================================================================

var DEST_INDEX = { tasks: 0, notion: 1, ai: 2, webhook: 3, local: 4, todoist: 5, nextcloud: 6, nextcloud_tasks: 7 };

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

    // Task/reminder signals must never go to AI — redirect to a task service or local
    if (dest === 'ai' && !isFollowup && isTaskLike(text)) {
        if      (enabled.indexOf('tasks')   >= 0) dest = 'tasks';
        else if (enabled.indexOf('todoist') >= 0) dest = 'todoist';
        else if (enabled.indexOf('nextcloud_tasks') >= 0) dest = 'nextcloud_tasks';
        else dest = 'local';
    }

    var di = DEST_INDEX[dest] !== undefined ? DEST_INDEX[dest] : 4;
    console.log('Brain Dump route: "' + text.substring(0, 40) + '..." → ' + dest);

    // Tell the watch which destination was chosen so it can show the right status
    sendToWatch({ ROUTING_DONE: di });

    // Clean command preambles from the text before sending to the destination.
    // Original text is still used for routing, due-date extraction, and AI context.
    var sendText = cleanNoteText(text);

    var DEST_LABEL = { tasks: 'Tasks', notion: 'Notion', ai: 'AI', webhook: 'Webhook', local: 'Local', todoist: 'Todoist', nextcloud: 'Nextcloud Notes', nextcloud_tasks: 'Nextcloud Tasks' };

    function onResult(ok, data) {
        if (!ok) {
            console.log('Send failed: ' + data);
            var label = DEST_LABEL[dest] || dest;
            var msg = (label + ': ' + (data || 'Unknown error')).substring(0, 45);
            sendToWatch({ CONFIRM: 2, ERROR_MSG: msg });
            return;
        }
        addHistory(sendText, di);
        if (dest === 'ai') {
            sendToWatch({ AI_RESPONSE: data, AI_RESPONSE_DONE: 1, DEST_USED: di });
        } else if (dest === 'webhook' && data !== 'webhook') {
            // Two-way webhook: surface the endpoint's response body on the watch.
            console.log('Sending webhook response to watch: ' + data);
            sendToWatch({ CONFIRM: 1, DEST_USED: di, WEBHOOK_MSG: ('' + data).substring(0, 100) });
        } else {
            var msg = { CONFIRM: 1, DEST_USED: di };
            if (data && typeof data === 'object' && data.taskId) {
                msg.EXTERNAL_ID = data.taskId;
            }
            sendToWatch(msg);
        }
    }

    switch (dest) {
        case 'tasks':     sendToTasks     (sendText, cfg, onResult); break;
        case 'notion':    sendToNotion    (sendText, cfg, onResult); break;
        case 'ai':        sendToAI        (sendText, isFollowup, cfg, onResult); break;
        case 'webhook':   sendToWebhook   (sendText, cfg, onResult); break;
        case 'todoist':   sendToTodoist   (sendText, cfg, onResult); break;
        case 'nextcloud': sendToNextcloud (sendText, cfg, onResult); break;
        case 'nextcloud_tasks': sendToNextcloudTasks(sendText, cfg, onResult); break;
        case 'local':     onResult(true, 'local'); break;  // saved on-watch from s_note_buf
        default:          sendToWatch({ CONFIRM: 2 });
    }
}

// AppMessage allows only one message in flight; a second sendAppMessage before
// the first acks fails with APP_MSG_BUSY and is dropped. Several call sites fire
// two messages in the same tick (e.g. ROUTING_DONE then CONFIRM for a local
// note), so serialize: enqueue, and send the next only after the prior ack/nack.
var s_outbox_queue = [];
var s_outbox_busy  = false;

function flushOutbox() {
    if (s_outbox_busy || s_outbox_queue.length === 0) return;
    s_outbox_busy = true;
    var msg = s_outbox_queue.shift();
    Pebble.sendAppMessage(msg,
        function()  { console.log('→ watch: ' + JSON.stringify(msg)); s_outbox_busy = false; flushOutbox(); },
        function(e) { console.log('✗ watch: ' + JSON.stringify(e));   s_outbox_busy = false; flushOutbox(); }
    );
}

function sendToWatch(msg) {
    s_outbox_queue.push(msg);
    flushOutbox();
}

// Bitmask of enabled destinations, sent to the watch so it can show the right
// status. Bit positions must match the C side. Single source of truth — both
// the ready handler and the config-save handler use this.
function computeDestMask(cfg) {
    var enabled = getEnabledDests(cfg);
    var mask = 0;
    if (enabled.indexOf('tasks')     >= 0) mask |= 1;
    if (enabled.indexOf('notion')    >= 0) mask |= 2;
    if (enabled.indexOf('ai')        >= 0) mask |= 4;
    if (enabled.indexOf('webhook')   >= 0) mask |= 8;
    if (enabled.indexOf('todoist')   >= 0) mask |= 32;
    if (enabled.indexOf('nextcloud') >= 0) mask |= 64;
    if (enabled.indexOf('nextcloud_tasks') >= 0) mask |= 128;
    return mask;
}

// ============================================================================
// PEBBLE EVENTS
// ============================================================================

Pebble.addEventListener('ready', function() {
    console.log('Brain Dump JS ready');
    var cfg     = getConfig();
    sendToWatch({ DEST_MASK: computeDestMask(cfg) });

    // Proactively refresh Google access token so it's always fresh before use.
    // Access tokens expire after 1 hour; refreshing on every connect keeps them valid.
    if (cfg.tasks_enabled && cfg.tasks_refresh_token) {
        refreshGoogleToken(cfg, function(newToken, invalidGrant) {
            if (newToken) {
                cfg.tasks_access_token = newToken;
                saveConfig(cfg);
                console.log('Google token refreshed on ready');
            } else if (invalidGrant) {
                console.log('Google refresh token revoked — user must reconnect');
            }
        });
    }
});

// Short human label for any due date/time extracted from the note, e.g.
// "Tomorrow 09:00", "Mon 7", "18:00". Empty string if none found.
function formatDueLabel(text) {
    var iso = extractDueDate(text);
    var tm  = extractTime(text);
    if (!iso && !tm) return '';
    var parts = [];
    if (iso) {
        var dp = iso.substring(0, 10).split('-');
        var d  = new Date(parseInt(dp[0], 10), parseInt(dp[1], 10) - 1, parseInt(dp[2], 10));
        var now = new Date();
        var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var diff = Math.round((d - t0) / 86400000);
        var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        if (diff === 0) parts.push('Today');
        else if (diff === 1) parts.push('Tomorrow');
        else parts.push(days[d.getDay()] + ' ' + d.getDate());
    }
    if (tm) {
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        parts.push(pad(tm.h) + ':' + pad(tm.m));
    }
    return parts.join(' ');
}

Pebble.addEventListener('appmessage', function(e) {
    var p = e.payload;

    if (p.CLOCK_24H !== undefined) {
        s_clock_24h = (p.CLOCK_24H === 1);
    }

    if (p.NOTE_TEXT !== undefined) {
        s_last_note = p.NOTE_TEXT;
        if (p.NOTE_IS_CLASSIFY_ONLY) {
            // Classify only — tell watch the predicted destination without routing
            var cfg2 = getConfig();
            var enabled2 = getEnabledDests(cfg2);
            var dest2 = (enabled2.length === 0) ? 'local'
                      : classifyIntent(p.NOTE_TEXT, enabled2, cfg2) || cfg2.default_dest || enabled2[0];
            if (dest2 === 'ai' && isTaskLike(p.NOTE_TEXT)) {
                if      (enabled2.indexOf('tasks')   >= 0) dest2 = 'tasks';
                else if (enabled2.indexOf('todoist') >= 0) dest2 = 'todoist';
                else if (enabled2.indexOf('nextcloud_tasks') >= 0) dest2 = 'nextcloud_tasks';
                else dest2 = 'local';
            }
            var msg2 = { ROUTING_DONE: DEST_INDEX[dest2] !== undefined ? DEST_INDEX[dest2] : 4 };
            // Surface an extracted due date/time for task destinations.
            if (dest2 === 'tasks' || dest2 === 'todoist' || dest2 === 'nextcloud_tasks') {
                var due = formatDueLabel(p.NOTE_TEXT);
                if (due) msg2.DUE_LABEL = due;
            }
            sendToWatch(msg2);
        } else {
            routeAndSend(p.NOTE_TEXT, p.NOTE_IS_FOLLOWUP === 1);
        }
    }

    if (p.CLEAR_CONTEXT) {
        s_ai_messages = [];
        console.log('AI context cleared');
    }

    if (p.COMPLETE_TASK && p.EXTERNAL_ID) {
        completeGoogleTask(p.EXTERNAL_ID, getConfig(), function(ok, err) {
            console.log(ok ? 'Google Task completed' : ('Complete failed: ' + err));
        });
    }
});

// ============================================================================
// CONFIGURATION PAGE
// ============================================================================

Pebble.addEventListener('showConfiguration', function() {
    var cfg = getConfig();

    // Restore or generate PKCE verifier — persisted in localStorage so the verifier
    // survives the user leaving settings, opening Chrome, signing in, and coming back.
    var pVer;
    try { pVer = localStorage.getItem('brain_dump_pkce_v'); } catch(e) {}
    if (!pVer) {
        var pCh = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        pVer = '';
        for (var vi = 0; vi < 64; vi++) pVer += pCh[Math.floor(Math.random() * pCh.length)];
        try { localStorage.setItem('brain_dump_pkce_v', pVer); } catch(e) {}
    }
    var pUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
        '?client_id=' + encodeURIComponent(TASKS_CLIENT_ID) +
        '&redirect_uri=http%3A%2F%2Flocalhost' +
        '&response_type=code' +
        '&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Ftasks' +
        '&code_challenge=' + encodeURIComponent(pVer) +
        '&code_challenge_method=plain&access_type=offline&prompt=consent';

    function esc(s) { return (s || '').replace(/'/g, "\\'"); }
    function chk(v) { return v ? 'checked' : ''; }
    function sel(a, b) { return a === b ? 'selected' : ''; }

    var html = '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{font-family:sans-serif;background:#111;color:#eee;padding:16px;padding-bottom:68px;margin:0}' +
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
    '.fetch-error{font-size:11px;color:#f66;margin:6px 0 0;display:none}' +
    'a{color:#f90}' +
    '.save-bar{position:fixed;bottom:0;left:0;width:100%;padding:12px 16px;background:#111;box-sizing:border-box;z-index:100}' +
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
    '<option value="todoist" ' + sel(cfg.default_dest,'todoist') + '>Todoist</option>' +
    '<option value="notion"  ' + sel(cfg.default_dest,'notion')  + '>Notion</option>' +
    '<option value="ai"      ' + sel(cfg.default_dest,'ai')      + '>AI Agent</option>' +
    '<option value="nextcloud" ' + sel(cfg.default_dest,'nextcloud') + '>Nextcloud Notes</option>' +
    '<option value="nextcloud_tasks" ' + sel(cfg.default_dest,'nextcloud_tasks') + '>Nextcloud Tasks</option>' +
    '<option value="webhook"   ' + sel(cfg.default_dest,'webhook')   + '>Webhook</option>' +
    '</select></label>' +
    '</div>' +

    // ---- Google Tasks ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="tasks_enabled" ' + chk(cfg.tasks_enabled) + '>' +
    ' Google Tasks</label>' +
    '<div class="fields">' +
    (cfg.tasks_access_token
      ? '<div style="display:flex;align-items:center;gap:10px;margin:6px 0 10px">' +
        '<span style="font-size:13px;color:#4c4">&#10003; Connected</span>' +
        '<button type="button" onclick="disconnectGoogle()" style="width:auto;padding:4px 12px;font-size:13px;margin:0;background:#666">Disconnect</button>' +
        '</div>'
      : '<div id="tasks_connect_ui">' +
        '<p class="note" style="margin:8px 0 6px;line-height:1.6">' +
        '<b>How to connect:</b><br>' +
        '1. Copy the URL below and open it in Chrome or Safari.<br>' +
        '2. Sign in with Google and grant Tasks access.<br>' +
        '3. Your browser redirects to a page that fails to load — that\'s expected.<br>' +
        '4. Copy the full URL from the address bar (starts with <code>http://localhost/</code>).<br>' +
        '5. Come back here, paste it below, and tap <b>Connect</b>.</p>' +
        'Google sign-in URL:<input type="text" id="tasks_auth_url" readonly value="' + pUrl + '" ' +
        'style="font-size:10px;color:#aaa;background:#111;border-color:#555">' +
        '<button type="button" id="tasks_copy_btn" onclick="copyAuthUrl()" ' +
        'style="width:auto;padding:6px 14px;font-size:13px;margin:4px 0 12px">Copy URL</button>' +
        '<br>Paste redirect URL:<input type="text" id="tasks_redirect_url" placeholder="http://localhost/?code=...">' +
        '<button type="button" id="tasks_exchange_btn" onclick="exchangeCode()" ' +
        'style="width:auto;padding:6px 14px;font-size:13px;margin:4px 0 10px">Connect</button>' +
        '</div>') +
    '<input type="hidden" id="tasks_access_token" value=\'' + esc(cfg.tasks_access_token) + '\'>' +
    '<input type="hidden" id="tasks_refresh_token" value=\'' + esc(cfg.tasks_refresh_token) + '\'>' +
    '<input type="hidden" id="pkce_verifier" value=\'' + esc(pVer) + '\'>' +
    '<br>Task list:<select id="tasks_list_id"><option value="">Loading...</option></select>' +
    '<button type="button" onclick="fetchTaskLists(document.getElementById(\'tasks_access_token\').value)"' +
    ' style="width:auto;padding:4px 10px;font-size:12px;margin:4px 0 8px">&#8635; Refresh</button>' +
    '<div id="tasks_fetch_error" class="fetch-error"></div>' +
    '<br>Routing keywords (comma-separated, added to defaults):<input type="text" id="tasks_keywords"' +
    ' value=\'' + esc(cfg.tasks_keywords) + '\' placeholder="buy milk, dentist, ...">' +
    '</div></div>' +

    // ---- Todoist ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="todoist_enabled" ' + chk(cfg.todoist_enabled) + '>' +
    ' Todoist</label>' +
    '<div class="fields">' +
    'API key:<input type="password" id="todoist_token" value=\'' + esc(cfg.todoist_token) + '\'' +
    ' onblur="fetchTodoistProjects(this.value)">' +
    '<p class="note">Get your API key at <a href="https://app.todoist.com/app/settings/integrations/developer" target="_blank">app.todoist.com → Settings → Integrations → Developer</a></p>' +
    '<br>Project:<select id="todoist_project_id"><option value="">Inbox (default)</option></select>' +
    '<button type="button" onclick="fetchTodoistProjects(document.getElementById(\'todoist_token\').value)"' +
    ' style="width:auto;padding:4px 10px;font-size:12px;margin:4px 0 8px">&#8635; Refresh</button>' +
    '<div id="todoist_fetch_error" class="fetch-error"></div>' +
    '<br>Routing keywords (comma-separated, added to defaults):<input type="text" id="todoist_keywords"' +
    ' value=\'' + esc(cfg.todoist_keywords) + '\' placeholder="todoist, add to todoist, ...">' +
    '</div></div>' +

    // ---- Notion ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="notion_enabled" ' + chk(cfg.notion_enabled) + '>' +
    ' Notion</label>' +
    '<div class="fields">' +
    'API token:<input type="password" id="notion_token" value=\'' + esc(cfg.notion_token) + '\' onblur="verifyNotion()">' +
    '<p class="note">Generate a token at <a href="https://www.notion.so/developers/tokens" target="_blank">notion.so/developers/tokens</a></p>' +
    'Target page or database URL/ID:<input type="text" id="notion_page_id" value=\'' + esc(cfg.notion_page_id) + '\' placeholder="https://notion.so/... or page/database ID" onblur="verifyNotion()">' +
    '<p class="note">Paste a page or a database — the app detects which it is. A page gets the note appended as a text block; a database gets a new row per note. Share the target with your integration in Notion (··· → Connections).</p>' +
    '<div id="notion_status" class="note"></div>' +
    'Database title column (optional):<input type="text" id="notion_title_prop" value=\'' + esc(cfg.notion_title_prop) + '\' placeholder="auto-detected (e.g. Name)">' +
    '<p class="note">Only if a database\'s title column is auto-detected wrongly — otherwise leave blank.</p>' +
    '<br>Routing keywords (comma-separated, added to defaults):<input type="text" id="notion_keywords"' +
    ' value=\'' + esc(cfg.notion_keywords) + '\' placeholder="idea, log, draft, ...">' +
    '</div></div>' +

    // ---- Nextcloud Notes ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="nextcloud_enabled" ' + chk(cfg.nextcloud_enabled) + '>' +
    ' Nextcloud Notes</label>' +
    '<div class="fields">' +
    'Instance URL:<input type="text" id="nextcloud_url" value=\'' + esc(cfg.nextcloud_url) + '\' placeholder="https://cloud.example.com">' +
    'Username:<input type="text" id="nextcloud_user" value=\'' + esc(cfg.nextcloud_user) + '\'>' +
    'App password:<input type="password" id="nextcloud_pass" value=\'' + esc(cfg.nextcloud_pass) + '\'>' +
    '<p class="note">Generate an App Password in Nextcloud: Settings → Security → App passwords</p>' +
    'Category (optional):<input type="text" id="nextcloud_category" value=\'' + esc(cfg.nextcloud_category) + '\' placeholder="Brain Dump">' +
    'Routing keywords (comma-separated, added to defaults):<input type="text" id="nextcloud_keywords"' +
    ' value=\'' + esc(cfg.nextcloud_keywords) + '\' placeholder="nextcloud, cloud note, ...">' +
    '</div></div>' +

    // ---- Nextcloud Tasks (CalDAV) ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="nextcloud_tasks_enabled" ' + chk(cfg.nextcloud_tasks_enabled) + '>' +
    ' Nextcloud Tasks</label>' +
    '<div class="fields">' +
    'Instance URL:<input type="text" id="nextcloud_tasks_url" value=\'' + esc(cfg.nextcloud_tasks_url) + '\' placeholder="https://cloud.example.com">' +
    'Username:<input type="text" id="nextcloud_tasks_user" value=\'' + esc(cfg.nextcloud_tasks_user) + '\'>' +
    'App password:<input type="password" id="nextcloud_tasks_pass" value=\'' + esc(cfg.nextcloud_tasks_pass) + '\'>' +
    '<p class="note">Generate an App Password in Nextcloud: Settings → Security → App passwords. May be the same instance as Nextcloud Notes.</p>' +
    'Task list (CalDAV name):<input type="text" id="nextcloud_tasks_list" value=\'' + esc(cfg.nextcloud_tasks_list) + '\' placeholder="personal">' +
    '<p class="note">The list\'s internal name, not its display title. Default list is usually "personal". Find it in the Tasks app URL: …/apps/tasks/#/calendars/<b>NAME</b></p>' +
    'Routing keywords (comma-separated, added to defaults):<input type="text" id="nextcloud_tasks_keywords"' +
    ' value=\'' + esc(cfg.nextcloud_tasks_keywords) + '\' placeholder="nextcloud task, todo cloud, ...">' +
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
    'Routing keywords (comma-separated, added to defaults):<input type="text" id="ai_keywords"' +
    ' value=\'' + esc(cfg.ai_keywords) + '\' placeholder="explain, summarize, ...">' +
    '</div></div>' +

    // ---- Webhook ----
    '<div class="section">' +
    '<label class="toggle-label"><input type="checkbox" id="webhook_enabled" ' + chk(cfg.webhook_enabled) + '>' +
    ' Custom Webhook</label>' +
    '<div class="fields">' +
    'URL:<input type="text" id="webhook_url" value=\'' + esc(cfg.webhook_url) + '\'>' +
    '<p class="note">Supports URL placeholders: <code>{text}</code>, <code>{timestamp}</code>, <code>{json}</code>. AutoRemote example: <code>message=brain_dump=:={json}</code></p>' +
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

    '<div class="save-bar"><button onclick="save()">Save</button></div>' +

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
    // Google OAuth PKCE — verifier is baked into the auth URL at render time
    // and stored in a hidden input; no in-page JS needed to generate it.
    'var G_CID="122599459809-1egpb0mrc97lpeh6fshnfv1i1drnvnkd.apps.googleusercontent.com";' +
    'var G_SECRET="' + TASKS_CLIENT_SECRET + '";' +
    'function setFetchError(id,msg){' +
      'var el=document.getElementById(id);' +
      'if(!el)return;' +
      'el.textContent=msg;' +
      'el.style.display=msg?"block":"none";' +
    '}' +
    'function fetchTaskLists(token){' +
      'if(!token)return;' +
      'var sel=document.getElementById("tasks_list_id");' +
      'sel.innerHTML=\'<option value="">Loading...</option>\';' +
      'setFetchError("tasks_fetch_error","");' +
      'var xhr=new XMLHttpRequest();' +
      'xhr.open("GET","https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100");' +
      'xhr.setRequestHeader("Authorization","Bearer "+token);' +
      'xhr.onload=function(){' +
        'if(this.status===401){sel.innerHTML=\'<option value="">Default list</option>\';setFetchError("tasks_fetch_error","Auth error — reconnect Google Tasks");return;}' +
        'if(this.status<200||this.status>=300){sel.innerHTML=\'<option value="">Default list</option>\';setFetchError("tasks_fetch_error","Error "+this.status+" fetching task lists");return;}' +
        'try{' +
          'var r=JSON.parse(this.responseText);' +
          'if(!r.items){sel.innerHTML=\'<option value="">Default list</option>\';return;}' +
          'var saved="' + esc(cfg.tasks_list_id) + '";' +
          'sel.innerHTML=r.items.map(function(l){' +
            'return\'<option value="\'+l.id+\'"\'+(l.id===saved?\' selected\':\'\')+\'>\'+l.title+\'</option>\';' +
          '}).join("");' +
        '}catch(e){sel.innerHTML=\'<option value="">Default list</option>\';setFetchError("tasks_fetch_error","Could not parse response");}' +
      '};' +
      'xhr.onerror=function(){sel.innerHTML=\'<option value="">Default list</option>\';setFetchError("tasks_fetch_error","Network error — check connection");};' +
      'xhr.send();' +
    '}' +
    'function fetchTodoistProjects(token){' +
      'if(!token)return;' +
      'var sel=document.getElementById("todoist_project_id");' +
      'sel.innerHTML=\'<option value="">Loading...</option>\';' +
      'setFetchError("todoist_fetch_error","");' +
      'var allProjects=[];' +
      'function fetchPage(cursor){' +
        'var url="https://api.todoist.com/api/v1/projects?limit=200";' +
        'if(cursor)url+="&cursor="+encodeURIComponent(cursor);' +
        'var xhr=new XMLHttpRequest();' +
        'xhr.open("GET",url);' +
        'xhr.setRequestHeader("Authorization","Bearer "+token);' +
        'xhr.onload=function(){' +
          'if(this.status===401){sel.innerHTML=\'<option value="">Inbox (default)</option>\';setFetchError("todoist_fetch_error","Invalid API key");return;}' +
          'if(this.status<200||this.status>=300){sel.innerHTML=\'<option value="">Inbox (default)</option>\';setFetchError("todoist_fetch_error","Error "+this.status+" fetching projects");return;}' +
          'try{' +
            'var r=JSON.parse(this.responseText);' +
            // API v1 returns { results: [...], next_cursor: "..." } — also handle plain array for safety
            'var page=Array.isArray(r)?r:(r.results||r.items||[]);' +
            'allProjects=allProjects.concat(page);' +
            'if(!Array.isArray(r)&&r.next_cursor){fetchPage(r.next_cursor);return;}' +
            'if(!allProjects.length){sel.innerHTML=\'<option value="">Inbox (default)</option>\';return;}' +
            'var saved="' + esc(cfg.todoist_project_id) + '";' +
            'sel.innerHTML=\'<option value="">Inbox (default)</option>\'+' +
            'allProjects.map(function(p){' +
              'return\'<option value="\'+p.id+\'"\'+(String(p.id)===saved?\' selected\':\'\')+\'>\'+p.name+\'</option>\';' +
            '}).join("");' +
          '}catch(e){sel.innerHTML=\'<option value="">Inbox (default)</option>\';setFetchError("todoist_fetch_error","Could not parse response");}' +
        '};' +
        'xhr.onerror=function(){sel.innerHTML=\'<option value="">Inbox (default)</option>\';setFetchError("todoist_fetch_error","Network error — check connection");};' +
        'xhr.send();' +
      '}' +
      'fetchPage(null);' +
    '}' +
    // Notion: verify the entered page/database live (client-side, like Todoist).
    // Runs on blur of the target field and on load. Detects database vs page and
    // surfaces token / not-shared errors, so users get feedback without saving.
    'function notionId(v){' +
      'v=(v||"").trim();' +
      'var m=v.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);' +
      'if(m)return m[1];' +
      'm=v.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i);' +
      'if(m)return m[1];' +
      'return v;' +
    '}' +
    'function verifyNotion(){' +
      'var st=document.getElementById("notion_status");' +
      'var token=document.getElementById("notion_token").value.trim();' +
      'var id=notionId(document.getElementById("notion_page_id").value);' +
      'if(!token||!id){st.textContent="";return;}' +
      'st.style.color="#aaa";st.textContent="Checking\\u2026";' +
      'var db=new XMLHttpRequest();' +
      'db.open("GET","https://api.notion.com/v1/databases/"+id);' +
      'db.setRequestHeader("Authorization","Bearer "+token);' +
      'db.setRequestHeader("Notion-Version","2022-06-28");' +
      'db.onload=function(){' +
        'if(this.status>=200&&this.status<300){' +
          'var prop="Name";try{var d=JSON.parse(this.responseText);for(var k in d.properties){if(d.properties[k]&&d.properties[k].type==="title"){prop=k;break;}}}catch(e){}' +
          'st.style.color="#4c4";st.textContent="\\u2713 Database detected \\u2014 a new row per note (title column: "+prop+").";return;' +
        '}' +
        'if(this.status===401){st.style.color="#f66";st.textContent="\\u26a0 Invalid Notion token.";return;}' +
        'var pg=new XMLHttpRequest();' +
        'pg.open("GET","https://api.notion.com/v1/pages/"+id);' +
        'pg.setRequestHeader("Authorization","Bearer "+token);' +
        'pg.setRequestHeader("Notion-Version","2022-06-28");' +
        'pg.onload=function(){' +
          'if(this.status>=200&&this.status<300){st.style.color="#4c4";st.textContent="\\u2713 Page detected \\u2014 note appended as a text block.";}' +
          'else if(this.status===401){st.style.color="#f66";st.textContent="\\u26a0 Invalid Notion token.";}' +
          'else{st.style.color="#f66";st.textContent="\\u26a0 Not found \\u2014 check the URL/ID and share it with your integration.";}' +
        '};' +
        'pg.onerror=function(){st.style.color="#f66";st.textContent="Couldn\\u2019t reach Notion.";};' +
        'pg.send();' +
      '};' +
      'db.onerror=function(){st.style.color="#f66";st.textContent="Couldn\\u2019t reach Notion (blocked or offline).";};' +
      'db.send();' +
    '}' +
    'window.addEventListener("load",function(){' +
      'var tok=document.getElementById("tasks_access_token").value;' +
      'if(tok)fetchTaskLists(tok);' +
      'else document.getElementById("tasks_list_id").innerHTML=\'<option value="">Default list</option>\';' +
      'var tdTok=document.getElementById("todoist_token").value;' +
      'if(tdTok)fetchTodoistProjects(tdTok);' +
      'verifyNotion();' +
    '});' +
    'function copyAuthUrl(){' +
      'var el=document.getElementById("tasks_auth_url");' +
      'el.select();el.setSelectionRange(0,9999);' +
      'var ok=false;try{ok=document.execCommand("copy");}catch(e){}' +
      'var btn=document.getElementById("tasks_copy_btn");' +
      'btn.textContent=ok?"Copied!":"Long-press to copy";' +
      'setTimeout(function(){btn.textContent="Copy URL";},2000);' +
    '}' +
    'function exchangeCode(){' +
      'var url=document.getElementById("tasks_redirect_url").value.trim();' +
      'var m=url.match(/[?&]code=([^&]+)/);' +
      'if(!m){alert("Paste the full redirect URL (starts with http://localhost/?code=)");return;}' +
      'var code=decodeURIComponent(m[1]);' +
      'var verifier=document.getElementById("pkce_verifier").value;' +
      'var btn=document.getElementById("tasks_exchange_btn");' +
      'btn.disabled=true;btn.textContent="Connecting...";' +
      'var xhr=new XMLHttpRequest();' +
      'xhr.open("POST","https://oauth2.googleapis.com/token");' +
      'xhr.setRequestHeader("Content-Type","application/x-www-form-urlencoded");' +
      'xhr.onload=function(){' +
        'var r;try{r=JSON.parse(this.responseText);}' +
        'catch(e){alert("Parse error");btn.disabled=false;btn.textContent="Connect";return;}' +
        'if(r&&r.access_token){' +
          'document.getElementById("tasks_access_token").value=r.access_token;' +
          'document.getElementById("tasks_refresh_token").value=r.refresh_token||"";' +
          'document.getElementById("tasks_enabled").checked=true;' +
          'try{localStorage.removeItem("brain_dump_pkce_v");}catch(e){}' +
          'var connectUi=document.getElementById("tasks_connect_ui");' +
          'if(connectUi){' +
            'connectUi.innerHTML=\'<div style="display:flex;align-items:center;gap:10px;margin:6px 0 10px"><span style="font-size:13px;color:#4c4">&#10003; Connected</span><button type="button" onclick="disconnectGoogle()" style="width:auto;padding:4px 12px;font-size:13px;margin:0;background:#666">Disconnect</button></div>\';' +
          '}' +
          'fetchTaskLists(r.access_token);' +
          'btn.disabled=false;btn.textContent="Connect";' +
          'alert("Google Tasks connected. Choose your task list, then tap Save.");' +
        '}else{' +
          'alert("Error: "+(r.error_description||r.error||"Token exchange failed"));' +
          'btn.disabled=false;btn.textContent="Connect";}' +
      '};' +
      'xhr.onerror=function(){alert("Network error");btn.disabled=false;btn.textContent="Connect";};' +
      'xhr.send(' +
        '"grant_type=authorization_code" +' +
        '"&code="+encodeURIComponent(code) +' +
        '"&client_id="+encodeURIComponent(G_CID) +' +
        '"&redirect_uri=http%3A%2F%2Flocalhost" +' +
        '"&code_verifier="+encodeURIComponent(verifier) +' +
        '"&client_secret="+encodeURIComponent(G_SECRET)' +
      ');' +
    '}' +
    'function disconnectGoogle(){' +
      'document.getElementById("tasks_access_token").value="";' +
      'document.getElementById("tasks_refresh_token").value="";' +
      'document.getElementById("tasks_enabled").checked=false;' +
      'save();' +
    '}' +
    'function save(){' +
    'var c={' +
    'metric_units:document.getElementById("metric_units").checked,' +
    'routing_auto:document.getElementById("routing_auto").checked,' +
    'default_dest:document.getElementById("default_dest").value,' +
    'tasks_enabled:document.getElementById("tasks_enabled").checked,' +
    'tasks_access_token:document.getElementById("tasks_access_token").value,' +
    'tasks_refresh_token:document.getElementById("tasks_refresh_token").value,' +
    'tasks_list_id:document.getElementById("tasks_list_id").value.trim(),' +
    'tasks_keywords:document.getElementById("tasks_keywords").value.trim(),' +
    'todoist_enabled:document.getElementById("todoist_enabled").checked,' +
    'todoist_token:document.getElementById("todoist_token").value.trim(),' +
    'todoist_project_id:document.getElementById("todoist_project_id").value,' +
    'todoist_keywords:document.getElementById("todoist_keywords").value.trim(),' +
    'notion_enabled:document.getElementById("notion_enabled").checked,' +
    'notion_token:document.getElementById("notion_token").value.trim(),' +
    'notion_page_id:document.getElementById("notion_page_id").value,' +
    'notion_title_prop:document.getElementById("notion_title_prop").value.trim(),' +
    'notion_keywords:document.getElementById("notion_keywords").value.trim(),' +
    'nextcloud_enabled:document.getElementById("nextcloud_enabled").checked,' +
    'nextcloud_url:document.getElementById("nextcloud_url").value.trim(),' +
    'nextcloud_user:document.getElementById("nextcloud_user").value.trim(),' +
    'nextcloud_pass:document.getElementById("nextcloud_pass").value.trim(),' +
    'nextcloud_category:document.getElementById("nextcloud_category").value.trim(),' +
    'nextcloud_keywords:document.getElementById("nextcloud_keywords").value.trim(),' +
    'nextcloud_tasks_enabled:document.getElementById("nextcloud_tasks_enabled").checked,' +
    'nextcloud_tasks_url:document.getElementById("nextcloud_tasks_url").value.trim(),' +
    'nextcloud_tasks_user:document.getElementById("nextcloud_tasks_user").value.trim(),' +
    'nextcloud_tasks_pass:document.getElementById("nextcloud_tasks_pass").value.trim(),' +
    'nextcloud_tasks_list:document.getElementById("nextcloud_tasks_list").value.trim(),' +
    'nextcloud_tasks_keywords:document.getElementById("nextcloud_tasks_keywords").value.trim(),' +
    'ai_enabled:document.getElementById("ai_enabled").checked,' +
    'ai_preset:document.getElementById("ai_preset").value,' +
    'ai_url:document.getElementById("ai_url").value.trim(),' +
    'ai_model:document.getElementById("ai_model").value.trim(),' +
    'ai_key:document.getElementById("ai_key").value.trim(),' +
    'ai_system:document.getElementById("ai_system").value.trim(),' +
    'ai_keywords:document.getElementById("ai_keywords").value.trim(),' +
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
        // Re-send DEST_MASK to watch (now includes todoist + nextcloud)
        sendToWatch({ DEST_MASK: computeDestMask(cfg) });
    } catch(e2) {
        console.log('Config parse error: ' + e2);
    }
});
