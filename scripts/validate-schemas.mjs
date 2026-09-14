import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

// Replaces ajv-cli: validate every schema's example, plus the delivery example
// against the customer-export schema. Formats are not validated, as before.
const pairs = readdirSync("schemas")
  .filter((name) => name.endsWith(".schema.json"))
  .map((name) => [path.join("schemas", name), path.join("schemas", "examples", name.replace(".schema.json", ".example.json"))]);
pairs.push(["schemas/customer-export.schema.json", "examples/delivery/customer-export.json"]);

let failed = false;
for (const [schemaPath, dataPath] of pairs) {
  const validate = new Ajv2020({ validateFormats: false }).compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (validate(JSON.parse(readFileSync(dataPath, "utf8")))) {
    console.log(`${dataPath} valid`);
  } else {
    failed = true;
    console.error(`${dataPath} invalid against ${schemaPath}\n${JSON.stringify(validate.errors, null, 2)}`);
  }
}
process.exitCode = failed ? 1 : 0;
