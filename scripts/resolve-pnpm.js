#!/usr/bin/env node
/**
 * scripts/resolve-pnpm.js — backward-compat shim.
 *
 * In v1.0 this was the primary entry point. In v1.1 it delegates to
 * bin/mcp-mac-setup.js with --binary pnpm so existing scripts that call
 * `node scripts/resolve-pnpm.js` keep working unchanged.
 */
"use strict";
require("../bin/mcp-mac-setup.js");
