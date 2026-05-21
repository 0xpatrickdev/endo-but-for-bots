#!/usr/bin/env node
/* eslint-disable no-restricted-globals, no-undef */
// @ts-nocheck
//
// Daemon-shipped GIT_ASKPASS helper. Native git invokes this binary
// once per credential prompt ("Username for ...:", "Password for ...:").
// The helper reads a single newline-terminated line from the inherited
// file descriptor named in ENDO_GIT_ASKPASS_FD and writes it to stdout.
//
// The daemon-side writer (packages/daemon/src/daemon-node-powers.js
// runGitCredentialed) writes the lines in the order git will request
// them: <username>\n<password>\n. Each helper invocation consumes one
// line; the pipe's underlying open file description is held open by
// git across askpass invocations, so the second helper sees the line
// the first did not consume.
//
// The secret never appears in argv, the process environment, the
// filesystem, or any persisted artifact: only the fd number rides
// through environ, and the credential bytes ride the pipe.
//
// Errors exit non-zero with no diagnostics; native git surfaces a
// missing-credential failure to the daemon which translates it.

'use strict';

const fs = require('fs');

const fdRaw = process.env.ENDO_GIT_ASKPASS_FD;
if (fdRaw === undefined || fdRaw === '') {
  process.exit(1);
}
const fd = Number.parseInt(fdRaw, 10);
if (!Number.isInteger(fd) || fd < 3) {
  process.exit(1);
}

// Read one newline-terminated record from the inherited fd. The pipe
// is line-oriented; we accumulate bytes until we hit '\n' (or EOF).
// We read byte-at-a-time to avoid consuming bytes that belong to a
// later prompt's record.
const ONE_BYTE = Buffer.alloc(1);
let line = '';
for (;;) {
  let n;
  try {
    n = fs.readSync(fd, ONE_BYTE, 0, 1, null);
  } catch (_err) {
    process.exit(1);
  }
  if (n === 0) {
    // EOF before newline: empty / truncated record.
    break;
  }
  const byte = ONE_BYTE[0];
  if (byte === 0x0a /* '\n' */) {
    break;
  }
  line += String.fromCharCode(byte);
}

// Write the line back to git as the credential response. No trailing
// newline: git accepts both, and omitting it avoids confusing the
// credential parser with embedded whitespace.
process.stdout.write(line);
