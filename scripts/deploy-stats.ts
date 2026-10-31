import { deploy } from "./deploy-site.ts";

deploy("stats", process.argv.slice(2));
