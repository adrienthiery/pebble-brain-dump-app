// Tests for destination selection: the user's routing settings decide, with no
// hidden rule moving a note away from the AI.
// Run: node test/routing.test.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pkjsPath = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');
var pkjsSource = fs.readFileSync(pkjsPath, 'utf8');

var context = {
    console: { log: function() {} },
    setTimeout: function(callback) { callback(); },
    localStorage: { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {} },
    Pebble: {
        addEventListener: function() {},
        sendAppMessage: function(message, onSuccess) { if (onSuccess) onSuccess(); },
        openURL: function() {},
        getTimelineToken: function(onSuccess) { onSuccess('timeline-token'); }
    }
};

vm.createContext(context);
vm.runInContext(pkjsSource, context, { filename: pkjsPath });

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

function route(text, cfg) {
    return context.pickDest(text, context.getEnabledDests(cfg), cfg, false);
}

process.stdout.write('Smart routing off\n');

var aiOnly = { ai_enabled: true, routing_auto: false, default_dest: 'ai' };
check('a question with a task phrase goes to the AI default (#23)',
    route('What did we have to remember?', aiOnly), 'ai');
check('a reminder still goes to the AI default',
    route('Remind me to call mum tomorrow', aiOnly), 'ai');

var aiAndTasks = { ai_enabled: true, tasks_enabled: true, routing_auto: false, default_dest: 'ai' };
check('an enabled task service does not take a note from the AI default',
    route('I need to buy milk', aiAndTasks), 'ai');

var tasksDefault = { ai_enabled: true, tasks_enabled: true, routing_auto: false, default_dest: 'tasks' };
check('a question goes to a non-AI default', route('What is the capital of France?', tasksDefault), 'tasks');

process.stdout.write('Smart routing on\n');

var auto = { ai_enabled: true, tasks_enabled: true, default_dest: 'ai' };
check('a task scores for the task service', route('Buy milk tomorrow', auto), 'tasks');
check('a question with a task phrase scores for the AI',
    route('What did we have to remember?', auto), 'ai');

var autoAiOnly = { ai_enabled: true, default_dest: 'ai' };
check('a reminder is not moved to local when only the AI is enabled',
    route('Remind me to call mum', autoAiOnly), 'ai');

var autoLocalDefault = { ai_enabled: true, default_dest: 'local' };
check('unscored text falls back to a local default', route('Milk and eggs', autoLocalDefault), 'local');

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) process.exit(1);
