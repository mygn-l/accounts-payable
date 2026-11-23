// The business date the app runs on: AS_OF_DATE (the dataset's as-of date, see asOfDate.ts), otherwise the server's date.
export const today = () => process.env.AS_OF_DATE || new Date().toLocaleDateString("en-CA");

// Whole days from one date (YYYY-MM-DD) to another; negative when the second is earlier.
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
