// Recreates the dev database from the seed: npm run db:reset
import { resetDevStore } from "../store/dev.js";

console.log(`Seeded ${resetDevStore()}`);
