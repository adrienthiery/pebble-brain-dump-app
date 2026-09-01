// Unit tests for webhook URL templating helpers (Brain Dump pkjs)
// Run: node test/webhookTemplate.test.js

function buildWebhookPayload(text, timestamp) {
    return {
        text: text,
        timestamp: timestamp
    };
}

function applyWebhookTemplate(url, payload) {
    var json = encodeURIComponent(JSON.stringify(payload));
    return url
        .replace(/\{text\}/g, encodeURIComponent(payload.text))
        .replace(/\{timestamp\}/g, String(payload.timestamp))
        .replace(/\{json\}/g, json);
}

function jsonStringEscape(s) {
    var quoted = JSON.stringify(String(s));
    return quoted.substring(1, quoted.length - 1);
}

function applyWebhookBodyTemplate(tpl, payload) {
    return tpl.replace(/\{(text_url|text|timestamp|json)\}/g, function(_, key) {
        if (key === 'text')      return jsonStringEscape(payload.text);
        if (key === 'text_url')  return encodeURIComponent(payload.text);
        if (key === 'timestamp') return String(payload.timestamp);
        return JSON.stringify(payload);
    });
}

function buildWebhookBody(body, payload) {
    var tpl = (body || '').trim();
    if (!tpl) return JSON.stringify(payload);
    return applyWebhookBodyTemplate(tpl, payload);
}

var WEBHOOK_DEFAULT_CONTENT_TYPE = 'application/json';

function buildWebhookContentType(contentType) {
    return (contentType || '').trim() || WEBHOOK_DEFAULT_CONTENT_TYPE;
}

function buildWebhookUrl(url, verb, payload) {
    var templatedUrl = applyWebhookTemplate(url, payload);
    if (templatedUrl !== url) return templatedUrl;
    if (verb !== 'GET') return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') +
        'text=' + encodeURIComponent(payload.text) +
        '&timestamp=' + payload.timestamp;
}

var passed = 0;
var failed = 0;

function check(label, got, expected) {
    if (got === expected) {
        passed++;
        process.stdout.write('  ✓ ' + label + '\n');
    } else {
        failed++;
        process.stdout.write('  ✗ ' + label + '\n      got: ' + got + '\n expected: ' + expected + '\n');
    }
}

function checkObject(label, got, expected) {
    var g = JSON.stringify(got);
    var e = JSON.stringify(expected);
    check(label, g, e);
}

function section(name) {
    process.stdout.write('\n' + name + '\n');
}

var payload = buildWebhookPayload('Quote " and spaces', 1770000000);

section('Template placeholders');
check(
    '{text} URL-encodes note text',
    applyWebhookTemplate('https://x.test/hook?text={text}', payload),
    'https://x.test/hook?text=Quote%20%22%20and%20spaces'
);
check(
    '{timestamp} inserts unix seconds',
    applyWebhookTemplate('https://x.test/hook?ts={timestamp}', payload),
    'https://x.test/hook?ts=1770000000'
);
checkObject(
    '{json} round-trips through decodeURIComponent',
    JSON.parse(decodeURIComponent(applyWebhookTemplate('{json}', payload))),
    payload
);

section('GET fallback');
check(
    'GET without placeholders appends query on bare URL',
    buildWebhookUrl('https://x.test/hook', 'GET', payload),
    'https://x.test/hook?text=Quote%20%22%20and%20spaces&timestamp=1770000000'
);
check(
    'GET without placeholders appends with & when query exists',
    buildWebhookUrl('https://x.test/hook?key=abc', 'GET', payload),
    'https://x.test/hook?key=abc&text=Quote%20%22%20and%20spaces&timestamp=1770000000'
);

section('AutoRemote-style URL');
var autoRemoteUrl = buildWebhookUrl(
    'https://autoremotejoaomgcd.appspot.com/sendmessage?key=KEY&message=brain_dump=:={json}',
    'GET',
    payload
);
check(
    'Templated GET URL keeps AutoRemote query layout',
    autoRemoteUrl.indexOf('message=brain_dump=:=') >= 0 ? 'yes' : 'no',
    'yes'
);
checkObject(
    'AutoRemote payload decodes to valid JSON',
    JSON.parse(decodeURIComponent(autoRemoteUrl.split('=:=')[1])),
    payload
);

section('Body template');
check(
    'empty body keeps the default payload',
    buildWebhookBody('', payload),
    JSON.stringify(payload)
);
check(
    'whitespace-only body counts as empty',
    buildWebhookBody('   \n  ', payload),
    JSON.stringify(payload)
);
check(
    'undefined body keeps the default payload',
    buildWebhookBody(undefined, payload),
    JSON.stringify(payload)
);
checkObject(
    '{text} stays valid JSON when the note has quotes',
    JSON.parse(buildWebhookBody('{"content": "{text}"}', payload)),
    { content: 'Quote " and spaces' }
);
check(
    '{timestamp} inserts an unquoted number',
    buildWebhookBody('{"ts": {timestamp}}', payload),
    '{"ts": 1770000000}'
);
checkObject(
    '{json} inserts the default payload verbatim',
    JSON.parse(buildWebhookBody('{"event": {json}}', payload)),
    { event: payload }
);

var trickyPayload = buildWebhookPayload('newline\nand \\ backslash', 1770000000);
checkObject(
    'newlines and backslashes survive as JSON',
    JSON.parse(buildWebhookBody('{"content": "{text}"}', trickyPayload)),
    { content: 'newline\nand \\ backslash' }
);

var placeholderPayload = buildWebhookPayload('literally {timestamp} here', 1770000000);
checkObject(
    'a note containing {timestamp} is not re-substituted',
    JSON.parse(buildWebhookBody('{"content": "{text}"}', placeholderPayload)),
    { content: 'literally {timestamp} here' }
);

check(
    'a non-JSON template is passed through as written',
    buildWebhookBody('note={text}', buildWebhookPayload('hello', 1770000000)),
    'note=hello'
);

var formPayload = buildWebhookPayload('a & b = c', 1770000000);
check(
    '{text_url} escapes a form-urlencoded body',
    buildWebhookBody('note={text_url}&ts={timestamp}', formPayload),
    'note=a%20%26%20b%20%3D%20c&ts=1770000000'
);
check(
    '{text_url} and {text} escape the same note differently',
    buildWebhookBody('{text_url}', payload) + ' | ' + buildWebhookBody('{text}', payload),
    encodeURIComponent(payload.text) + ' | ' + 'Quote \\" and spaces'
);

section('Content-Type');
check(
    'unset falls back to application/json',
    buildWebhookContentType(undefined),
    'application/json'
);
check(
    'blank falls back to application/json',
    buildWebhookContentType('   '),
    'application/json'
);
check(
    'a configured type is sent as written, trimmed',
    buildWebhookContentType(' application/x-www-form-urlencoded '),
    'application/x-www-form-urlencoded'
);

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
