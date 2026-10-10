import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const args = process.argv.slice(2), index = args.indexOf("--host");
const host = resolve(index >= 0 ? args[index + 1] : process.env.MODERA_HOST_WORKSPACE ?? "../../modera");
const { startPluginDev } = await import(pathToFileURL(resolve(host, "modera-app/core/packages/plugin-build/dist/dev.mjs")));
await startPluginDev(process.cwd(), host);
