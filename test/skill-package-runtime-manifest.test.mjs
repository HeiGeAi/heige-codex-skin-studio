import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../scripts/skill-package-manifest.json", import.meta.url);
const sourceUrl = new URL("../src/", import.meta.url);

test("skill package explicitly allowlists every runtime source module", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const sourceEntries = manifest.entries.filter(({ source }) => (
    source === "src" || source.startsWith("src/")
  ));
  const directoryEntries = await readdir(sourceUrl, { withFileTypes: true });

  assert.equal(
    directoryEntries.every((entry) => entry.isFile()),
    true,
    "src must remain a flat runtime module directory or the allowlist test must be extended",
  );

  const expected = directoryEntries
    .map(({ name }) => ({
      source: `src/${name}`,
      destination: `payload/src/${name}`,
      recursive: false,
      exclude: [],
    }))
    .sort((left, right) => left.source.localeCompare(right.source));

  assert.deepEqual(sourceEntries, expected);
});

test("skill package carries the macOS launcher icon and recursive launcher scripts", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.deepEqual(
    manifest.entries.find(({ source }) => source === "assets/launcher"),
    {
      source: "assets/launcher",
      destination: "payload/assets/launcher",
      recursive: true,
      exclude: [],
    },
  );
  assert.deepEqual(
    manifest.entries.find(({ source }) => source === "scripts"),
    {
      source: "scripts",
      destination: "payload/scripts",
      recursive: true,
      exclude: [
        "check-asset-provenance.mjs",
        "package-skill.command",
        "package-skill.mjs",
        "skill-package-manifest.json",
        "sync-llms.mjs",
        "update-release-hash.mjs",
      ],
    },
  );
});
