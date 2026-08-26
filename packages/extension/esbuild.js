const esbuild = require("esbuild");
const fs = require("node:fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    // permissionServer is spawned by Claude Code as its own process, so it
    // needs its own bundle rather than being part of the extension.
    // workspaceFs is also emitted on its own so its cache and parsing logic can
    // be unit-tested outside the editor; the bundle imports it either way.
    // agentHost is emitted separately so the turn it builds can be tested
    // against a real relay and a real subprocess, rather than by opening two
    // editor windows and reading the output channel.
    entryPoints: ["src/extension.ts", "src/permissionServer.ts", "src/workspaceFs.ts", "src/workspaceServer.ts", "src/addressing.ts", "src/soloRelay.ts", "src/invite.ts", "src/relaySecurity.ts", "src/agentHost.ts", "src/runners.ts", "src/approvalScope.ts", "src/approvalSummary.ts", "src/roomViewMessages.ts", "src/agentSetup.ts", "src/agentCommands.ts", "src/goalCommands.ts", "src/goalState.ts", "src/goalMutations.ts", "src/contextMutations.ts", "src/handoffCommands.ts", "src/handoffState.ts", "src/sessionScope.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outdir: "dist",
    // vscode is provided by the host. The Anthropic SDK is only reachable from
    // the relay's hosted mode, which an in-extension relay never uses — leaving
    // it external keeps several megabytes of unused SDK out of the .vsix, and
    // the import that would load it is dynamic and never taken.
    external: ["vscode", "@anthropic-ai/sdk"],
    sourcemap: !production,
    minify: production,
    metafile: true,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
    console.log("[esbuild] watching…");
  } else {
    const result = await ctx.rebuild();
    fs.writeFileSync("dist/esbuild-meta.json", JSON.stringify(result.metafile));
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
