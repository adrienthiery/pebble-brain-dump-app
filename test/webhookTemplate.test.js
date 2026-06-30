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

process.stdout.write('\nPassed: ' + passed + '  Failed: ' + failed + '\n');
if (failed > 0) process.exit(1);
