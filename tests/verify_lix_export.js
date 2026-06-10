const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const popupSource = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const prefix = popupSource.slice(0, popupSource.indexOf("function pingBackground()"));
const context = {
  console,
  TextEncoder,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  window: { addEventListener() {} },
  chrome: { runtime: { lastError: null } },
  result: null
};

vm.runInNewContext(
  prefix + "\nresult = { COLUMNS };",
  context
);

const leads = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/leads.json"), "utf8"));
const expected = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/expected_lix_row.json"), "utf8"));

const expectedHeaders = Object.keys(expected);
const actualHeaders = context.result.COLUMNS.map(([, header]) => header);
if (JSON.stringify(actualHeaders) !== JSON.stringify(expectedHeaders)) {
  throw new Error(`LIX headers mismatch:\n${actualHeaders.join("|")}\n${expectedHeaders.join("|")}`);
}

const [lead] = leads;
const actual = Object.fromEntries(context.result.COLUMNS.map(([key, header]) => [header, lead[key] || ""]));

for (const header of expectedHeaders) {
  if (actual[header] !== expected[header]) {
    throw new Error(`Mismatch for ${header}: expected ${JSON.stringify(expected[header])}, got ${JSON.stringify(actual[header])}`);
  }
}

console.log("LIX fixture export verification passed.");
