import { Alert, Button, Input, Select, Space, Table, Tag, Typography, message } from 'antd'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import { downloadCsv, parseCsv } from '../csv'

// Fields the API accepts. `req` ones must be mapped before a dry run is allowed.
const FIELDS = [
  { key: 'admissionNo', req: true }, { key: 'name', req: true }, { key: 'standard', req: true }, { key: 'section', req: true },
  { key: 'rollNo' }, { key: 'dob' }, { key: 'phone' }, { key: 'email' }, { key: 'fatherName' }, { key: 'motherName' }, { key: 'isNewAdmission' },
]
const MAX_ROWS = 2000
type Plan = { ok: boolean; errors: { row: number; msg: string }[]; rows?: number; willCreate?: number; willUpdate?: number; dryRun: boolean }

export default function Import() {
  const { schoolId, yearId } = useSelection()
  const [text, setText] = useState('')
  const [map, setMap] = useState<Record<string, string | undefined>>({})
  const [plan, setPlan] = useState<Plan | null>(null)
  const [cleanKey, setCleanKey] = useState('') // what the last clean dry run was for
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Plan | null>(null)

  const table = useMemo(() => parseCsv(text), [text])
  const header = table[0]?.map((h) => h.trim()) ?? []
  const data = table.slice(1)

  // Rows as the API wants them, built from the column mapping.
  const rows = useMemo(
    () => data.map((r) => Object.fromEntries(FIELDS.flatMap((f) => {
      const i = map[f.key] ? header.indexOf(map[f.key]!) : -1
      return i >= 0 && r[i]?.trim() ? [[f.key, r[i].trim()]] : []
    }))),
    [text, map],
  )
  const key = JSON.stringify([schoolId, yearId, rows])
  const missing = FIELDS.filter((f) => f.req && !map[f.key]).map((f) => f.key)

  function onText(t: string) {
    setText(t)
    setPlan(null)
    setDone(null)
    setCleanKey('')
    const h = parseCsv(t)[0]?.map((x) => x.trim()) ?? []
    // auto-map by case-insensitive, space-free header name
    setMap(Object.fromEntries(FIELDS.map((f) => [f.key, h.find((x) => x.toLowerCase().replace(/[\s_]/g, '') === f.key.toLowerCase())])))
  }
  async function pick(file?: File) {
    if (file) onText(await file.text())
  }

  async function run(dry: boolean) {
    if (rows.length > MAX_ROWS) return message.error(`At most ${MAX_ROWS} rows per import`)
    setBusy(true)
    try {
      const r = await api<Plan>(`/import/students?dryRun=${dry}`, { method: 'POST', body: JSON.stringify({ schoolId, yearId, rows }) })
      if (dry) {
        setPlan(r)
        setCleanKey(r.ok ? key : '')
        setDone(null)
      } else {
        setDone(r)
        setPlan(null)
        setCleanKey('')
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canImport = !!plan?.ok && cleanKey === key && !busy

  return (
    <>
      <Typography.Paragraph type="secondary">
        Students are matched by admission number: existing ones are updated, new ones created, and enrolled in the selected school and year.
        The real import is all-or-nothing and safe to repeat. Max {MAX_ROWS} rows.
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        <Button onClick={() => downloadCsv('students-import-template', FIELDS.map((f) => f.key), [['A-1001', 'Asha Rao', 'Class 1', 'A', '1', '2018-05-21', '9876543210', 'asha@example.com', 'R. Rao', 'S. Rao', 'yes']])}>
          Download template
        </Button>
      </Space>
      <Input.TextArea rows={5} placeholder="...or paste CSV here (first row = headers)" value={text} onChange={(e) => onText(e.target.value)} style={{ marginBottom: 16 }} />

      {header.length > 0 && (
        <>
          <h4>Map columns ({data.length} data rows)</h4>
          <Space wrap style={{ marginBottom: 12 }}>
            {FIELDS.map((f) => (
              <span key={f.key}>
                {f.key}{f.req && ' *'}{' '}
                <Select allowClear size="small" style={{ width: 150 }} value={map[f.key]} placeholder="(skip)"
                  onChange={(v) => (setMap({ ...map, [f.key]: v }), setPlan(null))}
                  options={header.map((h) => ({ value: h, label: h }))} />
              </span>
            ))}
          </Space>
          <Table size="small" pagination={false} scroll={{ x: true }} style={{ marginBottom: 16 }} dataSource={rows.slice(0, 10).map((r, i) => ({ ...r, _n: i + 1 }))} rowKey="_n"
            columns={[{ title: '#', dataIndex: '_n' }, ...FIELDS.map((f) => ({ title: f.key, dataIndex: f.key }))]} />
          <Space style={{ marginBottom: 16 }}>
            <Button type="primary" disabled={!!missing.length || !rows.length || !schoolId || !yearId} loading={busy} onClick={() => run(true)}>Dry run</Button>
            <Button danger type="primary" disabled={!canImport} onClick={() => run(false)}>Import {rows.length} rows</Button>
            {missing.length > 0 && <Tag color="orange">Map required: {missing.join(', ')}</Tag>}
            {plan?.ok && cleanKey !== key && <Tag color="orange">Data changed since the dry run: run it again</Tag>}
          </Space>
        </>
      )}

      {plan && (plan.ok
        ? <Alert type="success" showIcon message={`Dry run clean: ${plan.rows} rows, ${plan.willCreate} to create, ${plan.willUpdate} to update. Nothing saved yet.`} />
        : <>
            <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`${plan.errors.length} problem(s). Fix the file and dry run again; nothing was saved.`} />
            <Table rowKey={(e) => `${e.row}${e.msg}`} size="small" dataSource={plan.errors} pagination={{ pageSize: 20 }} columns={[
              { title: 'Row', dataIndex: 'row', width: 80 }, { title: 'Problem', dataIndex: 'msg' },
            ]} />
          </>)}
      {done && <Alert type="success" showIcon message={`Imported: ${done.willCreate} created, ${done.willUpdate} updated (${done.rows} rows).`} />}
    </>
  )
}
