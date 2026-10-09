import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Gate } from '../session'
import { useSelection } from '../selection'
import { inr } from '../bill'
import { downloadCsv } from '../csv'
import { modes } from '../receipt'
import { apiRaw, parseCsv, qs, today, useRoster } from '../moneyShared'

type Kind = 'ADVANCE' | 'CAUTION' | 'TRANSPORT'
type Status = 'HELD' | 'REFUNDED' | 'ADJUSTED' | 'FORFEITED'
type Dep = {
  id: number; studentId: number; admissionNo: string; name: string; kind: Kind; amount: string; receivedYear: string; status: Status
  refundedAt: string | null; refundAmount: string | null; deduction: string | null; refundMode: string | null; refundRef: string | null; remarks: string | null
}
type Cmp = { year: string; kind: Kind; status: Status; count: number; amount: string }

const kinds = (['ADVANCE', 'CAUTION', 'TRANSPORT'] as const).map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase() }))
const statuses = (['HELD', 'REFUNDED', 'ADJUSTED', 'FORFEITED'] as const).map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase() }))
const tone: Record<Status, string> = { HELD: 'blue', REFUNDED: 'green', ADJUSTED: 'default', FORFEITED: 'orange' }
const cents = (n: number | undefined) => Math.round((n ?? 0) * 100)

// Refundable deposits (advance, caution, transport security) held per student across years.
function List() {
  const { schoolId, yearId, years } = useSelection()
  const { options } = useRoster()
  const [rows, setRows] = useState<Dep[]>([])
  const [f, setF] = useState<{ kind?: Kind; status?: Status; year?: number }>({})
  const [adding, setAdding] = useState(false)
  const [refunding, setRefunding] = useState<Dep | null>(null)
  const [importMsg, setImportMsg] = useState<{ type: 'success' | 'error'; text: string; errors?: { row: number; msg: string }[] } | null>(null)
  const [add] = Form.useForm()
  const [refund] = Form.useForm()
  const rmode = Form.useWatch('mode', refund)
  const file = useRef<HTMLInputElement>(null)

  const load = () =>
    schoolId ? api<Dep[]>(`/deposits?${qs({ schoolId, yearId: f.year, kind: f.kind, status: f.status })}`).then(setRows).catch((e) => message.error(e.message)) : undefined
  useEffect(() => {
    load()
  }, [schoolId, f])

  async function create(v: Record<string, unknown>) {
    try {
      await api('/deposits', { method: 'POST', body: JSON.stringify(v) })
      setAdding(false)
      add.resetFields()
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  async function doRefund(v: { refundAmount: number; deduction?: number; mode: string; reference?: string; date: string; remarks?: string }) {
    if (cents(v.refundAmount) + cents(v.deduction) !== cents(Number(refunding!.amount))) return message.error(`Refund + deduction must equal ₹${refunding!.amount}`)
    try {
      await api(`/deposits/${refunding!.id}/refund`, { method: 'POST', body: JSON.stringify({ ...v, deduction: v.deduction ?? 0, reference: v.mode === 'CASH' ? undefined : v.reference }) })
      setRefunding(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // CSV columns: admissionNo,kind,amount,year[,status]; header row optional.
  async function importCsv(file: File) {
    const cells = parseCsv(await file.text())
    const body = cells.filter((r) => !/^admission/i.test(r[0])).map((r) => ({
      admissionNo: r[0]?.trim(), kind: r[1]?.trim().toUpperCase(), amount: Number(r[2]), year: r[3]?.trim(), ...(r[4]?.trim() ? { status: r[4].trim().toUpperCase() } : {}),
    }))
    const res = await apiRaw('/deposits/import', { method: 'POST', body: JSON.stringify({ schoolId, rows: body }) })
    if (res.ok) {
      setImportMsg({ type: 'success', text: `Imported ${res.body.imported} deposits` })
      await load()
    } else {
      const m = res.body?.message
      setImportMsg({ type: 'error', text: Array.isArray(m) ? m.join('; ') : (m ?? 'Import failed'), errors: res.body?.errors })
    }
  }

  const held = rows.filter((r) => r.status === 'HELD').reduce((s, r) => s + Number(r.amount), 0)
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Select allowClear placeholder="Kind" style={{ width: 130 }} options={kinds} onChange={(kind) => setF({ ...f, kind })} />
        <Select allowClear placeholder="Status" style={{ width: 130 }} options={statuses} onChange={(status) => setF({ ...f, status })} />
        <Select allowClear placeholder="Received in (all years)" style={{ width: 190 }} options={years.map((y) => ({ value: y.id, label: y.label }))} onChange={(year) => setF({ ...f, year })} />
        <Gate cap="deposits.write"><Button type="primary" onClick={() => { add.setFieldsValue({ receivedYearId: yearId }); setAdding(true) }}>Add deposit</Button></Gate>
        <Gate cap="deposits.admin"><Button onClick={() => file.current?.click()}>Import CSV</Button></Gate>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ''; if (x) importCsv(x).catch((err) => message.error(err.message)) }} />
        <Button onClick={() => downloadCsv('deposits', ['Adm no', 'Name', 'Kind', 'Amount', 'Received', 'Status', 'Refunded', 'Deduction'],
          rows.map((r) => [r.admissionNo, r.name, r.kind, r.amount, r.receivedYear, r.status, r.refundAmount ?? '', r.deduction ?? '']))}>Export</Button>
        <span>{rows.length} deposits · held <b>{inr(String(held))}</b></span>
      </Space>
      <span style={{ color: '#888' }}>Import columns: admissionNo, kind (ADVANCE/CAUTION/TRANSPORT), amount, year (e.g. 2026-27), optional status (HELD/REFUNDED). All rows or none.</span>
      {importMsg && (
        <Alert closable onClose={() => setImportMsg(null)} type={importMsg.type} showIcon message={importMsg.text}
          description={importMsg.errors && <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>{importMsg.errors.map((e, i) => <li key={i}>Row {e.row}: {e.msg}</li>)}</ul>} />
      )}

      <Table rowKey="id" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'Adm. no.', dataIndex: 'admissionNo' },
        { title: 'Student', dataIndex: 'name' },
        { title: 'Kind', dataIndex: 'kind' },
        { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr },
        { title: 'Received', dataIndex: 'receivedYear' },
        { title: 'Status', dataIndex: 'status', render: (v: Status) => <Tag color={tone[v]}>{v}</Tag> },
        { title: 'Refund', render: (_, r) => (r.status === 'HELD' ? '' : `${inr(r.refundAmount ?? '0')}${Number(r.deduction) ? ` (−${inr(r.deduction!)})` : ''} · ${r.refundedAt?.slice(0, 10) ?? ''}`) },
        // ponytail: shown to all; the API allows only ADMIN and returns 403 otherwise.
        { title: '', render: (_, r) => r.status === 'HELD' && <Gate cap="deposits.admin" hide><Button size="small" onClick={() => { refund.setFieldsValue({ refundAmount: Number(r.amount), deduction: 0, mode: 'CASH', date: today(), reference: undefined, remarks: undefined }); setRefunding(r) }}>Refund</Button></Gate> },
      ]} />

      <Modal title="Add deposit" open={adding} onCancel={() => setAdding(false)} onOk={() => add.submit()}>
        <Form form={add} layout="vertical" onFinish={create}>
          <Form.Item name="studentId" label="Student" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={options} placeholder="Search student" />
          </Form.Item>
          <Form.Item name="kind" label="Kind" rules={[{ required: true }]}><Select options={kinds} /></Form.Item>
          <Form.Item name="amount" label="Amount" rules={[{ required: true }]}><InputNumber min={0.01} precision={2} prefix="₹" style={{ width: 180 }} /></Form.Item>
          <Form.Item name="receivedYearId" label="Received in year" rules={[{ required: true }]}>
            <Select options={years.map((y) => ({ value: y.id, label: y.label }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={refunding && `Refund ${refunding.kind.toLowerCase()} · ${refunding.name}`} open={!!refunding} onCancel={() => setRefunding(null)} onOk={() => refund.submit()} okText="Refund">
        {refunding && <Descriptions size="small" column={1} style={{ marginBottom: 12 }} items={[{ label: 'Deposit', children: <b>{inr(refunding.amount)}</b> }, { label: 'Received', children: refunding.receivedYear }]} />}
        <Form form={refund} layout="vertical" onFinish={doRefund}>
          <Space wrap>
            <Form.Item name="refundAmount" label="Refund" rules={[{ required: true }]}><InputNumber min={0} precision={2} prefix="₹" style={{ width: 160 }} /></Form.Item>
            <Form.Item name="deduction" label="Deduction"><InputNumber min={0} precision={2} prefix="₹" style={{ width: 160 }} /></Form.Item>
          </Space>
          <div style={{ color: '#888', marginBottom: 12 }}>Refund + deduction must equal the deposit. Refund 0 = forfeited.</div>
          <Space wrap>
            <Form.Item name="mode" label="Paid by"><Select options={modes} style={{ width: 150 }} /></Form.Item>
            <Form.Item name="date" label="Date" rules={[{ required: true }]}><Input type="date" max={today()} /></Form.Item>
          </Space>
          {rmode && rmode !== 'CASH' && (
            <Form.Item name="reference" label="Reference" rules={[{ required: true, min: 3, message: 'At least 3 characters' }]} preserve={false}><Input /></Form.Item>
          )}
          <Form.Item name="remarks" label="Remarks"><Input /></Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}

// Held / refunded totals per kind and the year each deposit was received.
function Compare() {
  const { schoolId, years } = useSelection()
  const [sel, setSel] = useState<number[]>([])
  const [rows, setRows] = useState<Cmp[]>([])
  useEffect(() => {
    if (schoolId) api<Cmp[]>(`/deposits/report/compare?${qs({ schoolId, yearIds: sel.join(',') })}`).then(setRows).catch((e) => message.error(e.message))
  }, [schoolId, sel])
  return (
    <Card size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Select mode="multiple" allowClear placeholder="All years" style={{ minWidth: 260 }} value={sel} onChange={setSel} options={years.map((y) => ({ value: y.id, label: y.label }))} />
          <Button onClick={() => downloadCsv('deposits-compare', ['Year', 'Kind', 'Status', 'Count', 'Amount'], rows.map((r) => [r.year, r.kind, r.status, r.count, r.amount]))}>CSV</Button>
        </Space>
        <Table rowKey={(r) => `${r.year}-${r.kind}-${r.status}`} dataSource={rows} pagination={false} size="small" columns={[
          { title: 'Year received', dataIndex: 'year' }, { title: 'Kind', dataIndex: 'kind' },
          { title: 'Status', dataIndex: 'status', render: (v: Status) => <Tag color={tone[v]}>{v}</Tag> },
          { title: 'Count', dataIndex: 'count', align: 'right' }, { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr },
        ]} />
      </Space>
    </Card>
  )
}

export default function Deposits() {
  return <Tabs items={[{ key: 'l', label: 'Deposits', children: <List /> }, { key: 'c', label: 'Compare years', children: <Compare /> }]} />
}
