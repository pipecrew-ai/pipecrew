#!/usr/bin/env node
'use strict';
/**
 * mint-domain-id.js — mint a stable opaque domain id into a workspace config.json.
 *
 * Id format: dom_<26-char Crockford-base32 ULID>
 *
 * Idempotent: if config.json already has domain.id, prints it and exits 0
 * without writing. Creates the `domain` block if absent; preserves any
 * existing domain content and all other config keys.
 *
 * Usage:
 *   node mint-domain-id.js --workspace-dir=<dir>   # dir containing config.json
 *   node mint-domain-id.js --config=<path>         # explicit path to config.json
 *
 * Prints the id to stdout. Exits 0 on success, 1 if no config is found.
 *
 * BOM-tolerant: strips a leading UTF-8 BOM before parsing (Windows editors add one).
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function argVal(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function resolveConfigPath() {
  const explicit = argVal('config');
  if (explicit) return explicit;
  const wsDir = argVal('workspace-dir');
  if (wsDir) return path.join(wsDir, 'config.json');
  return null;
}

// ---------------------------------------------------------------------------
// ULID — pure stdlib implementation
// Spec: https://github.com/ulid/spec
// Crockford base32 alphabet (no I, L, O, U to avoid ambiguity).
// ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value, chars) {
  let result = '';
  for (let i = 0; i < chars; i++) {
    result = CROCKFORD[value & 0x1f] + result;
    value = Math.floor(value / 32);
  }
  return result;
}

function generateULID() {
  const now = Date.now(); // 48-bit timestamp in ms

  // Timestamp: 48 bits → 10 Crockford chars
  const tHigh = Math.floor(now / Math.pow(2, 16));
  const tLow = now % Math.pow(2, 16);
  const timeStr = encodeBase32(tHigh, 6) + encodeBase32(tLow, 4);

  // Randomness: 80 bits → 16 Crockford chars (two 40-bit halves)
  // Use crypto.randomBytes if available for better entropy, fall back to Math.random.
  let randStr = '';
  try {
    const { randomBytes } = require('crypto');
    const buf = randomBytes(10); // 80 bits
    // Process 5 bytes (40 bits) at a time → 8 Crockford chars each
    for (let chunk = 0; chunk < 2; chunk++) {
      const offset = chunk * 5;
      // Read 40 bits as a number (JavaScript safe-integer range is 53 bits, so fine)
      const hi = (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
      const lo = buf[offset + 4];
      // Combine: hi is 32-bit signed; convert to unsigned, then combine with lo byte
      const hiU = hi >>> 0; // unsigned 32-bit
      // We have 40 bits total. Encode as 8 Crockford chars (each char = 5 bits).
      // Split: top 8 chars cover 40 bits. Use BigInt to avoid overflow.
      const big = BigInt(hiU) * 256n + BigInt(lo);
      let s = '';
      let v = big;
      for (let i = 0; i < 8; i++) {
        s = CROCKFORD[Number(v & 31n)] + s;
        v >>= 5n;
      }
      randStr += s;
    }
  } catch (_) {
    // Fallback: Math.random (lower entropy, acceptable for non-security id)
    for (let i = 0; i < 16; i++) {
      randStr += CROCKFORD[Math.floor(Math.random() * 32)];
    }
  }

  return timeStr + randStr; // 26 chars
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const configPath = resolveConfigPath();

if (!configPath || !fs.existsSync(configPath)) {
  const hint = configPath ? configPath : '(no --workspace-dir or --config specified)';
  console.error(`mint-domain-id: config.json not found: ${hint}`);
  console.error('Usage: node mint-domain-id.js --workspace-dir=<dir>  OR  --config=<path>');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, ''); // strip BOM
} catch (e) {
  console.error(`mint-domain-id: failed to read ${configPath}: ${e.message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (e) {
  console.error(`mint-domain-id: failed to parse ${configPath}: ${e.message}`);
  process.exit(1);
}

// Idempotency: if domain.id already exists and looks valid, print and exit.
if (config.domain && config.domain.id) {
  process.stdout.write(config.domain.id + '\n');
  process.exit(0);
}

// Mint a new id.
const newId = 'dom_' + generateULID();

// Write domain.id into the config — preserve all existing content.
if (!config.domain || typeof config.domain !== 'object') {
  config.domain = {};
}
// Prepend id as the first key in the domain block (spread trick to control order).
const { id: _discarded, ...restDomain } = config.domain;
config.domain = { id: newId, ...restDomain };

// Write back with 2-space indent (house style).
try {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error(`mint-domain-id: failed to write ${configPath}: ${e.message}`);
  process.exit(1);
}

process.stdout.write(newId + '\n');
process.exit(0);
