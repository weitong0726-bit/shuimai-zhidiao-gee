import { spawn } from 'node:child_process';
import process from 'node:process';

const commands = [
  spawn('.venv-gee/bin/python', ['tools/gee_bridge.py'], { stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'vinext', 'dev'], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  commands.forEach((child) => child.kill('SIGTERM'));
  setTimeout(() => process.exit(code), 250).unref();
}

commands.forEach((child) => {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping && code !== 0 && signal !== 'SIGTERM') stop(code || 1);
  });
});

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
