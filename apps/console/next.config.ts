import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  agentRules: false,
  outputFileTracingRoot: workspaceRoot,
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '26mb',
    },
    proxyClientMaxBodySize: '26mb',
  },
};

export default nextConfig;
