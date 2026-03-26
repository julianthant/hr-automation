import { runSeparation } from "./index.js";

const docId = process.argv[2] ?? "3508";
await runSeparation(docId, { keepOpen: true });
