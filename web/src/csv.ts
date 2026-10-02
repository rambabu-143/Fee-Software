// Rows -> CSV file download. Quotes every cell so commas/quotes in names are safe.
export function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = `${name}.csv`
  a.click()
}
