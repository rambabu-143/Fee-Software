import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Gate } from '../session'
import { useSelection } from '../selection'
import { inr } from '../bill'
import { downloadCsv } from '../csv'

type Row = {
  enrollmentId: number; admissionNo: string; name: string; className: string; fromYear: string; amount: string; waivedAmount: string
  waiveReason: string | null; source: string; net: string; paid: string; due: string; credit: string
}
type Outcome = 'CARRIED' | 'SKIPPED_EXISTING' | 'SKIPPED_WITHDRAWN' | 'SKIPPED_NOT_ENROLLED_NEXT_YEAR' | 'SKIPPED_ZERO'
type OutcomeRow = { studentId: number; admissionNo: string; name: string; className: string; outcome: Outcome; amount: string | null }
type CarryResult = {
  dryRun: boolean; carried: number; credits: number; zero: number; skippedWithdrawn: number; skippedNotEnrolled: number; skippedExisting: number
  leftBehindDue: string; rows: OutcomeRow[]
}
type LeftBehind = { studentId: number; admissionNo: string; name: string; className: string; due: string }
const OUTCOME: Record<Outcome, [string, string]> = {
  CARRIED: ['green', 'Carried'], SKIPPED_EXISTING: ['default', 'Already carried'], SKIPPED_WITHDRAWN: ['default', 'Withdrawn'],
  SKIPPED_NOT_ENROLLED_NEXT_YEAR: ['red', 'Not enrolled this year — NOT carried'], SKIPPED_ZERO: ['default', 'Nothing owed'],
}

// Previous year's closing balance carried into the selected year's bill.
export default function Arrears() {
  const { schoolId, yearId, years } = useSelection()
  const [rows, setRows] = useState<Row[]>([])
  const [fromYearId, setFromYearId] = useState<number>()
  const [result, setResult] = useState<CarryResult | null>(null)
  const [carrying, setCarrying] = useState(false)
  const [left, setLeft] = useState<LeftBehind[]>([])
  const [previewed, setPreviewed] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form] = Form.useForm()

  const load = () =>
    schoolId && yearId ? api<Row[]>(`/arrears?schoolId=${schoolId}&yearId=${yearId}`).then(setRows).catch((e) => message.error(e.message)) : undefined
  useEffect(() => {
    load()
    setResult(null)
  }, [schoolId, yearId])
  useEffect(() => {
    setPreviewed(false)
    setResult(null)
  }, [fromYearId])

  // Students enrolled last year, owing money, but not enrolled in the selected year: their balance is NOT carried.
  const loadLeft = () =>
    schoolId && yearId && fromYearId
      ? api<LeftBehind[]>(`/arrears/unpromoted?schoolId=${schoolId}&fromYearId=${fromYearId}&toYearId=${yearId}`).then(setLeft).catch(() => setLeft([]))
      : setLeft([])
  useEffect(() => {
    loadLeft()
  }, [schoolId, yearId, fromYearId])

  // Default "from" = the latest year that starts before the selected one.
  useEffect(() => {
    const cur = years.find((y) => y.id === yearId)
    const prev = years.filter((y) => cur && y.startDate < cur.startDate).sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
    setFromYearId(prev?.id)
  }, [years, yearId])

  async function carry(dryRun: boolean) {
    setCarrying(true)
    try {
      setResult(await api<CarryResult>('/arrears/carry', { method: 'POST', body: JSON.stringify({ schoolId, fromYearId, toYearId: yearId, dryRun }) }))
      if (dryRun) setPreviewed(true)
      else {
        setPreviewed(false)
        await load()
        await loadLeft()
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCarrying(false)
    }
  }

  function open(r: Row) {
    setEditing(r)
    form.setFieldsValue({ amount: Number(r.amount), waivedAmount: Number(r.waivedAmount), reason: undefined })
  }

  async function save(v: { amount?: number; waivedAmount?: number; reason: string }) {
    try {
      await api(`/arrears/${editing!.enrollmentId}`, { method: 'PATCH', body: JSON.stringify(v) })
      setEditing(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const total = rows.reduce((s, r) => s + Number(r.due), 0)
  const yearName = years.find((y) => y.id === yearId)?.label
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card size="small" title={`Carry forward into ${yearName ?? '…'}`}>
        <Space wrap>
          From year
          <Select style={{ width: 140 }} value={fromYearId} onChange={setFromYearId} placeholder="Year"
            options={years.filter((y) => y.id !== yearId).map((y) => ({ value: y.id, label: y.label }))} />
          <Gate cap="arrears.carry"><Button loading={carrying} disabled={!fromYearId || !yearId} onClick={() => carry(true)}>Preview</Button></Gate>
          <Gate cap="arrears.carry"><Button type="primary" loading={carrying} disabled={!previewed} onClick={() => carry(false)}>Carry forward</Button></Gate>
          <span style={{ color: '#888' }}>Preview first, nothing is saved. Safe to repeat: students who already have an arrear row are left alone.</span>
        </Space>
        {result && (
          <>
            <Alert style={{ marginTop: 12 }} type={result.skippedNotEnrolled ? 'warning' : 'success'} showIcon
              message={`${result.dryRun ? 'Preview: ' : ''}${result.carried} carried, ${result.credits} credits, ${result.zero} nil`}
              description={`Skipped: ${result.skippedExisting} already carried · ${result.skippedWithdrawn} withdrawn · ${result.skippedNotEnrolled} not enrolled this year (${inr(result.leftBehindDue)} NOT carried)`} />
            <Table style={{ marginTop: 12 }} size="small" rowKey="studentId" dataSource={result.rows} pagination={{ pageSize: 10 }} scroll={{ x: true }}
              onRow={(r) => ({ style: r.outcome === 'SKIPPED_NOT_ENROLLED_NEXT_YEAR' ? { background: '#fff1f0' } : undefined })} columns={[
                { title: 'Adm. no.', dataIndex: 'admissionNo' },
                { title: 'Student', dataIndex: 'name' },
                { title: 'Class', dataIndex: 'className' },
                { title: 'Outcome', dataIndex: 'outcome', render: (v: Outcome) => <Tag color={OUTCOME[v][0]}>{OUTCOME[v][1]}</Tag> },
                { title: 'Amount', dataIndex: 'amount', align: 'right', render: (v: string | null) => (v === null ? '' : inr(v)) },
              ]} />
          </>
        )}
      </Card>

      {left.length > 0 && (
        <Card size="small" style={{ borderColor: '#ff4d4f' }} title={`Not enrolled in ${yearName ?? 'this year'}: ${left.length} students, ${inr(String(left.reduce((n, r) => n + Number(r.due), 0)))} not carried`}
          extra={<Button size="small" onClick={() => downloadCsv('not-carried', ['Adm no', 'Name', 'Class', 'Closing balance'], left.map((r) => [r.admissionNo, r.name, r.className, r.due]))}>CSV</Button>}>
          <div style={{ color: '#888', marginBottom: 8 }}>Enrol them in {yearName} (or record a withdrawal), then run Carry forward again to pick them up.</div>
          <Table size="small" rowKey="studentId" dataSource={left} pagination={{ pageSize: 10 }} scroll={{ x: true }} columns={[
            { title: 'Adm. no.', dataIndex: 'admissionNo' },
            { title: 'Student', dataIndex: 'name' },
            { title: 'Class', dataIndex: 'className' },
            { title: 'Closing balance', dataIndex: 'due', align: 'right', render: (v: string) => <b style={{ color: '#cf1322' }}>{inr(v)}</b> },
          ]} />
        </Card>
      )}

      <Space wrap>
        <span>{rows.length} students · outstanding arrear <b>{inr(String(total))}</b></span>
        <Button onClick={() => downloadCsv('arrears', ['Adm no', 'Name', 'Class', 'From', 'Arrear', 'Waived', 'Net', 'Paid', 'Due', 'Source'],
          rows.map((r) => [r.admissionNo, r.name, r.className, r.fromYear, r.amount, r.waivedAmount, r.net, r.paid, r.due, r.source]))}>CSV</Button>
      </Space>
      <Table rowKey="enrollmentId" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'Adm. no.', dataIndex: 'admissionNo' },
        { title: 'Student', dataIndex: 'name' },
        { title: 'Class', dataIndex: 'className' },
        { title: 'From', dataIndex: 'fromYear' },
        { title: 'Arrear', dataIndex: 'amount', align: 'right', render: (v: string) => (Number(v) < 0 ? <Tag color="green">Credit {inr(String(-Number(v)))}</Tag> : inr(v)) },
        { title: 'Waived', dataIndex: 'waivedAmount', align: 'right', render: inr },
        { title: 'Net', dataIndex: 'net', align: 'right', render: inr },
        { title: 'Paid', dataIndex: 'paid', align: 'right', render: inr },
        { title: 'Due', dataIndex: 'due', align: 'right', render: (v: string) => <b>{inr(v)}</b> },
        { title: 'Source', dataIndex: 'source', render: (v: string) => <Tag>{v}</Tag> },
        // ponytail: shown to all; the API allows only ADMIN and returns 403 otherwise.
        { title: '', render: (_, r) => <Gate cap="arrears.carry" hide><Button size="small" onClick={() => open(r)}>Edit / waive</Button></Gate> },
      ]} />

      <Modal title={editing && `Arrear · ${editing.name} (${editing.admissionNo})`} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} okText="Save">
        {editing && <Descriptions size="small" column={1} style={{ marginBottom: 12 }} items={[
          { label: 'From', children: editing.fromYear }, { label: 'Already paid against it', children: inr(editing.paid) },
          ...(editing.waiveReason ? [{ label: 'Last reason', children: editing.waiveReason }] : []),
        ]} />}
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="amount" label="Arrear amount (negative = credit to the family)">
            <InputNumber precision={2} prefix="₹" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="waivedAmount" label="Waived (only a positive arrear can be waived)">
            <InputNumber min={0} precision={2} prefix="₹" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3, message: 'At least 3 characters' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
