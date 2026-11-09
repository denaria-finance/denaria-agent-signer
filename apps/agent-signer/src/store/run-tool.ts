import { spawn } from 'node:child_process';

/**
 * Runs one of the operating system's own tools (macOS `security`, Linux
 * `secret-tool`, Windows PowerShell), the secret on stdin and never in an
 * argument another user could list (agent-trading Stage 2 Q57). No shell:
 * the arguments reach the tool as given.
 */
export type ToolResult = { code: number | null; stdout: string; stderr: string };

export type ToolRunner = (
  file: string,
  argv: readonly string[],
  stdin: string,
) => Promise<ToolResult>;

export const runTool: ToolRunner = (file, argv, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...argv], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // A tool that exits before reading its stdin must not crash the Signer.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');
  });
