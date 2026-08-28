import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

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

const compactKatexStylesPlugin = {
  name: "compact-katex-styles",
  setup(buildContext) {
    buildContext.onLoad({ filter: /katex\.min\.css$/ }, async ({ path }) => ({
      contents: (await readFile(path, "utf8")).replace(
        /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g,
        "",
      ),
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
    ".ttf": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
  },
  plugins: [singleReactInstancePlugin, compactKatexStylesPlugin],
  logLevel: "info",
});
