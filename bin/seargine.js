#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv).catch((error) => {
  process.stderr.write(`ERROR: DAEMON_ERROR: ${error.message}\n`);
  process.exit(1);
});
