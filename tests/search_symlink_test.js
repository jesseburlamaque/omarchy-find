#!/usr/bin/env node
// Run with: node --test tests/search_symlink_test.js (requires fd)
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { test } = require("node:test")
const vm = require("node:vm")

const backend = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "FindBackend.js"), "utf8")
  .replace(/^\.pragma library\s*$/m, ""), backend)

for (const forDirs of [false, true]) {
  test(`search ${forDirs ? "directories" : "files"} without following Steam drive links`, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "omarchy-find-symlink-"))
    try {
      const home = path.join(fixture, "home")
      const outside = path.join(fixture, "outside")
      const drives = path.join(home, ".local/share/Steam/steamapps/compatdata/123/pfx/dosdevices")
      const project = path.join(home, "Projects", "needle-project")
      fs.mkdirSync(drives, { recursive: true })
      fs.mkdirSync(project, { recursive: true })
      fs.mkdirSync(path.join(outside, "needle-external"), { recursive: true })
      fs.writeFileSync(path.join(project, "needle.Rproj"), "")
      fs.writeFileSync(path.join(outside, "needle-external", "needle.Rproj"), "")
      // A bounded stand-in for Wine's z: -> /; never scan the real host root.
      fs.symlinkSync(outside, path.join(drives, "z:"))

      const argv = backend.buildArgv("needle", 0, forDirs, home)
      const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 5000 })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      const results = result.stdout.trim().split("\n").filter(Boolean)
        .map(p => p.replace(/\/$/, ""))
      assert.deepEqual(results, [forDirs ? project : path.join(project, "needle.Rproj")])
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
}
