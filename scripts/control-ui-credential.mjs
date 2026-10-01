#!/usr/bin/env node
// Sets the Control UI password. Stores only the scrypt hash (mode 0600).
//
//   node scripts/control-ui-credential.mjs            random password
//   node scripts/control-ui-credential.mjs --choose   type your own
//
// Random: printed once on a TTY. Without a terminal it is first-time setup
// only: the password is written to <credential file>.first-password (0600)
// and only that path is printed, so the secret never lands in an agent
// transcript; the server deletes that file after the first successful login.
// Once a credential file exists, changing it needs an interactive terminal,
// so a session cannot quietly reset the password and sign in. This only
// removes the easy route: every process here can delete the file first, or
// write it directly. The real control is in the server, which announces every
// sign-in and every password change in the control group.
//
// --choose: asks twice at a hidden prompt and never prints it. It works only
// from an interactive terminal, and there is deliberately no way to pass the
// password as an argument, an environment variable or a pipe: those end up in
// shell history, `ps` output or a transcript. Minimum 10 characters.
//
// Either way the running server notices the new file on the next request and
// signs every open session out; no restart. Forgot a chosen password? Run this
// again with no flag from a terminal and a fresh random one is printed.
//
// Requires a build (imports dist/), but only for the write itself: arguments
// and the terminal check are validated first, so a typo changes nothing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const USAGE = 'usage: node scripts/control-ui-credential.mjs [--choose]';
const MIN = 10;
const MAX = 256;

// Validated before anything is read or written. Without this, a mistyped
// `--chose` fell through to the default path and silently replaced the
// password with a random one.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--choose')) {
  console.error(`Unrecognised option: ${args.join(' ')}\n${USAGE}\nNothing was changed.`);
  process.exit(2);
}
const choose = args[0] === '--choose';
if (choose && !(process.stdin.isTTY && process.stdout.isTTY)) {
  console.error(
    '--choose needs an interactive terminal, so the password is typed at a hidden prompt\n' +
      'and never passes through a pipe, an argument or a log. Nothing was changed.',
  );
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file =
  process.env.CONTROL_UI_CREDENTIAL_FILE ||
  path.join(os.homedir(), '.config', 'deus', 'control-ui.json');
const once = `${file}.first-password`;
if (!choose && fs.existsSync(file) && !(process.stdin.isTTY && process.stdout.isTTY)) {
  console.error(
    'A dashboard password is already set. Changing it needs an interactive terminal,\n' +
      'so run this from one (with no flag for a random password, or --choose). Nothing was changed.',
  );
  process.exit(2);
}
let auth;
try {
  auth = await import(pathToFileURL(path.join(here, '..', 'dist', 'control-ui', 'auth.js')).href);
} catch {
  console.error('dist/control-ui/auth.js not found — run `npm run build` first.');
  process.exit(1);
}

/** One hidden line from the terminal. Resolves null on Ctrl-C / Ctrl-D. */
function ask(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (result) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    // Escape sequences (arrow keys and the like) are not part of a password.
    // They are parsed per character rather than per chunk, because typed text
    // and a sequence can arrive in the same chunk: ESC, then for CSI/SS3 the
    // introducer and everything up to the final byte in @..~, are dropped.
    // Enter and the abort keys always act, even mid-sequence, so a bare Esc
    // before Enter cannot swallow it, and a sequence that never terminates is
    // abandoned after a few bytes rather than eating every key that follows.
    let esc = 0; // 0 none, 1 saw ESC, 2 inside CSI/SS3
    let escLen = 0;
    // Code points, not UTF-16 units: Backspace after an emoji must remove the
    // whole character, not leave half a surrogate pair in what gets hashed.
    const chars = [];
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\x03' || ch === '\x04') return done(null);
        if (ch === '\r' || ch === '\n') return done(chars.join(''));
        if (esc === 1) {
          esc = ch === '[' || ch === 'O' ? 2 : 0;
          escLen = 0;
          continue;
        }
        if (esc === 2) {
          if ((ch >= '@' && ch <= '~') || ++escLen > 8) esc = 0;
          continue;
        }
        if (ch === '\x1b') {
          esc = 1;
          continue;
        }
        if (ch === '\x7f' || ch === '\b') chars.pop();
        else if (ch >= ' ') chars.push(ch);
      }
    };
    stdin.on('data', onData);
  });
}

if (choose) {
  const verb = fs.existsSync(file) ? 'Changing' : 'Setting';
  console.log(`${verb} the dashboard password. Nothing you type will show. At least ${MIN} characters.`);
  const first = await ask('New password: ');
  if (first === null) {
    console.error('Cancelled. Nothing was changed.');
    process.exit(130);
  }
  if (first.length < MIN || first.length > MAX) {
    console.error(`That is ${first.length} characters; it needs ${MIN} to ${MAX}. Nothing was changed.`);
    process.exit(1);
  }
  if (first !== first.trim()) {
    console.error('It starts or ends with a space, which is almost always a paste slip. Nothing was changed.');
    process.exit(1);
  }
  const second = await ask('Type it again: ');
  if (second === null) {
    console.error('Cancelled. Nothing was changed.');
    process.exit(130);
  }
  if (second !== first) {
    console.error('Passwords did not match. Nothing was changed.');
    process.exit(1);
  }
  auth.writeCredentialFile(file, first);
  // A generated plaintext left over from an earlier random rotation must not
  // outlive the password it belonged to.
  fs.rmSync(once, { force: true });
  console.log('Password changed. Open dashboard tabs are signed out; log in again with the new one.');
  process.exit(0);
}

const password = auth.generatePassword();
auth.writeCredentialFile(file, password);
console.log(`Control UI credential written to ${file} (mode 0600).`);
if (process.stdout.isTTY) {
  console.log('Password — shown once, not stored anywhere:');
  console.log(`\n  ${password}\n`);
} else {
  fs.writeFileSync(once, password + '\n', { mode: 0o600 });
  fs.chmodSync(once, 0o600);
  console.log(`Not a terminal — password written to ${once} (0600). Read it once; it is deleted after the first login.`);
}
