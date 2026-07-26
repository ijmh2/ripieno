const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    // permissionServer is spawned by Claude Code as its own process, so it
    // needs its own bundle rather than being part of the extension.
    entryPoints: ["src/extension.ts", "src/permissionServer.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outdir: "dist",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
    console.log("[esbuild] watching…");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
