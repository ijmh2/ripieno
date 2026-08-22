const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(extensionRoot, "../..");
const manifest = require("../package.json");
const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));

const readExtension = (name) => fs.readFileSync(path.join(extensionRoot, name), "utf8");
const readRoot = (name) => fs.readFileSync(path.join(repositoryRoot, name), "utf8");

describe("Preview release metadata", () => {
  test("the manifest describes an honest free Preview", () => {
    assert.equal(manifest.preview, true);
    assert.match(manifest.version, /^0\.0\./);
    assert.equal(manifest.pricing, "Free");
    for (const url of [manifest.homepage, manifest.repository?.url, manifest.bugs?.url]) {
      assert.match(url ?? "", /^https:\/\//);
    }
    assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
    assert.equal(manifest.capabilities?.virtualWorkspaces?.supported, false);
  });

  test("every required Marketplace asset exists and the icon is large enough", () => {
    for (const file of ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "media/icon.png"]) {
      assert.equal(fs.existsSync(path.join(extensionRoot, file)), true, file);
    }
    const png = fs.readFileSync(path.join(extensionRoot, "media/icon.png"));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.readUInt32BE(16) >= 128, "icon width must be at least 128px");
    assert.ok(png.readUInt32BE(20) >= 128, "icon height must be at least 128px");
  });

  test("release prose names the Preview and all bundled runtime packages", () => {
    const changelog = readExtension("CHANGELOG.md");
    assert.match(changelog, new RegExp(`## ${manifest.version}.*Preview`, "s"));
    const notices = readExtension("THIRD_PARTY_NOTICES.md");
    const expectedDependencies = [
      "@modelcontextprotocol/sdk",
      "ajv",
      "ajv-formats",
      "fast-deep-equal",
      "fast-uri",
      "json-schema-traverse",
      "ws",
      "zod",
      "zod-to-json-schema",
    ];
    const noticeEntries = new Map(
      [...notices.matchAll(/^\| `([^`]+)` \| ([^|]+?) \| ([^|]+?) \|$/gm)].map((match) => [
        match[1],
        { version: match[2].trim(), license: match[3].trim() },
      ])
    );
    assert.deepEqual([...noticeEntries.keys()].sort(), [...expectedDependencies].sort());
    for (const dependency of expectedDependencies) {
      const installed = lock.packages[`node_modules/${dependency}`];
      assert.deepEqual(noticeEntries.get(dependency), {
        version: installed?.version,
        license: installed?.license,
      });
    }
    const metafile = JSON.parse(readExtension("dist/esbuild-meta.json"));
    const bundledPackages = new Set();
    for (const input of Object.keys(metafile.inputs ?? {})) {
      const normalized = input.replaceAll("\\", "/");
      const match = normalized.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if (match) bundledPackages.add(match[1]);
    }
    assert.deepEqual([...bundledPackages].sort(), [...expectedDependencies].sort());
    const marketplaceReadme = readExtension("README.md");
    for (const document of ["SECURITY.md", "PRIVACY.md", "SUPPORT.md"]) {
      assert.match(marketplaceReadme, new RegExp(`https://github\\.com/ijmh2/ripieno/[^) ]*${document}`));
    }
  });

  test("repository release documents exist without brittle fixed test totals", () => {
    for (const file of ["SECURITY.md", "SUPPORT.md", "PRIVACY.md", "docs/mcp.md"]) {
      assert.equal(fs.existsSync(path.join(repositoryRoot, file)), true, file);
    }
    assert.doesNotMatch(readRoot("README.md"), /\b(?:400|413) tests\b/);
  });

  test("Marketplace settings and the declared API floor cannot drift from the manifest", () => {
    const marketplaceReadme = readExtension("README.md");
    const documentedSettings = [
      ...marketplaceReadme.matchAll(/^\| `(ripieno\.[^`]+)` \|/gm),
    ].map((match) => match[1]);
    const configuredSettings = manifest.contributes?.configuration?.properties ?? {};
    assert.ok(documentedSettings.length > 0);
    for (const setting of documentedSettings) {
      assert.ok(setting in configuredSettings, `${setting} must exist in contributes.configuration`);
    }
    assert.equal(manifest.devDependencies?.["@types/vscode"], "1.85.0");
  });

  test("package and publish commands cannot traverse workspace dependencies", () => {
    assert.match(manifest.scripts.package, /\bvsce package\b.*--no-dependencies/);
    assert.match(manifest.scripts["publish:marketplace"], /\bvsce publish\b.*--no-dependencies/);
    const ignored = readExtension(".vscodeignore");
    assert.match(ignored, /^src\/\*\*/m);
    assert.match(ignored, /^test\/\*\*/m);
    assert.match(ignored, /^node_modules\/\*\*/m);
    for (const asset of ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "media/icon.png"]) {
      assert.equal(ignored.includes(asset), false, `${asset} must be packaged`);
    }
    assert.doesNotMatch(ignored, /^\*\*\/\*\.md$/m);
    const workflow = readRoot(".github/workflows/release-artifact.yml");
    assert.match(workflow, /vsce ls --no-dependencies.*vsix-files\.txt/s);
    for (const asset of ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "media/icon.png"]) {
      assert.match(workflow, new RegExp(asset.replace(".", "\\.")));
    }
    assert.match(workflow, /npm run package/);
    assert.match(workflow, /test:extension-host/);
    assert.match(workflow, /sha256sum dist\/\*\.vsix/);
  });
});
