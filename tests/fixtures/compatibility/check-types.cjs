"use strict"
const path = require("node:path")
const ts = require("typescript")

const program = ts.createProgram(["consumer.ts"], {
  esModuleInterop: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: false,
  strict: true,
  target: ts.ScriptTarget.ESNext,
})
// Check the installed package declarations, including imports of Next APIs
// unavailable at the floor. Next's own private declarations have unrelated
// strict-check errors, so they aren't this consumer's contract.
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter(
    ({ file }) =>
      !file ||
      file.fileName.includes("/node_modules/next-with-text/") ||
      path.dirname(file.fileName) === process.cwd()
  )
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    })
  )
  process.exitCode = 1
}
