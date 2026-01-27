#!/usr/bin/env node

import { runMigration } from './index.js';
import { loadConfig, createExampleConfig } from './config.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

async function main() {
  const args = process.argv.slice(2);
  
  // Handle --help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  
  // Handle --version
  if (args.includes('--version') || args.includes('-v')) {
    const pkg = require('../package.json');
    console.log(pkg.version);
    return;
  }
  
  // Handle --init
  if (args.includes('--init')) {
    const outputPath = args[args.indexOf('--init') + 1] || 'migration-config.json';
    await createExampleConfig(outputPath);
    console.log(`✓ Created example config at ${outputPath}`);
    return;
  }
  
  // Load config
  let configPath = 'migration-config.json';
  const configIndex = args.indexOf('--config');
  if (configIndex !== -1 && args[configIndex + 1]) {
    configPath = args[configIndex + 1];
  }
  
  console.log('FHIR R4 to R6 Migration Runner');
  console.log('==============================');
  console.log('');
  console.log(`Loading config from: ${configPath}`);
  
  try {
    const config = await loadConfig(configPath);
    const result = await runMigration(config);
    
    if (result.success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
FHIR R4 to R6 Migration Runner

Usage:
  fhir-r6-migrate [options]

Options:
  --config <path>    Path to configuration file (default: migration-config.json)
  --init [path]      Create an example configuration file
  --version, -v      Show version number
  --help, -h         Show this help message

Examples:
  # Run migration with default config
  fhir-r6-migrate

  # Run with custom config
  fhir-r6-migrate --config my-config.json

  # Create example config
  fhir-r6-migrate --init

Configuration:
  See README.md for detailed configuration options and examples.
`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
