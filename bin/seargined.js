#!/usr/bin/env node
import { startDaemon } from '../src/daemon.js';

startDaemon().catch((error) => {
  process.stderr.write(`seargined failed to start: ${error.stack || error.message}\n`);
  process.exit(1);
});
