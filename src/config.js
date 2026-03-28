import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathExists } from './utils/fs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG_VERSION = '1.0.3';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  packageId: null,
  packageVersion: 'current',
  enableGoFSH: true,
  resourcesDir: 'Resources',
  resourcesR6Dir: 'ResourcesR6',
  compareDir: 'compare',
  outputDir: 'output',
  rulesConfigPath: null,
  validatorJarPath: null,
  workdir: null,
  compareMode: 'incremental',
  exportZip: true,
  skipTerminologyReport: false,
  skipSearchParameterReport: false,
};

/**
 * Loads and validates a configuration file
 */
export async function loadConfig(configPath) {
  const raw = await fsp.readFile(configPath, 'utf8');
  let config = JSON.parse(raw);
  const originalVersion = config.configVersion;
  
  // Migrate config if needed
  config = migrateConfig(config);
  
  // Write back to file if migration occurred
  if (config.configVersion !== originalVersion) {
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`  Config file updated to version ${config.configVersion}`);
  }
  
  // Validate config version
  validateConfigVersion(config);
  
  // Merge with defaults
  const merged = { ...DEFAULT_CONFIG, ...config };
  
  // Validate required fields
  validateConfig(merged);
  
  return merged;
}

/**
 * Migrates configuration from older versions to the current version
 */
function migrateConfig(config) {
  if (!config.configVersion) {
    // Very old config without version - add all new fields
    console.log('  Migrating config from pre-1.0.0 to current version...');
    config.configVersion = CONFIG_VERSION;
    if (config.skipTerminologyReport === undefined) {
      config.skipTerminologyReport = false;
    }
    if (config.skipSearchParameterReport === undefined) {
      config.skipSearchParameterReport = false;
    }
    return config;
  }
  
  const [major, minor, patch] = config.configVersion.split('.').map(Number);
  
  // Migrate from 1.0.0 or 1.0.1 to 1.0.2/1.0.3
  if (major === 1 && minor === 0 && (patch === 0 || patch === 1)) {
    console.log(`  Migrating config from ${config.configVersion} to ${CONFIG_VERSION}...`);
    if (config.skipTerminologyReport === undefined) {
      config.skipTerminologyReport = false;
    }
    if (config.skipSearchParameterReport === undefined) {
      config.skipSearchParameterReport = false;
    }
    config.configVersion = CONFIG_VERSION;
  }

  if (major === 1 && minor === 0 && patch === 2) {
    console.log(`  Migrating config from ${config.configVersion} to ${CONFIG_VERSION}...`);
    if (config.skipSearchParameterReport === undefined) {
      config.skipSearchParameterReport = false;
    }
    config.configVersion = CONFIG_VERSION;
  }
  
  return config;
}

/**
 * Validates the configuration version
 */
function validateConfigVersion(config) {
  if (!config.configVersion) {
    throw new Error(
      `Missing 'configVersion' field in config. Expected version: ${CONFIG_VERSION}`
    );
  }
  
  const [major, minor] = config.configVersion.split('.').map(Number);
  const [expectedMajor] = CONFIG_VERSION.split('.').map(Number);
  
  if (major !== expectedMajor) {
    throw new Error(
      `Incompatible config version: ${config.configVersion}. Expected major version: ${expectedMajor}`
    );
  }
}

/**
 * Validates the configuration object
 */
function validateConfig(config) {
  const errors = [];
  
  if (!config.packageId && config.enableGoFSH) {
    errors.push('packageId is required when enableGoFSH is true');
  }
  
  if (!config.resourcesDir) {
    errors.push('resourcesDir is required');
  }
  
  if (!config.resourcesR6Dir) {
    errors.push('resourcesR6Dir is required');
  }
  
  if (!config.compareDir) {
    errors.push('compareDir is required');
  }
  
  if (!config.outputDir) {
    errors.push('outputDir is required');
  }
  
  if (config.compareMode && !['incremental', 'full'].includes(config.compareMode)) {
    errors.push('compareMode must be either "incremental" or "full"');
  }

  if (typeof config.exportZip !== 'boolean') {
    errors.push('exportZip must be a boolean');
  }

  if (typeof config.skipTerminologyReport !== 'boolean') {
    errors.push('skipTerminologyReport must be a boolean');
  }

  if (typeof config.skipSearchParameterReport !== 'boolean') {
    errors.push('skipSearchParameterReport must be a boolean');
  }
  
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Creates an example configuration file
 */
export async function createExampleConfig(outputPath) {
  const example = {
    configVersion: CONFIG_VERSION,
    packageId: 'de.basisprofil.r4',
    packageVersion: '1.5.0',
    enableGoFSH: true,
    resourcesDir: 'Resources',
    resourcesR6Dir: 'ResourcesR6',
    compareDir: 'compare',
    outputDir: 'output',
    rulesConfigPath: null,
    validatorJarPath: null,
    workdir: null,
    compareMode: 'incremental',
    exportZip: true,
    skipTerminologyReport: false,
    skipSearchParameterReport: false
  };
  
  await fsp.writeFile(
    outputPath,
    JSON.stringify(example, null, 2),
    'utf8'
  );
}

/**
 * Loads the default rules configuration
 */
export async function loadDefaultRules() {
  const rulesPath = path.join(__dirname, '..', 'config', 'default-rules.json');
  const raw = await fsp.readFile(rulesPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Loads rules from a custom path or falls back to default
 */
export async function loadRules(customPath) {
  if (customPath && await pathExists(customPath)) {
    const raw = await fsp.readFile(customPath, 'utf8');
    return JSON.parse(raw);
  }
  return loadDefaultRules();
}
