import { existsSync, readFileSync } from "fs";
import path from "path";

// The app's "today" is the dataset's as-of date, read from its README ("**As-of date:** YYYY-MM-DD"), so a new dataset brings
// its own date. AS_OF_DATE, when set, wins; without either, the real date is used.
export function useDatasetDate(root: string) {
  if (process.env.AS_OF_DATE) return;
  const readme = path.resolve(root, process.env.DATASET_DIR ?? "brim_ap_dataset", "README.md");
  const date = existsSync(readme) ? readFileSync(readme, "utf8").match(/as-of date:?\**:?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] : undefined;
  if (date) process.env.AS_OF_DATE = date;
}
