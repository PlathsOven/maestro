import fs from 'fs';
import path from 'path';
import { writeRepoSettings } from './settingsToml';

export type TemplateId = 'empty' | 'next' | 'vite';

// Quick-start templates are written directly (no network) so project creation
// is instant; the setup script installs dependencies inside each workspace.

function write(dir: string, file: string, content: string) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function writeTemplate(dir: string, template: TemplateId, name: string) {
  if (template === 'next') return writeNext(dir, name);
  if (template === 'vite') return writeVite(dir, name);
  return writeEmpty(dir, name);
}

function writeEmpty(dir: string, name: string) {
  write(dir, 'README.md', `# ${name}\n\nCreated with Maestro quick start.\n`);
  write(dir, '.gitignore', 'node_modules/\n.DS_Store\n');
}

function writeNext(dir: string, name: string) {
  write(
    dir,
    'package.json',
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: 'latest', react: 'latest', 'react-dom': 'latest' },
        devDependencies: {
          typescript: 'latest',
          '@types/node': 'latest',
          '@types/react': 'latest',
          '@types/react-dom': 'latest',
          tailwindcss: 'latest',
          '@tailwindcss/postcss': 'latest',
        },
      },
      null,
      2
    ) + '\n'
  );
  write(
    dir,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2
    ) + '\n'
  );
  write(dir, 'next.config.ts', `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`);
  write(dir, 'postcss.config.mjs', `const config = { plugins: ['@tailwindcss/postcss'] };\n\nexport default config;\n`);
  write(dir, 'app/globals.css', `@import 'tailwindcss';\n`);
  write(
    dir,
    'app/layout.tsx',
    `import './globals.css';\n\nexport const metadata = { title: '${name}', description: 'Created with Maestro' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`
  );
  write(
    dir,
    'app/page.tsx',
    `export default function Home() {\n  return (\n    <main className="flex min-h-screen items-center justify-center">\n      <h1 className="text-3xl font-semibold">${name}</h1>\n    </main>\n  );\n}\n`
  );
  write(dir, '.gitignore', 'node_modules/\n.next/\nout/\n.DS_Store\n*.tsbuildinfo\nnext-env.d.ts\n.env*.local\n');
  write(dir, 'README.md', `# ${name}\n\nNext.js (TypeScript, Tailwind, App Router) — created with Maestro quick start.\n`);
  writeRepoSettings(dir, {
    setupScript: 'npm install',
    runScript: 'npm run dev -- --port $WORKSPACE_PORT',
    instructions: '',
  });
}

function writeVite(dir: string, name: string) {
  write(
    dir,
    'package.json',
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
        dependencies: { react: 'latest', 'react-dom': 'latest' },
        devDependencies: {
          vite: 'latest',
          '@vitejs/plugin-react': 'latest',
          typescript: 'latest',
          '@types/react': 'latest',
          '@types/react-dom': 'latest',
        },
      },
      null,
      2
    ) + '\n'
  );
  write(
    dir,
    'index.html',
    `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`
  );
  write(
    dir,
    'src/main.tsx',
    `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n`
  );
  write(
    dir,
    'src/App.tsx',
    `export default function App() {\n  return <h1>${name}</h1>;\n}\n`
  );
  write(
    dir,
    'vite.config.ts',
    `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`
  );
  write(
    dir,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
        },
        include: ['src'],
      },
      null,
      2
    ) + '\n'
  );
  write(dir, '.gitignore', 'node_modules/\ndist/\n.DS_Store\n');
  write(dir, 'README.md', `# ${name}\n\nVite + React + TypeScript — created with Maestro quick start.\n`);
  writeRepoSettings(dir, {
    setupScript: 'npm install',
    runScript: 'npm run dev -- --port $WORKSPACE_PORT --strictPort',
    instructions: '',
  });
}
