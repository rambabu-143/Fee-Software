import { Button, Card, Checkbox, DatePicker, Empty, Input, Select, Space, Table, message } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { api, downloadFile } from '../api'
import { useCan } from '../session'
import { useSelection } from '../selection'

type Opt = { value: string | number; label: string }
type Field = { key: string; label: string; kind: 'standard' | 'section' | 'date' | 'text' | 'select' | 'occupation' | 'subOccupation' | 'subject' | 'optHead' | 'switch'; options?: Opt[]; def?: string; required?: boolean }
type Report = { key: string; label: string; path: string; fields: Field[] }

const groupBy = (opts: Opt[], def: string): Field => ({ key: 'groupBy', label: 'Group by', kind: 'select', options: opts, def })
const cls: Field[] = [{ key: 'standardId', label: 'Class', kind: 'standard' }, { key: 'sectionId', label: 'Section', kind: 'section' }]
const range: Field[] = [{ key: 'from', label: 'From', kind: 'date' }, { key: 'to', label: 'To', kind: 'date' }]

const REPORTS: Report[] = [
  { key: 'siblings', label: 'Siblings', path: '/reports/siblings', fields: cls },
  { key: 'suggest', label: 'Sibling suggestions (admin)', path: '/reports/siblings/suggestions', fields: [] },
  { key: 'staff', label: 'Staff wards', path: '/reports/staff-wards', fields: [] },
  { key: 'minority', label: 'Minority', path: '/reports/minority', fields: [{ key: 'religion', label: 'Religion', kind: 'text', def: 'CHRISTIAN' }] },
  { key: 'nonindian', label: 'Non-Indian', path: '/reports/non-indian', fields: [] },
  { key: 'occupation', label: 'Occupation', path: '/reports/occupation', fields: [
    { key: 'occupationId', label: 'Occupation', kind: 'occupation' }, { key: 'subId', label: 'Sub-category', kind: 'subOccupation' }] },
  { key: 'subjects', label: 'Subjects', path: '/reports/subjects', fields: [
    { key: 'kind', label: 'Kind', kind: 'select', def: 'LANGUAGE', options: [{ value: 'LANGUAGE', label: 'Language' }, { value: 'ADDITIONAL', label: 'Additional' }] },
    { key: 'subjectId', label: 'Subject', kind: 'subject' }, ...cls] },
  { key: 'optin', label: 'Optional fee opt-ins', path: '/reports/fee-head-optin', fields: [{ key: 'feeHeadId', label: 'Fee head', kind: 'optHead', required: true }, ...cls] },
  { key: 'classwise', label: 'Classwise fees', path: '/reports/classwise', fields: [{ key: 'asOf', label: 'As of', kind: 'date' }, ...cls] },
  { key: 'studentwise', label: 'Studentwise fees', path: '/reports/studentwise', fields: [{ key: 'asOf', label: 'As of', kind: 'date' }, ...cls] },
  { key: 'bifurcation', label: 'Fee bifurcation', path: '/reports/bifurcation', fields: [
    groupBy([{ value: 'class', label: 'Class' }, { value: 'student', label: 'Student' }], 'class'),
    { key: 'admissionNo', label: 'Admission no.', kind: 'text' }, ...cls, ...range] },
  { key: 'tbif', label: 'Transport bifurcation', path: '/reports/transport-bifurcation', fields: [
    groupBy([{ value: 'class', label: 'Class' }, { value: 'student', label: 'Student' }], 'class'), ...cls] },
  { key: 'routes', label: 'Routes', path: '/reports/routes', fields: [] },
  { key: 'concessions', label: 'Concessions', path: '/reports/concessions', fields: [
    { key: 'summary', label: 'Class × category summary', kind: 'switch' }, { key: 'category', label: 'Category', kind: 'text' }, ...cls] },
  { key: 'paysum', label: 'Payments summary', path: '/reports/payments-summary', fields: [
    groupBy([{ value: 'mode', label: 'Payment mode' }, { value: 'head', label: 'Fee head' }], 'mode'), ...range] },
]

const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
// admissionNo -> "Admission No"; the map covers acronyms and names the generic split gets wrong.
const HEADERS: Record<string, string> = {
  className: 'Class', dob: 'DOB', penNo: 'PEN No', cbseRegNo: 'CBSE Reg No', aadhaar: 'Aadhaar', amountPerInstallment: 'Amount / Installment',
  concessionAmount: 'Concession (₹)', familyId: 'Family ID', staffBranch: 'Staff Branch', fullPaying: 'Full Paying',
}
const humanize = (k: string) => HEADERS[k] ?? k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/\bId\b/g, 'ID')
// Columns whose every filled value is a plain number, except codes that only look numeric (admission no, phone...).
const isNumeric = (key: string, rows: Record<string, unknown>[]) => {
  if (/(no|id|phone|mobile|aadhaar|pin|code)$/i.test(key)) return false
  const vals = rows.map((r) => r[key]).filter((v) => v !== '' && v != null)
  return vals.length > 0 && vals.every((v) => /^-?\d+(\.\d+)?$/.test(String(v)))
}
// 2-decimal strings are money from the API: show them Indian-grouped. Counts and other numbers stay as sent.
const money = (v: unknown) => (/^-?\d+\.\d{2}$/.test(String(v)) ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : cell(v))
const toOpts = <T extends { id: number }>(rows: T[], label: (r: T) => string): Opt[] => rows.map((r) => ({ value: r.id, label: label(r) }))

export default function MoreReports() {
  const { schoolId, yearId } = useSelection()
  const can = useCan()
  const [report, setReport] = useState(REPORTS[0])
  const [values, setValues] = useState<Record<string, string | boolean | undefined>>({})
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [lookups, setLookups] = useState<{ standards: { id: number; name: string; sections: { id: number; name: string }[] }[]; occupations: { id: number; name: string; parentId: number | null }[]; subjects: { id: number; name: string; kind: string }[]; heads: { id: number; name: string; type: string }[] }>({ standards: [], occupations: [], subjects: [], heads: [] })

  useEffect(() => {
    if (!schoolId) return
    Promise.all([
      api<typeof lookups.standards>(`/standards?schoolId=${schoolId}`), api<typeof lookups.occupations>(`/occupations?schoolId=${schoolId}`),
      api<typeof lookups.subjects>(`/subjects?schoolId=${schoolId}`), api<typeof lookups.heads>(`/fee-heads?schoolId=${schoolId}`),
    ]).then(([standards, occupations, subjects, heads]) => setLookups({ standards, occupations, subjects, heads })).catch((e) => message.error(e.message))
  }, [schoolId])

  function pick(key: string) {
    const r = REPORTS.find((x) => x.key === key)!
    setReport(r)
    setValues(Object.fromEntries(r.fields.filter((f) => f.def).map((f) => [f.key, f.def])))
    setRows(null)
  }
  useEffect(() => pick(REPORTS[0].key), [])

  const sections = useMemo(() => {
    const std = Number(values.standardId)
    return lookups.standards.filter((s) => !std || s.id === std).flatMap((s) => s.sections.map((x) => ({ value: x.id, label: `${s.name} ${x.name}` })))
  }, [lookups.standards, values.standardId])

  const optionsOf = (f: Field): Opt[] => f.options ?? (
    f.kind === 'standard' ? toOpts(lookups.standards, (s) => s.name)
    : f.kind === 'section' ? sections
    : f.kind === 'occupation' ? toOpts(lookups.occupations.filter((o) => !o.parentId), (o) => o.name)
    : f.kind === 'subOccupation' ? toOpts(lookups.occupations.filter((o) => o.parentId && (!values.occupationId || o.parentId === Number(values.occupationId))), (o) => o.name)
    : f.kind === 'subject' ? toOpts(lookups.subjects.filter((s) => !values.kind || s.kind === values.kind), (s) => s.name)
    : f.kind === 'optHead' ? toOpts(lookups.heads.filter((h) => h.type === 'OPTIONAL'), (h) => h.name)
    : [])

  const query = (format?: string) => {
    const qs = new URLSearchParams({ schoolId: String(schoolId), yearId: String(yearId) })
    for (const f of report.fields) {
      const v = values[f.key]
      if (v === undefined || v === '' || v === false) continue
      qs.set(f.key, v === true ? '1' : String(v))
    }
    if (format) qs.set('format', format)
    return `${report.path}?${qs}`
  }
  const missing = report.fields.find((f) => f.required && !values[f.key])

  async function run() {
    if (!schoolId || !yearId) return
    if (missing) return message.warning(`Choose ${missing.label.toLowerCase()}`)
    setLoading(true)
    try {
      setRows(await api<Record<string, unknown>[]>(query()))
    } catch (e) {
      setRows(null)
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const csv = () => (missing ? message.warning(`Choose ${missing.label.toLowerCase()}`) : downloadFile(query('csv'), `${report.key}.csv`).catch((e) => message.error(e.message)))

  const columns = rows?.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : []
  const set = (k: string, v: string | boolean | undefined) => setValues((p) => ({ ...p, [k]: v }))

  return (
    <>
      <style>{'@media print { .no-print { display: none !important } .ant-layout-sider, .ant-layout-header { display: none !important } }'}</style>
      <Card className="no-print" style={{ marginBottom: 16 }}>
        <Space wrap align="end">
          <Select style={{ width: 260 }} value={report.key} onChange={pick} options={REPORTS.filter((r) => r.key !== 'suggest' || can('reports.suggestions')).map((r) => ({ value: r.key, label: r.label }))} />
          {report.fields.map((f) => f.kind === 'text' ? (
            <Input key={f.key} placeholder={f.label} style={{ width: 160 }} value={values[f.key] as string} onChange={(e) => set(f.key, e.target.value)} />
          ) : f.kind === 'date' ? (
            <DatePicker key={f.key} placeholder={f.label} value={values[f.key] ? dayjs(values[f.key] as string) : null}
              onChange={(d) => set(f.key, d?.format('YYYY-MM-DD'))} />
          ) : f.kind === 'switch' ? (
            <Checkbox key={f.key} checked={!!values[f.key]} onChange={(e) => set(f.key, e.target.checked)}>{f.label}</Checkbox>
          ) : (
            <Select key={f.key} allowClear showSearch optionFilterProp="label" placeholder={f.label} style={{ minWidth: 150 }}
              value={values[f.key] as string | undefined} onChange={(v) => set(f.key, v)} options={optionsOf(f)} />
          ))}
          <Button type="primary" loading={loading} onClick={run}>Run</Button>
          <Button onClick={csv}>Download CSV</Button>
          <Button onClick={() => window.print()} disabled={!rows?.length}>Print</Button>
        </Space>
      </Card>
      <h3 style={{ display: rows ? 'block' : 'none' }}>{report.label} {rows && `(${rows.length})`}</h3>
      {rows && !rows.length ? <Empty description="No rows" /> : rows && (
        <Table size="small" rowKey={(_, i) => String(i)} dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 50 }}
          columns={columns.map((c) => {
            const num = isNumeric(c, rows)
            const title = humanize(c)
            return {
              title, dataIndex: c, align: num ? ('right' as const) : ('left' as const), render: num ? money : cell,
              width: Math.max(num ? 90 : 110, title.length * 9 + 32),
              sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => num ? Number(a[c] || 0) - Number(b[c] || 0) : cell(a[c]).localeCompare(cell(b[c])),
            }
          })} />
      )}
    </>
  )
}
