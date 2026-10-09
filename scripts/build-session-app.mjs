import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const candidate = String(process.env.AGENT_PLATFORM_CANDIDATE || "").trim();

const platformRoot = candidate ? path.resolve(candidate) : null;
let platformPaths;
try {
  platformPaths = platformRoot ? {
    host: path.join(platformRoot, "src", "session-host.js"),
    ui: path.join(platformRoot, "src", "ui", "index.jsx"),
    styles: path.join(platformRoot, "src", "ui", "styles.css"),
    references: path.join(platformRoot, "src", "session-references.js"),
  } : {
    host: require.resolve('@agent-workbench/platform/session-host'),
    ui: require.resolve('@agent-workbench/platform/ui'),
    styles: require.resolve('@agent-workbench/platform/styles.css'),
    references: require.resolve('@agent-workbench/platform/session-references'),
  };
  await Promise.all(Object.values(platformPaths).map(file => access(file)));
} catch (error) {
  throw new Error('The installed Platform must export Session Host (v0.33.0+), or set AGENT_PLATFORM_CANDIDATE to the candidate worktree.', { cause: error });
}

const outputDirectory = path.join(repositoryRoot, "public", "generated");
await mkdir(outputDirectory, { recursive: true });

const platformAlias = {
  name: "platform-candidate",
  setup(buildContext) {
    // Candidate worktrees have their own peers. All UI dependencies must use the consumer's renderer.
    buildContext.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/session-host$/ }, () => ({
      path: platformPaths.host,
    }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/session-references$/ }, () => ({ path: platformPaths.references }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/ui$/ }, () => ({
      path: platformPaths.ui,
    }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/styles\.css$/ }, () => ({
      path: platformPaths.styles,
    }));
    // Agent Web opts in; the shared Platform's default and SSR entry stay synchronous.
    buildContext.onResolve({ filter: /^\.\/markdown\.jsx$/ }, (args) => args.importer === platformPaths.ui ? ({
      path: path.join(path.dirname(platformPaths.ui), 'markdown-lazy.jsx'),
    }) : undefined);
  },
};

const result = await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ["public/platform-agent-web-entry.jsx"],
  outdir: outputDirectory,
  entryNames: "session-app-[hash]",
  chunkNames: "chunk-[hash]",
  assetNames: "[name]-[hash]",
  bundle: true,
  minify: true,
  format: "esm",
  splitting: true,
  sourcemap: false,
  target: ["es2022"],
  jsx: "automatic",
  loader: { ".css": "css", ".woff": "file", ".woff2": "file", ".ttf": "file" },
  plugins: [platformAlias],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
  metafile: true,
  write: false,
});

// Keep the preceding content-addressed chunks usable by already-open tabs.
// Activate HTML only after every asset of this build is safely available.
async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}
for (const file of result.outputFiles) await atomicWrite(file.path, file.contents);
const entry = Object.entries(result.metafile.outputs).find(([file, info]) => file.endsWith('.js') && info.entryPoint === 'public/platform-agent-web-entry.jsx');
if (!entry?.[1].cssBundle) throw new Error('Session entry or stylesheet missing from build output.');
const chunkFor = (source) => Object.entries(result.metafile.outputs).find(([file, info]) => file.endsWith('.js') && info.entryPoint?.endsWith(`/src/ui/${source}`))?.[0];
const markdown = chunkFor('markdown-renderer-lazy.jsx'), math = chunkFor('markdown-math.jsx');
if (!markdown || !math) throw new Error('Lazy Markdown chunks missing from build output.');
const manifest = { js: `/generated/${path.basename(entry[0])}`, css: `/generated/${path.basename(entry[1].cssBundle)}`,
  markdown: `/generated/${path.basename(markdown)}`, math: `/generated/${path.basename(math)}` };
const template = await readFile(path.join(repositoryRoot, 'public/index.html'), 'utf8');
const html = template.replaceAll('__SESSION_APP_JS__', manifest.js).replaceAll('__SESSION_APP_CSS__', manifest.css);
await atomicWrite(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest));
await atomicWrite(path.join(outputDirectory, 'index.html'), html);
process.stdout.write(`Session assets: ${manifest.js}, ${manifest.css}\n`);
