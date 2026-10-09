import { Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api, openPdf } from '../api'
import { Gate } from '../session'
import { useSelection } from '../selection'
import { inr } from '../bill'
import { downloadCsv } from '../csv'
import { modes } from '../receipt'
import { qs, today, useRoster } from '../moneyShared'

type Kind = 'CAUTION_REFUND' | 'ADVANCE_REFUND' | 'EXCESS_REFUND' | 'OTHER'
type Voucher = {
  id: number; voucherNo: number; date: string; kind: Kind; amount: string; mode: string; reference: string | null; remarks: string | null
  enrollmentId: number; cancelledAt: string | null; cancelReason: string | null; student: { admissionNo: string; name: string }; className: string
}
type Dep = { studentId: number; status: string; amount: string; refundAmount: string | null }
type Wd = { excessPaid: string; student: { id: number } }

const kinds = [
  { value: 'CAUTION_REFUND', label: 'Caution refund' }, { value: 'ADVANCE_REFUND', label: 'Advance refund' },
  { value: 'EXCESS_REFUND', label: 'Excess refund' }, { value: 'OTHER', label: 'Other' },
]
const label = (k: Kind) => kinds.find((x) => x.value === k)!.label

// Money paid out to families (refunds). Separate from receipts: never reduces collection totals.
export default function Vouchers() {
  const { schoolId, yearId } = useSelection()
  const { options, enrollmentIdOf } = useRoster()
  const [rows, setRows] = useState<Voucher[]>([])
  const [f, setF] = useState<{ kind?: Kind; from?: string; to?: string }>({})
  const [creating, setCreating] = useState(false)
  const [cancelling, setCancelling] = useState<Voucher | null>(null)
  const [reason, setReason] = useState('')
  const [hint, setHint] = useState('')
  const [form] = Form.useForm()
  const mode = Form.useWatch('mode', form)
  const kind = Form.useWatch('kind', form) as Kind | undefined
  const studentId = Form.useWatch('studentId', form) as number | undefined

  const query = () => qs({ schoolId, yearId, ...f })
  const load = () => (schoolId && yearId ? api<Voucher[]>(`/vouchers?${query()}`).then(setRows).catch((e) => message.error(e.message)) : undefined)
  useEffect(() => {
    load()
  }, [schoolId, yearId, f])

  // What can still be paid out for this student/kind. Advisory: the server re-checks across all years.
  useEffect(() => {
    setHint('')
    if (!creating || !studentId || !kind || !schoolId || !yearId) return
    const issued = (enr?: number) => rows.filter((v) => v.kind === kind && !v.cancelledAt && v.enrollmentId === enr).reduce((s, v) => s + Number(v.amount), 0)
    const show = (ceiling: number, enr?: number) => setHint(`Refundable ${inr(String(ceiling))} · paid out this year ${inr(String(issued(enr)))} · left about ${inr(String(Math.max(0, ceiling - issued(enr))))}`)
    let enr: number | undefined
    try { enr = enrollmentIdOf(studentId) } catch { /* hint only; submit reports it */ }
    if (kind === 'CAUTION_REFUND' || kind === 'ADVANCE_REFUND') {
      api<Dep[]>(`/deposits?${qs({ schoolId, kind: kind === 'CAUTION_REFUND' ? 'CAUTION' : 'ADVANCE' })}`).then((d) => {
        const dep = d.find((x) => x.studentId === studentId)
        if (!dep || !['HELD', 'REFUNDED'].includes(dep.status)) setHint('No refundable deposit on record for this student')
        else show(Number(dep.status === 'REFUNDED' ? dep.refundAmount : dep.amount), enr)
      }).catch(() => undefined)
    } else if (kind === 'EXCESS_REFUND') {
      api<Wd[]>(`/withdrawals?schoolId=${schoolId}&yearId=${yearId}`).then((w) => {
        const x = w.find((r) => r.student.id === studentId)
        if (!x) setHint('Excess refunds need a recorded withdrawal')
        else show(Number(x.excessPaid), enr)
      }).catch(() => undefined)
    }
  }, [creating, studentId, kind, rows])

  async function create(v: Record<string, unknown>) {
    try {
      const { studentId: sid, ...rest } = v as { studentId: number } & Record<string, unknown>
      await api('/vouchers', { method: 'POST', body: JSON.stringify({ ...rest, schoolId, yearId, enrollmentId: enrollmentIdOf(sid), reference: rest.mode === 'CASH' ? undefined : rest.reference }) })
      setCreating(false)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  async function cancel() {
    try {
      await api(`/vouchers/${cancelling!.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })
      setCancelling(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const live = rows.filter((r) => !r.cancelledAt)
  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select allowClear placeholder="Kind" style={{ width: 160 }} options={kinds} onChange={(k) => setF({ ...f, kind: k })} />
        From <Input type="date" onChange={(e) => setF({ ...f, from: e.target.value })} />
        To <Input type="date" onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Gate cap="vouchers.create"><Button type="primary" onClick={() => { form.resetFields(); form.setFieldsValue({ mode: 'CASH', date: today() }); setCreating(true) }}>New voucher</Button></Gate>
        <Button onClick={() => openPdf(`/vouchers?${query()}&pdf=1`).catch((e) => message.error(e.message))}>Register PDF</Button>
        <Button onClick={() => downloadCsv('vouchers', ['No', 'Date', 'Adm no', 'Student', 'Class', 'Kind', 'Mode', 'Amount', 'Cancelled'],
          rows.map((r) => [r.voucherNo, r.date.slice(0, 10), r.student.admissionNo, r.student.name, r.className, r.kind, r.mode, r.amount, r.cancelledAt ? 'yes' : '']))}>CSV</Button>
        <span>{live.length} vouchers · paid out <b>{inr(String(live.reduce((s, r) => s + Number(r.amount), 0)))}</b></span>
      </Space>
      <Table rowKey="id" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'No.', dataIndex: 'voucherNo' },
        { title: 'Date', dataIndex: 'date', render: (v: string) => v.slice(0, 10) },
        { title: 'Student', render: (_, r) => `${r.student.name} (${r.student.admissionNo})` },
        { title: 'Class', dataIndex: 'className' },
        { title: 'Kind', dataIndex: 'kind', render: label },
        { title: 'Mode', render: (_, r) => (r.reference ? `${r.mode} · ${r.reference}` : r.mode) },
        { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr },
        { title: 'Status', render: (_, r) => (r.cancelledAt ? <Tag color="red" title={r.cancelReason ?? ''}>Cancelled</Tag> : <Tag color="green">Paid</Tag>) },
        {
          title: '', render: (_, r) => (
            <Space>
              <Button size="small" onClick={() => openPdf(`/vouchers/${r.id}/pdf`).catch((e) => message.error(e.message))}>PDF</Button>
              {/* ponytail: shown to all; the API allows only ADMIN and returns 403 otherwise. */}
              {!r.cancelledAt && <Gate cap="vouchers.cancel" hide><Button size="small" danger onClick={() => { setReason(''); setCancelling(r) }}>Cancel</Button></Gate>}
            </Space>
          ),
        },
      ]} />

      <Modal title="New voucher" open={creating} onCancel={() => setCreating(false)} onOk={() => form.submit()} okText="Issue">
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="studentId" label="Student" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={options} placeholder="Search student" />
          </Form.Item>
          <Form.Item name="kind" label="Kind" rules={[{ required: true }]}><Select options={kinds} /></Form.Item>
          {hint && <div style={{ color: '#888', marginBottom: 12 }}>{hint}</div>}
          <Space wrap>
            <Form.Item name="amount" label="Amount" rules={[{ required: true }]}><InputNumber min={0.01} precision={2} prefix="₹" style={{ width: 160 }} /></Form.Item>
            <Form.Item name="date" label="Date" rules={[{ required: true }]}><Input type="date" max={today()} /></Form.Item>
            <Form.Item name="mode" label="Paid by"><Select options={modes} style={{ width: 150 }} /></Form.Item>
          </Space>
          {mode && mode !== 'CASH' && (
            <Form.Item name="reference" label="Reference" rules={[{ required: true, min: 3, message: 'At least 3 characters' }]} preserve={false}><Input /></Form.Item>
          )}
          <Form.Item name="remarks" label={kind === 'OTHER' ? 'Remarks (required for Other)' : 'Remarks'} rules={[{ required: kind === 'OTHER' }]}><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal title={cancelling && `Cancel voucher #${cancelling.voucherNo}`} open={!!cancelling} onCancel={() => setCancelling(null)}
        onOk={cancel} okText="Cancel voucher" okButtonProps={{ danger: true, disabled: reason.trim().length < 3 }} cancelText="Back">
        <Input.TextArea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </>
  )
}
