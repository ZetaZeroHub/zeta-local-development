// Fixed public release: MCP configuration can rehydrate after npm clears its cache.
export const releasePackage = 'https://github.com/kinglegendzzh/zeta-local-development/releases/download/v0.2.0/zeta-studio-local-development-0.2.0.tgz';
export function launcher(profile) {
  return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['--yes', '--package=' + releasePackage, 'zeta-dev', 'mcp', '--profile', profile] };
}
