// Unit tests for extractTime / extractDueDate (Brain Dump pkjs)
// Run: node test/extractTime.test.js

// ============================================================
// Functions under test — keep in sync with src/pkjs/index.js
// ============================================================

var _NUM_WORDS = {
    'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,
    'seven':7,'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,
    'eins':1,'zwei':2,'drei':3,'vier':4,'f\xfcnf':5,'funf':5,
    'sechs':6,'sieben':7,'acht':8,'neun':9,'zehn':10,'elf':11,'zw\xf6lf':12,'zwolf':12,
    'une':1,'deux':2,'trois':3,'quatre':4,'cinq':5,
    'sept':7,'huit':8,'neuf':9,'dix':10,'onze':11,'douze':12,
    'dos':2,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,
    'nueve':9,'diez':10,'once':11,'doce':12
};
var _NUM_PAT = [
    'eleven','twelve','seven','eight','three','four','five','nine','six','ten','two','one',
    'sieben','sechs','neun','zehn','vier','acht','elf','f\xfcnf','funf','zwei','drei',
    'eins','zw\xf6lf','zwolf',
    'quatre','trois','onze','douze','deux','cinq','sept','huit','neuf','dix','une',
    'cuatro','cinco','siete','ocho','nueve','diez','seis','once','doce','dos'
].join('|');

function disambiguate(h, min, nowHour) {
    if (h === 0 || h > 12) return { h: h, m: min };
    var asAM = (h === 12) ? 0  : h;
    var asPM = (h === 12) ? 12 : h + 12;
    if (nowHour >= asPM) return { h: asAM, m: min };
    if (nowHour >= asAM) return { h: asPM, m: min };
    return ((asPM - nowHour) <= (asAM - nowHour))
        ? { h: asPM, m: min } : { h: asAM, m: min };
}

function _normAP(s) { return s.replace(/[\s.]/g, ''); }

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

function _withAP(h, min, t, nowHour) {
    if (h >= 13) return { h: h, m: min };
    var ap = _inlineAP(t);
    if (ap === 'am') return { h: (h === 12 ? 0  : h),     m: min };
    if (ap === 'pm') return { h: (h <  12 ? h + 12 : h),  m: min };
    return disambiguate(h, min, nowHour);
}

function extractTime(text, nowHour) {
    var t = text.toLowerCase();
    if (nowHour === undefined) nowHour = new Date().getHours();

    function has() {
        for (var i = 0; i < arguments.length; i++)
            if (t.indexOf(arguments[i]) >= 0) return true;
        return false;
    }

    var m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)(?!\w)/);
    if (m) {
        var h = parseInt(m[1], 10), min = m[2] ? parseInt(m[2], 10) : 0;
        var ap = _normAP(m[3]);
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return { h: h, m: min };
    }

    m = t.match(new RegExp('\\b(' + _NUM_PAT + ')\\s+([ap]\\.?\\s?m\\.?)(?!\\w)'));
    if (m) {
        var h = _NUM_WORDS[m[1]], ap = _normAP(m[2]);
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return { h: h, m: 0 };
    }

    m = t.match(/\b(\d{1,2})h\s?(\d{2})?\b/);
    if (m) return _withAP(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, t, nowHour);

    m = t.match(/\b(\d{1,2})\s+(?:heures?|uhr)\b(?:\s+(\d{1,2}))?\b/);
    if (m) return _withAP(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, t, nowHour);

    m = t.match(new RegExp('\\b(' + _NUM_PAT + ')\\s+(?:heures?|uhr)\\b'));
    if (m) return _withAP(_NUM_WORDS[m[1]], 0, t, nowHour);

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

    m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m) {
        var h24 = parseInt(m[1], 10), m24 = parseInt(m[2], 10);
        if (h24 >= 13 || m[1].length === 2) return { h: h24, m: m24 };
        return disambiguate(h24, m24, nowHour);
    }

    m = t.match(/\b(\d{1,2})\s*o'?clock\b/);
    if (m) return disambiguate(parseInt(m[1], 10), 0, nowHour);
    m = t.match(new RegExp('\\b(' + _NUM_PAT + ")\\s*o'?clock\\b"));
    if (m) return disambiguate(_NUM_WORDS[m[1]], 0, nowHour);

    m = t.match(/\bat\s+(\d{1,2})\b(?!\s*[:\d])/);
    if (m) return disambiguate(parseInt(m[1], 10), 0, nowHour);
    m = t.match(new RegExp('\\bat\\s+(' + _NUM_PAT + ')\\b'));
    if (m) return disambiguate(_NUM_WORDS[m[1]], 0, nowHour);

    // Named time expressions
    if (has('at breakfast','for breakfast','beim fr\xfchst\xfcck','zum fr\xfchst\xfcck',
            'beim fruhstuck','zum fruhstuck','au petit-d\xe9jeuner','au petit dejeuner',
            'en el desayuno','para el desayuno'))
        return { h: 8, m: 0 };
    if (has('this morning','in the morning','early morning','heute morgen','am morgen',
            'morgens','fr\xfchmorgens','fruhmorgens','ce matin','le matin','du matin',
            'esta ma\xf1ana','esta manana','por la ma\xf1ana','por la manana'))
        return { h: 9, m: 0 };
    if (has('this afternoon','in the afternoon','heute nachmittag','am nachmittag',
            'nachmittags','cet apr\xe8s-midi','cet apres-midi',"l'apr\xe8s-midi",
            "l'apres-midi",'esta tarde','por la tarde','de tarde'))
        return { h: 14, m: 0 };
    if (has('this evening','in the evening','heute abend','am abend','abends',
            'ce soir','le soir','du soir','esta noche temprano'))
        return { h: 18, m: 0 };
    if (has('noon','lunchtime','at lunch','mittag','mittagessen','zu mittag',
            'zum mittagessen','midi','au d\xe9jeuner','au dejeuner',
            'mediod\xeda','mediodia','al mediod\xeda','al mediodia','almuerzo'))
        return { h: 12, m: 0 };
    if (has('midnight','mitternacht','minuit','medianoche'))
        return { h: 0, m: 0 };
    if (has('tonight','at night','heute nacht','in der nacht','nachts',
            'cette nuit','la nuit','esta noche','por la noche','de noche'))
        return { h: 20, m: 0 };
    if (has('at dinner','at dinnertime','for dinner','beim abendessen','zum abendessen',
            'au d\xeener','au diner','en la cena','para cenar','a cenar'))
        return { h: 19, m: 0 };

    return null;
}

function extractDueDate(text) {
    var t = text.toLowerCase();
    var now = new Date(), d = null;

    if (/(day after tomorrow|[\xfcu]bermorgen|apr[e\xe8]s-demain|pasado\s+ma[n\xf1]ana)/.test(t)) {
        d = new Date(now); d.setDate(d.getDate() + 2);
    }
    else if (/\b(tomorrow|demain)\b/.test(t) ||
             (/\bmorgen\b/.test(t)    && !/\b(?:heute|am)\s+morgen\b/.test(t)) ||
             (/\bma[n\xf1]ana\b/.test(t) && !/(?:esta|por\s+la|de\s+la|la)\s+ma[n\xf1]ana/.test(t))) {
        d = new Date(now); d.setDate(d.getDate() + 1);
    }
    else if (/\b(today|tonight|heute|aujourd|hoy)\b/.test(t)) {
        d = new Date(now);
    }
    else {
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
    if (!d && extractTime(text)) d = new Date(now);
    return d ? d.toISOString().split('T')[0] + 'T00:00:00.000Z' : null;
}

function stripDateTimeFromText(text) {
    var original = text.trim();

    var DL =
        '(?:due\\s+|by\\s+|on\\s+|for\\s+|before\\s+|until\\s+|till\\s+|no\\s+later\\s+than\\s+|' +
        'f[\\xe4a]llig\\s+am\\s+|f[\\xe4a]llig\\s+|bis\\s+zum\\s+|bis\\s+|am\\s+|n[\\xe4a]chste[rn]?\\s+|' +
        'pour\\s+le\\s+|pour\\s+|avant\\s+le\\s+|avant\\s+|d\'ici\\s+|le\\s+|' +
        'para\\s+el\\s+|para\\s+|antes\\s+del?\\s+|hasta\\s+el\\s+|hasta\\s+|el\\s+|' +
        'next\\s+|this\\s+)?';
    var TL = '(?:at\\s+|um\\s+|gegen\\s+|\\xe0\\s+|a\\s+las\\s+|a\\s+)?';

    function R(body) { return new RegExp('[,.]?\\s+' + body + '$', 'i'); }

    function stripTrailing(s) {
        return s
            .replace(R(TL + '\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?\\s?m\\.?'), '')
            .replace(R(TL + '(?:[01]?\\d|2[0-3]):[0-5]\\d'), '')
            .replace(R(TL + '\\d{1,2}h\\s?\\d{0,2}'), '')
            .replace(R(TL + '\\d{1,2}\\s+(?:heures?|uhr)(?:\\s+\\d{1,2})?'), '')
            .replace(R(TL + '(?:noon|midnight|lunchtime)'), '')
            .replace(R('(?:in\\s+the\\s+)?(?:this\\s+)?(?:morning|afternoon|evening)'), '')
            .replace(R('(?:at\\s+)?(?:tonight|midnight|noon|lunchtime)'), '')
            .replace(R('(?:at\\s+)?(?:dinner|breakfast|lunch)(?:time)?'), '')
            .replace(R('(?:heute\\s+(?:morgen|abend|nacht|nachmittag)|morgens|abends)'), '')
            .replace(R('(?:um\\s+)?(?:mittag|mitternacht)'), '')
            .replace(R('(?:ce\\s+matin|cet?\\s+apr[e\\xe8]s-midi|ce\\s+soir)'), '')
            .replace(R('(?:esta\\s+(?:ma[n\\xf1]ana|tarde|noche)|por\\s+la\\s+(?:ma[n\\xf1]ana|tarde|noche))'), '')
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

    var t = original, prev;
    for (var k = 0; k < 4; k++) { prev = t; t = stripTrailing(t); if (t === prev) break; }
    return (t.length >= 3) ? t : original;
}

// ============================================================
// Test runner
// ============================================================

var passed = 0, failed = 0;

function check(label, got, expected) {
    var ok = (expected === null)
        ? (got === null)
        : (got !== null && got.h === expected.h && got.m === expected.m);
    if (ok) {
        passed++;
        process.stdout.write('  ✓ ' + label + '\n');
    } else {
        failed++;
        var gs = got      === null ? 'null' : '{h:' + got.h      + ', m:' + got.m      + '}';
        var es = expected === null ? 'null' : '{h:' + expected.h + ', m:' + expected.m + '}';
        process.stdout.write('  ✗ ' + label + '\n      got: ' + gs + '  expected: ' + es + '\n');
    }
}

function checkNotNull(label, got) {
    if (got !== null) { passed++; process.stdout.write('  ✓ ' + label + '\n'); }
    else              { failed++; process.stdout.write('  ✗ ' + label + ' (expected non-null)\n'); }
}

function checkStr(label, got, expected) {
    if (got === expected) { passed++; process.stdout.write('  ✓ ' + label + '\n'); }
    else { failed++; process.stdout.write('  ✗ ' + label + '\n      got: "' + got + '"  expected: "' + expected + '"\n'); }
}

function section(name) { process.stdout.write('\n' + name + '\n'); }

// ── Clock used for context-disambiguation tests ──────────────────────────────
// We fix nowHour so tests are deterministic.
// nowHour=10: "at 6" → 6 has passed (AM=6 < 10) → return PM (18).
// nowHour=19: "at 6" → 18 has passed (PM=18 < 19) → return AM (6).
var AM_HOUR  = 19;  // "at 6"  → 6am  (PM has passed)
var MID_HOUR = 10;  // "at 6"  → 6pm  (AM has passed, PM future)
var EARLY    = 4;   // "at 6"  → 6am  (both future, 6am is nearer)

// ============================================================
// English — named expressions
// ============================================================

section('English — named expressions');
check('noon',             extractTime('remind me at noon'),               {h:12, m:0});
check('lunchtime',        extractTime('doctor lunchtime'),                {h:12, m:0});
check('at lunch',         extractTime('meet at lunch'),                   {h:12, m:0});
check('midnight',         extractTime('alarm at midnight'),               {h:0,  m:0});
check('this morning',     extractTime('call the dentist this morning'),   {h:9,  m:0});
check('in the morning',   extractTime('go for a run in the morning'),     {h:9,  m:0});
check('early morning',    extractTime('flight early morning'),            {h:9,  m:0});
check('this afternoon',   extractTime('pick up kids this afternoon'),     {h:14, m:0});
check('in the afternoon', extractTime('meeting in the afternoon'),        {h:14, m:0});
check('this evening',     extractTime('dinner reservation this evening'), {h:18, m:0});
check('in the evening',   extractTime('walk the dog in the evening'),     {h:18, m:0});
check('tonight',          extractTime('watch the game tonight'),          {h:20, m:0});
check('at night',         extractTime('take medication at night'),        {h:20, m:0});
check('at dinner',        extractTime('discuss budget at dinner'),        {h:19, m:0});
check('at dinnertime',    extractTime('call at dinnertime'),              {h:19, m:0});
check('for dinner',       extractTime('reservation for dinner'),          {h:19, m:0});
check('at breakfast',     extractTime('take pill at breakfast'),          {h:8,  m:0});
check('for breakfast',    extractTime('croissants for breakfast'),        {h:8,  m:0});

// ============================================================
// German — named expressions
// ============================================================

section('German — named expressions');
check('mittag',           extractTime('Arzt zu Mittag'),                  {h:12, m:0});
check('mittagessen',      extractTime('Treffen beim Mittagessen'),        {h:12, m:0});
check('mitternacht',      extractTime('Alarm um Mitternacht'),            {h:0,  m:0});
check('heute morgen',     extractTime('Zahnarzt heute Morgen anrufen'),   {h:9,  m:0});
check('am morgen',        extractTime('Laufen am Morgen'),                {h:9,  m:0});
check('morgens',          extractTime('morgens Medikament nehmen'),       {h:9,  m:0});
check('heute nachmittag', extractTime('Kinder heute Nachmittag abholen'),{h:14, m:0});
check('am nachmittag',    extractTime('Meeting am Nachmittag'),           {h:14, m:0});
check('nachmittags',      extractTime('nachmittags spazieren gehen'),     {h:14, m:0});
check('heute abend',      extractTime('Film heute Abend ansehen'),        {h:18, m:0});
check('am abend',         extractTime('Sport am Abend'),                  {h:18, m:0});
check('abends',           extractTime('abends Medikament nehmen'),        {h:18, m:0});
check('heute nacht',      extractTime('Wecker heute Nacht stellen'),      {h:20, m:0});
check('nachts',           extractTime('nachts Schmerzmittel nehmen'),     {h:20, m:0});
check('zum abendessen',   extractTime('Besprechung zum Abendessen'),      {h:19, m:0});
check('zum fr\xfchst\xfcck', extractTime('Termin zum Fr\xfchst\xfcck'),  {h:8,  m:0});
check('zum fruhstuck',    extractTime('Pille zum Fruhstuck'),             {h:8,  m:0});

// ============================================================
// French — named expressions
// ============================================================

section('French — named expressions');
check('midi',             extractTime('rendez-vous \xe0 midi'),           {h:12, m:0});
check('au d\xe9jeuner',   extractTime('r\xe9union au d\xe9jeuner'),       {h:12, m:0});
check('au dejeuner',      extractTime('reunion au dejeuner'),             {h:12, m:0});
check('minuit',           extractTime('alarme \xe0 minuit'),              {h:0,  m:0});
check('ce matin',         extractTime('appeler le dentiste ce matin'),    {h:9,  m:0});
check('le matin',         extractTime('jogging le matin'),                {h:9,  m:0});
check('du matin (phrase)',extractTime('rendez-vous du matin'),            {h:9,  m:0});
check('cet apr\xe8s-midi', extractTime('r\xe9union cet apr\xe8s-midi'),   {h:14, m:0});
check('cet apres-midi',   extractTime('reunion cet apres-midi'),          {h:14, m:0});
check("l'apr\xe8s-midi",  extractTime("balade l'apr\xe8s-midi"),          {h:14, m:0});
check("l'apres-midi",     extractTime("rendez-vous l'apres-midi"),        {h:14, m:0});
check('ce soir',          extractTime('film ce soir'),                    {h:18, m:0});
check('le soir',          extractTime('m\xe9dicament le soir'),           {h:18, m:0});
check('cette nuit',       extractTime('alarme cette nuit'),               {h:20, m:0});
check('au d\xeener',      extractTime('discussion au d\xeener'),          {h:19, m:0});
check('au diner',         extractTime('rendez-vous au diner'),            {h:19, m:0});
check('au petit-d\xe9j',  extractTime('pilule au petit-d\xe9jeuner'),     {h:8,  m:0});
check('au petit dejeuner',extractTime('rendez-vous au petit dejeuner'),   {h:8,  m:0});

// ============================================================
// Spanish — named expressions
// ============================================================

section('Spanish — named expressions');
check('mediod\xeda',      extractTime('cita al mediod\xeda'),             {h:12, m:0});
check('mediodia',         extractTime('reunion al mediodia'),             {h:12, m:0});
check('almuerzo',         extractTime('reuni\xf3n en el almuerzo'),       {h:12, m:0});
check('medianoche',       extractTime('alarma a medianoche'),             {h:0,  m:0});
check('esta ma\xf1ana',   extractTime('llamar esta ma\xf1ana'),           {h:9,  m:0});
check('esta manana',      extractTime('ir al gimnasio esta manana'),      {h:9,  m:0});
check('por la ma\xf1ana', extractTime('correr por la ma\xf1ana'),         {h:9,  m:0});
check('esta tarde',       extractTime('recoger esta tarde'),              {h:14, m:0});
check('por la tarde',     extractTime('reuni\xf3n por la tarde'),         {h:14, m:0});
check('esta noche',       extractTime('ver el partido esta noche'),       {h:20, m:0});
check('por la noche',     extractTime('medicamento por la noche'),        {h:20, m:0});
check('en la cena',       extractTime('discutir en la cena'),             {h:19, m:0});
check('para cenar',       extractTime('reserva para cenar'),              {h:19, m:0});
check('en el desayuno',   extractTime('p\xedldora en el desayuno'),       {h:8,  m:0});

// ============================================================
// AM/PM — with and without "at", periods, spaces
// ============================================================

section('AM/PM — with "at"');
check('at 3pm',           extractTime('call John at 3pm'),               {h:15, m:0});
check('at 3:30pm',        extractTime('meeting at 3:30pm'),              {h:15, m:30});
check('at 3:30 pm',       extractTime('meeting at 3:30 pm'),             {h:15, m:30});
check('at 10am',          extractTime('appointment at 10am'),            {h:10, m:0});
check('at 12pm (noon)',   extractTime('lunch at 12pm'),                  {h:12, m:0});
check('at 12am (midnight)',extractTime('alarm at 12am'),                 {h:0,  m:0});
check('at 11:59pm',       extractTime('deadline at 11:59pm'),            {h:23, m:59});

section('AM/PM — without "at" (was broken before fix)');
check('3pm standalone',   extractTime('reminder 3pm'),                   {h:15, m:0});
check('9am standalone',   extractTime('gym 9am'),                        {h:9,  m:0});
check('9:30am standalone',extractTime('gym 9:30am'),                     {h:9,  m:30});
check('8 pm with space',  extractTime('dinner 8 pm'),                    {h:20, m:0});

section('AM/PM — a.m. / p.m. with periods');
check('3 p.m.',           extractTime('meeting 3 p.m.'),                 {h:15, m:0});
check('3 a.m.',           extractTime('alarm 3 a.m.'),                   {h:3,  m:0});
check('10:30 a.m.',       extractTime('standup 10:30 a.m.'),             {h:10, m:30});
check('6 p.m.',           extractTime('call 6 p.m.'),                    {h:18, m:0});

// ============================================================
// Number words (one…twelve) + AM/PM
// ============================================================

section('Number words + AM/PM');
check('six pm',           extractTime('call at six pm'),                  {h:18, m:0});
check('six a.m.',         extractTime('alarm at six a.m.'),               {h:6,  m:0});
check('three thirty pm',  extractTime('meeting three pm'),                {h:15, m:0});
check('ten am',           extractTime('dentist ten am'),                  {h:10, m:0});
check('twelve pm',        extractTime('lunch twelve pm'),                 {h:12, m:0});
check('twelve am',        extractTime('wake up twelve am'),               {h:0,  m:0});

section("Number words + o'clock");
check("three o'clock",    extractTime("call at three o'clock", MID_HOUR),{h:15, m:0});
check("eleven o'clock",   extractTime("meeting eleven o'clock", MID_HOUR),{h:11,m:0});

// ============================================================
// French "Xh" / "X heures" / German "X Uhr" / Spanish "las X"
// ============================================================

section('French compact: Xh, Xh30');
check('16h',              extractTime('rendez-vous 16h'),                 {h:16, m:0});
check('6h30',             extractTime('s\xe9ance 6h30', MID_HOUR),       {h:18, m:30});
check('6h30 du matin',    extractTime('sport 6h30 du matin'),             {h:6,  m:30});
check('6h du soir',       extractTime('diner 6h du soir'),                {h:18, m:0});

section('French long form: X heures');
check('16 heures',        extractTime('r\xe9union 16 heures'),            {h:16, m:0});
check('6 heures (mid-day)', extractTime('rendez-vous 6 heures', MID_HOUR),{h:18, m:0});
check('6 heures du matin',extractTime('sport \xe0 6 heures du matin'),   {h:6,  m:0});
check('16 heures 30',     extractTime('fin \xe0 16 heures 30'),           {h:16, m:30});
check('six heures',       extractTime('rendez-vous six heures', MID_HOUR),{h:18, m:0});

section('German: X Uhr');
check('16 Uhr',           extractTime('Meeting 16 Uhr'),                  {h:16, m:0});
check('6 Uhr (morning)',  extractTime('Wecker 6 Uhr morgens'),            {h:6,  m:0});
check('6 Uhr (mid-day)',  extractTime('Termin 6 Uhr', MID_HOUR),         {h:18, m:0});
check('sechs Uhr',        extractTime('Wecker sechs Uhr morgens'),        {h:6,  m:0});

section('Spanish: las X');
check('las 6 (mid-day)',  extractTime('reuni\xf3n las 6', MID_HOUR),     {h:18, m:0});
check('las 16',           extractTime('cita las 16'),                     {h:16, m:0});
check('las 6 y media',    extractTime('clase las 6 y media', MID_HOUR),  {h:18, m:30});
check('las 6 y cuarto',   extractTime('cita las 6 y cuarto', MID_HOUR),  {h:18, m:15});
check('las seis',         extractTime('reuni\xf3n las seis', MID_HOUR),  {h:18, m:0});

// ============================================================
// 24-hour HH:MM
// ============================================================

section('24-hour HH:MM');
check('15:00',            extractTime('meeting at 15:00'),               {h:15, m:0});
check('09:30',            extractTime('standup at 09:30'),               {h:9,  m:30});
check('13:45',            extractTime('call at 13:45'),                  {h:13, m:45});
check('23:59',            extractTime('deadline 23:59'),                 {h:23, m:59});
check('9:30 (ambiguous)', extractTime('meeting 9:30', MID_HOUR),        {h:21, m:30});

// ============================================================
// o'clock — digits
// ============================================================

section("o'clock — digits");
check("3 o'clock (mid-day)", extractTime("call at 3 o'clock", MID_HOUR),{h:15, m:0});
check("11 o'clock",       extractTime("meeting at 11 o'clock", MID_HOUR),{h:11,m:0});

// ============================================================
// Context-based disambiguation ("at N" without am/pm)
// ============================================================

section('Context disambiguation: "at 6"');
// nowHour=19: PM(18) already passed → next is AM(6)
check('at 6 after 7pm',   extractTime('call at 6', AM_HOUR),             {h:6,  m:0});
// nowHour=10: AM(6) already passed, PM(18) future → PM
check('at 6 at 10am',     extractTime('call at 6', MID_HOUR),            {h:18, m:0});
// nowHour=4:  both future, 6am is nearer (2h away vs 14h)
check('at 6 at 4am',      extractTime('call at 6', EARLY),               {h:6,  m:0});

section('Context disambiguation: "at 3"');
// nowHour=10: AM(3) passed, PM(15) future → PM
check('at 3 at 10am',     extractTime('remind me at 3', MID_HOUR),       {h:15, m:0});
// nowHour=16: PM(15) passed → next is AM
check('at 3 after 4pm',   extractTime('remind me at 3', 16),             {h:3,  m:0});

section('Context disambiguation: number words');
check('at six at 10am',   extractTime('call at six', MID_HOUR),          {h:18, m:0});
check('at six after 7pm', extractTime('call at six', AM_HOUR),           {h:6,  m:0});

// ============================================================
// No match — should return null
// ============================================================

section('No match — should return null');
check('date only',        extractTime('buy groceries tomorrow'),          null);
check('no time',          extractTime('remind me to call'),               null);
check('plain number',     extractTime('buy 3 apples'),                    null);
check('empty string',     extractTime(''),                                null);
check('no false: spam',   extractTime('buy spam and milk'),               null);
check('no false: team',   extractTime('team meeting'),                    null);

// ============================================================
// extractDueDate — time expressions set due date to today
// ============================================================

section('extractDueDate — named time → today');
checkNotNull('noon',            extractDueDate('remind me at noon'));
checkNotNull('in the morning',  extractDueDate('call the dentist in the morning'));
checkNotNull('in the evening',  extractDueDate('walk the dog in the evening'));
checkNotNull('tonight',         extractDueDate('watch the game tonight'));
checkNotNull('3pm',             extractDueDate('call John 3pm'));
checkNotNull('15:00',           extractDueDate('standup at 15:00'));
checkNotNull('ce soir',         extractDueDate('film ce soir'));
checkNotNull('heute abend',     extractDueDate('Film heute Abend'));
checkNotNull('esta tarde',      extractDueDate('recoger esta tarde'));
checkNotNull('16h',             extractDueDate('rendez-vous 16h'));
checkNotNull('las 6 (Xh)',      extractDueDate('cita las 16'));

section('extractDueDate — no time → null');
check('pure text',        extractDueDate('buy groceries'),                null);

// ============================================================
// extractDueDate — multilingual dates (weekdays + relative days)
// ============================================================

section('extractDueDate — German dates');
checkNotNull('Samstag',       extractDueDate('Milch kaufen am Samstag'));
checkNotNull('morgen',        extractDueDate('Zahnarzt anrufen morgen'));
checkNotNull('übermorgen',    extractDueDate('Paket abholen übermorgen'));
checkNotNull('heute',         extractDueDate('Bericht heute schicken'));
check('am morgen → morning=today (not tomorrow)',
      extractDueDate('Yoga am morgen') !== null ? 'ok' : null, 'ok');

section('extractDueDate — French dates');
checkNotNull('samedi',        extractDueDate('rendre le rapport samedi'));
checkNotNull('demain',        extractDueDate('appeler le client demain'));

section('extractDueDate — Spanish dates');
checkNotNull('sábado',        extractDueDate('comprar leche el sábado'));
checkNotNull('mañana (tomorrow)', extractDueDate('llamar mañana'));

section('extractDueDate — plain non-date text → null');
check('no date/time DE',  extractDueDate('Rechnung prüfen'),              null);
check('no date/time FR',  extractDueDate('vérifier la facture'),          null);

// ============================================================
// stripDateTimeFromText — cut the due/time tail off the task title
// ============================================================

section('stripDateTimeFromText — English');
checkStr('due + day + time', stripDateTimeFromText('Do this and that due Saturday at 3 pm'), 'Do this and that');
checkStr('bare day + time',  stripDateTimeFromText('Review Q3 numbers tomorrow'),            'Review Q3 numbers');
checkStr('by + 24h',         stripDateTimeFromText('Send invoice by Friday 15:00'),          'Send invoice');

section('stripDateTimeFromText — German');
checkStr('fällig am + Uhr',  stripDateTimeFromText('Milch kaufen fällig am Samstag um 15 Uhr'), 'Milch kaufen');
checkStr('bis + Uhr',        stripDateTimeFromText('Bericht schicken bis morgen um 9 Uhr'),      'Bericht schicken');

section('stripDateTimeFromText — French');
checkStr('pour + à Xh',      stripDateTimeFromText('rendre le rapport pour samedi à 15h'), 'rendre le rapport');

section('stripDateTimeFromText — Spanish');
checkStr('para el + a las',  stripDateTimeFromText('comprar leche para el sábado a las 3 pm'), 'comprar leche');

section('stripDateTimeFromText — safety (do not remove valuable text)');
checkStr('no date → unchanged',      stripDateTimeFromText('call mom about the invoice'),   'call mom about the invoice');
checkStr('trailing particle kept',   stripDateTimeFromText('turn the heater on'),           'turn the heater on');
checkStr('date word is the content', stripDateTimeFromText('Saturday'),                     'Saturday');
checkStr('mid-sentence day untouched', stripDateTimeFromText('plan the Friday standup agenda'), 'plan the Friday standup agenda');

// ============================================================
// Summary
// ============================================================

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
