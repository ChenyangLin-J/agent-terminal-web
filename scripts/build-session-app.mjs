import { access, mkdir, rm } from "node:fs/promises";
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
  } : {
    host: require.resolve('@agent-workbench/platform/session-host'),
    ui: require.resolve('@agent-workbench/platform/ui'),
    styles: require.resolve('@agent-workbench/platform/styles.css'),
  };
  await Promise.all(Object.values(platformPaths).map(file => access(file)));
} catch (error) {
  throw new Error('The installed Platform must export Session Host (v0.33.0+), or set AGENT_PLATFORM_CANDIDATE to the candidate worktree.', { cause: error });
}

const outputDirectory = path.join(repositoryRoot, "public", "generated");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const platformAlias = {
  name: "platform-candidate",
  setup(buildContext) {
    // Candidate worktrees have their own peers. All UI dependencies must use the consumer's renderer.
    buildContext.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/session-host$/ }, () => ({
      path: platformPaths.host,
    }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/ui$/ }, () => ({
      path: platformPaths.ui,
    }));
    buildContext.onResolve({ filter: /^@agent-workbench\/platform\/styles\.css$/ }, () => ({
      path: platformPaths.styles,
    }));
  },
};

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ["public/platform-agent-web-entry.jsx"],
  outdir: outputDirectory,
  entryNames: "session-app",
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
});
