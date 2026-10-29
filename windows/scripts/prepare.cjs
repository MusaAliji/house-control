'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const web = path.join(root, 'web');
// Build the same assets that Android and macOS display.
const npmCLI = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!fs.existsSync(npmCLI)) throw new Error('Run this script through npm run prepare:assets.');
execFileSync(process.execPath, [npmCLI, 'run', 'build'], { cwd: web, stdio: 'inherit' });
const assets = path.join(root, 'windows/assets');
fs.mkdirSync(assets, { recursive: true });
fs.cpSync(path.join(web, 'dist'), path.join(assets, 'web'), { recursive: true });
fs.copyFileSync(path.join(root, 'android/app/src/main/res/drawable/app_icon.png'), path.join(assets, 'icon.png'));
// Chromium's TLS implementation does not guarantee the PSK cipher used by the phone.
// Ship a standard Node runtime for the isolated TLS sync worker.
const runtime = path.join(root, 'windows/runtime');
fs.mkdirSync(runtime, { recursive: true });
const target = path.join(runtime, 'node.exe');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (!fs.existsSync(target) || digest(target) !== digest(process.execPath)) fs.copyFileSync(process.execPath, target);
const license = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(runtime, 'LICENSE'));
console.log('Prepared desktop assets and standalone TLS runtime.');
