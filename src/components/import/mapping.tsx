"use client";

import { IMPORT_FIELDS, IMPORT_FIELD_LABELS, type ColumnMapping, type ImportField } from "@/lib/import/columns";

/** One select per lead field: which column of the file holds it. */
export function MappingRow({ headers, mapping, disabled, onChange }: { headers: string[]; mapping: ColumnMapping; disabled?: boolean; onChange: (field: ImportField, column: number | null) => void }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-3.5 sm:grid-cols-3 lg:grid-cols-5">
      {IMPORT_FIELDS.map((field) => {
        const id = `map-${field}`;
        const value = mapping[field];
        return (
          <div key={field} className="min-w-0">
            <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium">
              {IMPORT_FIELD_LABELS[field]}
            </label>
            <select
              id={id}
              className="field truncate"
              value={value === null ? "" : String(value)}
              disabled={disabled}
              onChange={(e) => onChange(field, e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">Not in this file</option>
              {headers.map((h, i) => (
                <option key={i} value={i}>
                  {h || `Column ${i + 1}`}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
