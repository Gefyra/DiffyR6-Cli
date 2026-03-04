import https from 'https';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Gets the current package version from package.json
 */
function getCurrentVersion() {
  const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

/**
 * Fetches the latest version from NPM registry
 */
function getLatestVersion(packageName) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'registry.npmjs.org',
      port: 443,
      path: `/${packageName}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      timeout: 3000,
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const json = JSON.parse(data);
            resolve(json['dist-tags']?.latest || null);
          } else {
            resolve(null);
          }
        } catch (error) {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

/**
 * Compares two semantic versions
 * Returns true if newVersion is greater than currentVersion
 */
function isNewerVersion(currentVersion, newVersion) {
  if (!currentVersion || !newVersion) return false;
  
  const current = currentVersion.split('.').map(Number);
  const latest = newVersion.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    if (latest[i] > current[i]) return true;
    if (latest[i] < current[i]) return false;
  }
  
  return false;
}

/**
 * Creates a boxed update notification message
 */
function createUpdateNotification(currentVersion, latestVersion, packageName) {
  const lines = [
    '',
    '╔════════════════════════════════════════════════════════════════╗',
    '║                                                                ║',
    '║                   UPDATE AVAILABLE                            ║',
    '║                                                                ║',
    `║  Current version: ${currentVersion.padEnd(43)} ║`,
    `║  Latest version:  ${latestVersion.padEnd(43)} ║`,
    '║                                                                ║',
    '║  Run one of the following commands to update:                 ║',
    '║                                                                ║',
    `║  npm update -g ${packageName.padEnd(42)} ║`,
    `║  npm install -g ${packageName}@latest`.padEnd(65) + '║',
    '║                                                                ║',
    '╚════════════════════════════════════════════════════════════════╝',
    '',
  ];
  
  return lines.join('\n');
}

/**
 * Checks for updates and displays notification if available
 * This function is non-blocking and will not throw errors
 */
export async function checkForUpdates() {
  try {
    const packageName = '@gefyra/diffyr6-cli';
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion(packageName);
    
    if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
      const notification = createUpdateNotification(currentVersion, latestVersion, packageName);
      console.log(notification);
    }
  } catch (error) {
    // Silently fail - update check should never block the main functionality
  }
}
