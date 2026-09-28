#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, a few at a
 * time, and fails if any of them fails.
 *
 *   npm test                  # everything
 *   npm test -- seo revisions # only files whose name contains one of the words
 *   npm test -- --strict      # a skipped test fails the run too
 *
 * Plain Node: temp SQLite files, in-process HTTP, no network.
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 60000, pad: 32 });
