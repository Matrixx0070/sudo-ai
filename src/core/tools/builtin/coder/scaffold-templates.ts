/**
 * Project scaffold templates for coder.scaffold.
 * Each template returns a map of relative path -> file content.
 */

export type ScaffoldTemplate =
  | 'node-api'
  | 'react-app'
  | 'electron-app'
  | 'express-api'
  | 'next-app'
  | 'cli-tool';

export interface ScaffoldFile {
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function tsConfig(options: { jsx?: boolean } = {}): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
        declaration: true,
        sourceMap: true,
        ...(options.jsx ? { jsx: 'react-jsx' } : {}),
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  );
}

function gitignore(): string {
  return 'node_modules/\ndist/\n.env\n*.log\n.DS_Store\n';
}

function envExample(vars: string[]): string {
  return vars.map((v) => `${v}=`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// node-api
// ---------------------------------------------------------------------------

function nodeApiFiles(name: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name, version: '0.1.0', type: 'module', main: 'dist/index.js',
        scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'tsx src/index.ts' },
        dependencies: {}, devDependencies: { typescript: '^5', tsx: '^4', '@types/node': '^20' } }, null, 2),
    },
    { path: 'tsconfig.json', content: tsConfig() },
    { path: '.gitignore', content: gitignore() },
    { path: '.env.example', content: envExample(['PORT', 'LOG_LEVEL']) },
    { path: 'src/index.ts', content: `import { createServer } from 'node:http';\n\nconst PORT = Number(process.env['PORT'] ?? 3000);\n\nconst server = createServer((_req, res) => {\n  res.writeHead(200, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify({ status: 'ok', name: '${name}' }));\n});\n\nserver.listen(PORT, () => {\n  console.log(\`${name} listening on :$\{PORT\}\`);\n});\n` },
  ];
}

// ---------------------------------------------------------------------------
// express-api
// ---------------------------------------------------------------------------

function expressApiFiles(name: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name, version: '0.1.0', type: 'module', main: 'dist/index.js',
        scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'tsx src/index.ts' },
        dependencies: { express: '^4' }, devDependencies: { typescript: '^5', tsx: '^4', '@types/node': '^20', '@types/express': '^4' } }, null, 2),
    },
    { path: 'tsconfig.json', content: tsConfig() },
    { path: '.gitignore', content: gitignore() },
    { path: '.env.example', content: envExample(['PORT', 'LOG_LEVEL']) },
    { path: 'src/index.ts', content: `import express from 'express';\n\nconst app = express();\napp.use(express.json());\n\napp.get('/health', (_req, res) => {\n  res.json({ status: 'ok', name: '${name}' });\n});\n\nconst PORT = Number(process.env['PORT'] ?? 3000);\napp.listen(PORT, () => console.log(\`${name} on :$\{PORT\}\`));\n` },
    { path: 'src/routes/index.ts', content: `import { Router } from 'express';\n\nexport const router = Router();\n\nrouter.get('/', (_req, res) => {\n  res.json({ message: 'Hello from ${name}' });\n});\n` },
  ];
}

// ---------------------------------------------------------------------------
// react-app
// ---------------------------------------------------------------------------

function reactAppFiles(name: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name, version: '0.1.0', type: 'module', private: true,
        scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' },
        dependencies: { react: '^18', 'react-dom': '^18' },
        devDependencies: { vite: '^5', '@vitejs/plugin-react': '^4', typescript: '^5', '@types/react': '^18', '@types/react-dom': '^18' } }, null, 2),
    },
    { path: 'tsconfig.json', content: tsConfig({ jsx: true }) },
    { path: 'vite.config.ts', content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n` },
    { path: '.gitignore', content: gitignore() },
    { path: 'index.html', content: `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"/><title>${name}</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n` },
    { path: 'src/main.tsx', content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App.js';\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n` },
    { path: 'src/App.tsx', content: `export default function App() {\n  return <h1>Hello from ${name}</h1>;\n}\n` },
  ];
}

// ---------------------------------------------------------------------------
// next-app
// ---------------------------------------------------------------------------

function nextAppFiles(name: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name, version: '0.1.0', private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: '^14', react: '^18', 'react-dom': '^18' },
        devDependencies: { typescript: '^5', '@types/node': '^20', '@types/react': '^18', '@types/react-dom': '^18' } }, null, 2),
    },
    { path: 'tsconfig.json', content: tsConfig({ jsx: true }) },
    { path: '.gitignore', content: gitignore() + '.next/\n' },
    { path: 'src/app/page.tsx', content: `export default function Home() {\n  return <main><h1>${name}</h1></main>;\n}\n` },
    { path: 'src/app/layout.tsx', content: `export const metadata = { title: '${name}' };\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n` },
  ];
}

// ---------------------------------------------------------------------------
// electron-app
// ---------------------------------------------------------------------------

function electronAppFiles(name: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name, version: '0.1.0', type: 'module', main: 'dist/main.js',
        scripts: { build: 'tsc', dev: 'electron .', start: 'electron .' },
        dependencies: { electron: '^28' }, devDependencies: { typescript: '^5', '@types/node': '^20' } }, null, 2),
    },
    { path: 'tsconfig.json', content: tsConfig() },
    { path: '.gitignore', content: gitignore() },
    { path: 'src/main.ts', content: `import { app, BrowserWindow } from 'electron';\nimport { join } from 'node:path';\n\nfunction createWindow() {\n  const win = new BrowserWindow({ width: 1200, height: 800,\n    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: join(import.meta.dirname, 'preload.js') } });\n  win.loadFile('index.html');\n}\n\napp.whenReady().then(createWindow);\napp.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });\n` },
    { path: 'src/preload.ts', content: `import { contextBridge } from 'electron';\ncontextBridge.exposeInMainWorld('api', { version: () => process.versions.electron });\n` },
    { path: 'index.html', content: `<!DOCTYPE html>\n<html><head><title>${name}</title></head>\n<body><h1>${name}</h1></body></html>\n` },
  ];
}

// ---------------------------------------------------------------------------
// cli-tool
// ---------------------------------------------------------------------------

function cliToolFiles(name: string): ScaffoldFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name, version: '0.1.0', type: 'module', bin: { [name]: 'dist/cli.js' },
        scripts: { build: 'tsc', start: 'tsx src/cli.ts' },
        dependencies: {}, devDependencies: { typescript: '^5', tsx: '^4', '@types/node': '^20' } }, null, 2),
    },
    { path: 'tsconfig.json', content: tsConfig() },
    { path: '.gitignore', content: gitignore() },
    { path: 'src/cli.ts', content: `#!/usr/bin/env node\n\nconst [, , ...args] = process.argv;\n\nif (args[0] === '--help' || args[0] === '-h') {\n  console.log('Usage: ${name} [options]');\n  process.exit(0);\n}\n\nconsole.log('${name} running with args:', args);\n` },
  ];
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function getTemplateFiles(template: ScaffoldTemplate, name: string): ScaffoldFile[] {
  switch (template) {
    case 'node-api':     return nodeApiFiles(name);
    case 'express-api':  return expressApiFiles(name);
    case 'react-app':    return reactAppFiles(name);
    case 'next-app':     return nextAppFiles(name);
    case 'electron-app': return electronAppFiles(name);
    case 'cli-tool':     return cliToolFiles(name);
    default:
      throw new Error(`Unknown template: ${template as string}`);
  }
}
