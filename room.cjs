// Compatibility entry: the v0 cold-start dispatcher has been retired.
require('./hub.cjs').main().catch(error => { console.error(error.message); process.exitCode = 1; });
