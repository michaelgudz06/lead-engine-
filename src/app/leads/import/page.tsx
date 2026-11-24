import type { Metadata } from "next";
import { ImportFlow } from "@/components/import/import-flow";

export const metadata: Metadata = { title: "Import leads" };

/** /leads/import: add many leads from a CSV file, a Google Sheet or HubSpot. Never starts research. */
export default function ImportPage() {
  return <ImportFlow />;
}
