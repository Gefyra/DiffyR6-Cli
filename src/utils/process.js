import { spawn } from 'child_process';

/**
 * Spawns a process and collects or streams output
 */
export function spawnProcess(command, args, cwd, options = {}) {
  const { rejectOnNonZero = false, stream = false, stdio } = options;
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd,
      shell: process.platform === 'win32',
      env: process.env,
    };
    if (stdio) {
      spawnOptions.stdio = stdio;
    } else if (stream) {
      spawnOptions.stdio = 'inherit';
    }

    const child = spawn(command, args, spawnOptions);

    let stdout = '';
    let stderr = '';

    const collectOutput = !spawnOptions.stdio;
    if (collectOutput && child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }
    if (collectOutput && child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }
    child.on('error', (error) => {
      reject(
        new Error(`${command} could not be started: ${error.message}`)
      );
    });
    child.on('close', (code) => {
      const exitCode = code ?? 0;
      if (rejectOnNonZero && exitCode !== 0) {
        const msg = collectOutput
          ? `${command} failed (exit code ${exitCode}). Details:\n${stdout}\n${stderr}`
          : `${command} failed (exit code ${exitCode}).`;
        reject(new Error(msg));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Creates a simple terminal spinner with configurable frames
 */
export function createAnimator(label, options = {}) {
  const frames =
    options.frames ||
    [
      '🐟     ~~~~~',
      ' 🐟    ~~~~~',
      '  🐟   ~~~~~',
      '   🐟  ~~~~~',
      '    🐟 ~~~~~',
      '   🐟  ~~~~~',
      '  🐟   ~~~~~',
      ' 🐟    ~~~~~',
    ];
  const interval = options.interval || 150;
  let index = 0;
  let timer = null;

  function render() {
    const frame = frames[index];
    index = (index + 1) % frames.length;
    const text = `${frame} ${label}`;
    process.stdout.write(`\r${text}`);
  }

  return {
    start() {
      if (timer) {
        return;
      }
      render();
      timer = setInterval(render, interval);
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
      process.stdout.write('\r');
      const blank = ' '.repeat(process.stdout.columns || 40);
      process.stdout.write(`${blank}\r`);
    },
  };
}
