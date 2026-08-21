import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const singleReactInstancePlugin = {
  name: "single-react-instance",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({
      path: require.resolve(path),
    }));
    buildContext.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, ({ path }) => ({
      path: require.resolve(path),
    }));
  },
};

const sessionListStylesPlugin = {
  name: "session-list-styles",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^katex\/dist\/katex\.min\.css$/ }, () => ({
      path: "katex-list-unused.css",
      namespace: "session-list-empty-style",
    }));
    buildContext.onLoad({ filter: /.*/, namespace: "session-list-empty-style" }, () => ({
      contents: "",
      loader: "css",
    }));
  },
};

await build({
  entryPoints: { "session-list-core": "src/session-list-entry.jsx" },
  bundle: true,
  format: "iife",
  outdir: "public",
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  loader: {
    ".ttf": "file",
    ".woff": "file",
    ".woff2": "file",
  },
  plugins: [singleReactInstancePlugin, sessionListStylesPlugin],
  logLevel: "info",
});
