import { spawn } from 'child_process';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { jsonrpc, method, params, id } = req.body;

  return new Promise((resolve) => {
    const mcp = spawn('node', ['dist/index.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    mcp.stdout.on('data', (data) => {
      output += data.toString();
    });

    mcp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    mcp.on('close', (code) => {
      if (code !== 0 && errorOutput) {
        return resolve(res.status(500).json({ error: errorOutput }));
      }

      try {
        // Parse the last complete JSON line from output
        const lines = output.split('\n').filter(line => line.trim());
        const lastLine = lines[lines.length - 1];
        const result = JSON.parse(lastLine);
        resolve(res.status(200).json(result));
      } catch (e) {
        resolve(res.status(500).json({ error: 'Failed to parse MCP response', output }));
      }
    });

    // Send the request to the MCP server
    mcp.stdin.write(JSON.stringify({ jsonrpc, method, params, id }) + '\n');
    mcp.stdin.end();

    // Timeout after 25 seconds (Vercel limit is 30s for free tier)
    setTimeout(() => {
      mcp.kill();
      resolve(res.status(504).json({ error: 'Request timeout' }));
    }, 25000);
  });
}
