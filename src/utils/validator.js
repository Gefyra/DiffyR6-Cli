import fsp from 'fs/promises';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileExists } from './fs.js';
import { createAnimator } from './process.js';

const VALIDATOR_DOWNLOAD_URL = 'https://github.com/hapifhir/org.hl7.fhir.core/releases/download/6.7.10/validator_cli.jar';
const DEFAULT_VALIDATOR_FILENAME = 'validator_cli.jar';

/**
 * Ensures the validator JAR exists, downloading it if necessary
 * @param {string|null} jarPath - Path to validator JAR or null for auto-download
 * @param {string} workdir - Working directory where to download the JAR
 * @returns {Promise<string>} Path to the validator JAR
 */
export async function ensureValidator(jarPath, workdir) {
  // If jarPath is explicitly provided, verify it exists
  if (jarPath) {
    const resolvedPath = path.isAbsolute(jarPath) ? jarPath : path.resolve(workdir, jarPath);
    if (await fileExists(resolvedPath)) {
      return resolvedPath;
    }
    throw new Error(`Validator JAR not found at specified path: ${resolvedPath}`);
  }

  // Auto-download: check default location in workdir
  const defaultPath = path.resolve(workdir, DEFAULT_VALIDATOR_FILENAME);
  if (await fileExists(defaultPath)) {
    console.log(`  Using existing validator: ${defaultPath}`);
    return defaultPath;
  }

  // Download validator
  console.log('  Validator not found, downloading latest version...');
  await downloadValidator(defaultPath);
  console.log(`  Downloaded validator to: ${defaultPath}`);
  return defaultPath;
}

/**
 * Downloads the validator JAR from GitHub releases
 */
async function downloadValidator(targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  
  const animator = createAnimator('Downloading HL7 FHIR Validator...');
  animator.start();
  
  try {
    await downloadFile(VALIDATOR_DOWNLOAD_URL, targetPath);
  } finally {
    animator.stop();
  }
}

/**
 * Downloads a file from a URL with redirect following
 */
async function downloadFile(url, targetPath, maxRedirects = 5) {
  if (maxRedirects <= 0) {
    throw new Error('Too many redirects while downloading validator');
  }

  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error('Redirect without location header'));
          return;
        }
        downloadFile(redirectUrl, targetPath, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      // Handle errors
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download validator: HTTP ${response.statusCode}`));
        return;
      }

      // Write to file
      const fileStream = fs.createWriteStream(targetPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        fsp.unlink(targetPath).catch(() => {});
        reject(err);
      });
    }).on('error', (err) => {
      reject(new Error(`Network error while downloading validator: ${err.message}`));
    });
  });
}
