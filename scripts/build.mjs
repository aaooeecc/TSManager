import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts', 'src/main/worker.ts', 'src/main/web.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron', 'node-pty', 'koffi'],
  outdir: 'build',
  outExtension: { '.js': '.cjs' },
})
