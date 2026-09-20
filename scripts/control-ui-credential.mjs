#!/usr/bin/env node
// Generates (or rotates) the Control UI password. Stores only the scrypt hash
// (mode 0600). Prints the password once on a TTY; otherwise writes it to
// <credential file>.first-password (0600) and prints only that path, so the
// secret never lands in an agent transcript. The server deletes that file
// after the first successful login. Requires a build (imports dist/).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file =
  process.env.CONTROL_UI_CREDENTIAL_FILE ||
  path.join(os.homedir(), '.config', 'deus', 'control-ui.json');
let auth;
try {
  auth = await import(pathToFileURL(path.join(here, '..', 'dist', 'control-ui', 'auth.js')).href);
} catch {
  console.error('dist/control-ui/auth.js not found — run `npm run build` first.');
  process.exit(1);
}
const password = auth.generatePassword();
auth.writeCredentialFile(file, password);
console.log(`Control UI credential written to ${file} (mode 0600).`);
if (process.stdout.isTTY) {
  console.log('Password — shown once, not stored anywhere:');
  console.log(`\n  ${password}\n`);
} else {
  const once = `${file}.first-password`;
  fs.writeFileSync(once, password + '\n', { mode: 0o600 });
  fs.chmodSync(once, 0o600);
  console.log(`Not a terminal — password written to ${once} (0600). Read it once; it is deleted after the first login.`);
}
