import React, { useState } from 'react';

interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyField: string;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
}

type SortDir = 'asc' | 'desc';

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  keyField,
  emptyMessage = 'No data available.',
  onRowClick,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = sortKey
    ? [...data].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : data;

  return (
    <div
      style={{
        width: '100%',
        overflowX: 'auto',
        borderRadius: '8px',
        border: '1px solid #1f2937',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '13px',
          tableLayout: 'fixed',
        }}
        aria-label="Data table"
      >
        <thead>
          <tr
            style={{
              backgroundColor: '#0f1628',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}
          >
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={
                  sortKey === col.key
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : col.sortable
                      ? 'none'
                      : undefined
                }
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
                style={{
                  padding: '10px 14px',
                  textAlign: 'left',
                  fontWeight: 600,
                  color: 'var(--text-secondary, #9ca3af)',
                  borderBottom: '1px solid #1f2937',
                  cursor: col.sortable ? 'pointer' : 'default',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                  width: col.width,
                  transition: 'color 120ms ease',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    color:
                      sortKey === col.key
                        ? 'var(--accent, #3b82f6)'
                        : undefined,
                  }}
                >
                  {col.header}
                  {col.sortable && (
                    <span
                      aria-hidden="true"
                      style={{
                        fontSize: '10px',
                        opacity: sortKey === col.key ? 1 : 0.4,
                        lineHeight: 1,
                      }}
                    >
                      {sortKey === col.key
                        ? sortDir === 'asc'
                          ? '\u25b2'
                          : '\u25bc'
                        : '\u25b2\u25bc'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '32px 14px',
                  textAlign: 'center',
                  color: 'var(--text-secondary, #9ca3af)',
                  backgroundColor: '#111827',
                }}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map((row, rowIndex) => {
              const key = row[keyField] != null ? String(row[keyField]) : rowIndex;
              const isEven = rowIndex % 2 === 0;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  style={{
                    backgroundColor: isEven ? '#111827' : '#0f1628',
                    cursor: onRowClick ? 'pointer' : 'default',
                    transition: 'background-color 100ms ease',
                  }}
                  onMouseEnter={(e) => {
                    if (onRowClick)
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        '#1a2236';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.backgroundColor =
                      isEven ? '#111827' : '#0f1628';
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '10px 14px',
                        color: 'var(--text-primary, #f9fafb)',
                        borderBottom: '1px solid #1f2937',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {col.render
                        ? col.render(row)
                        : row[col.key] != null
                          ? String(row[col.key])
                          : '—'}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
