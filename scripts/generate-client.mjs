import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import renderVisitor from "@codama/renderers-js";
import { createFromRoot } from "codama";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const anchorIdlPath = resolve(projectRoot, "target/idl/protected_pay.json");
const outputPath = resolve(projectRoot, "clients/ts");
const anchorIdl = JSON.parse(readFileSync(anchorIdlPath, "utf8"));

const codama = createFromRoot(rootNodeFromAnchor(anchorIdl));
codama.accept(renderVisitor(outputPath));
