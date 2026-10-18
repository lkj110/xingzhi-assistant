'use strict';

// A machine stream from node:test itself. Test stdout is deliberately a different
// event type; printing a fake "ok"/"passed" cannot create a passing test event.
module.exports = async function* reporter(events) {
  for await (const event of events) {
    const d = event.data;
    if (['test:pass', 'test:fail'].includes(event.type)) {
      yield JSON.stringify({type: event.type, name: d.name, file: d.file,
        nesting: d.nesting, skip: d.skip || false, todo: d.todo || false,
        duration: d.details?.duration_ms, error: d.details?.error?.message}) + '\n';
    } else if (event.type === 'test:summary') {
      yield JSON.stringify({type: event.type, file: d.file, success: d.success,
        counts: d.counts}) + '\n';
    } else if (['test:stdout', 'test:stderr', 'test:diagnostic'].includes(event.type)) {
      yield JSON.stringify({type: event.type, message: d.message}) + '\n';
    }
  }
};
