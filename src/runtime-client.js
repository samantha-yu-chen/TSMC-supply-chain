import { spawn } from 'node:child_process';
import { resolve, delimiter } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const runtimeRoot = resolve(process.env.HARNESS_RUNTIME_DIR || `${project}/../hybrid-harness-runtime`);

export function callRuntime(command, payload = {}, { stateDir = `${project}/storage` } = {}) {
  return new Promise((resolveCall, reject) => {
    const env = {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: [runtimeRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
    };
    const child = spawn(process.env.PYTHON_BIN || 'python3', ['-m', 'hybrid_harness.cli', '--project', project, '--state-dir', stateDir, command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 20_000) child.kill(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        try { return reject(new Error(JSON.parse(stderr).error)); } catch { return reject(new Error(stderr.trim() || `Runtime exited ${code}`)); }
      }
      try { resolveCall(JSON.parse(stdout)); } catch { reject(new Error('Runtime returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
