import fs from 'fs';
import fsp from 'fs/promises';

/**
 * Checks if a path exists (file or directory)
 */
export async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if a file exists and is actually a file
 */
export async function fileExists(targetPath) {
  try {
    const stat = await fsp.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Checks if a directory exists and is actually a directory
 */
export async function directoryExists(targetPath) {
  try {
    const stat = await fsp.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
