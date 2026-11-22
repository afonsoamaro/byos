#!/usr/bin/env node
import { realIO } from './io.js';
import { main } from './main.js';

const code = await main(process.argv.slice(2), realIO());
process.exitCode = code;
// A Ctrl+C can leave an upload request open; it must not keep the process alive.
if (code === 130) process.exit(130);
